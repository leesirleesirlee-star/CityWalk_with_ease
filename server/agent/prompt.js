/**
 * 提示词构造：把用户原话 + 系统解析出的意图 + 候选 POI 表拼成 DeepSeek messages。
 *
 * 约束：
 *   - 候选只能来自 catalog（有坐标的城市包 POI）；
 *   - 预算由系统给定，模型不得修改；
 *   - 输出仅 JSON，不编造史实；
 *   - why 15–40 字，3–6 站，同类别最多 2 站。
 */

const PACES = Object.freeze(['relaxed', 'balanced', 'packed']);

export const SYSTEM_PROMPT = [
  '你是成都城市漫游规划师，熟悉成都市区步行可达的景点、街区、公园与夜市。',
  '你的任务是：根据用户原话与系统给定的预算/开始时间/节奏，从候选景点表中挑选 3–6 站，并给出站与站之间的串联理由。',
  '硬性规则：',
  '1. 只能从候选表中选择，poi_id 必须来自候选表，禁止编造候选表之外的景点。',
  '2. 总站数 3–6 站；如果用户明确要求“至少 N 站”，必须满足 N 站；同一类别（category）最多 2 站。',
  '3. 尊重用户约束：预算分钟数、少走路（low_walk）、夜景（evening）、亲子（family）、安静（quiet）、雨天（rain）、不爬山（no_hike）。',
  '4. 预算由系统给定，你不得修改、不得忽略；请在预算内安排停留与顺序。',
  '5. 不要编造历史、年代、人物、票价等史实；只描述类别、氛围与感受。',
  '6. stops[].intro 是给游客看的“一句话介绍”，30–80 字，只能基于候选表 summary/tags 里的事实，不得添加未给出的年代、人物、票价。',
  '7. constraints 只填 low_walk / evening / family / quiet / rain / no_hike 六个代码；预算、开始时间、“至少 N 站”由系统给定，不要写进 constraints 或 interests。',
  '8. 只输出一个 JSON 对象，不要 Markdown 代码块、不要解释文字、不要额外字段。',
  '输出 JSON 结构：',
  '{"interests":["用户兴趣标签"],"constraints":["约束代码"],"pace":"relaxed|balanced|packed",',
  ' "stops":[{"poi_id":"候选 id","why":"15-40字中文理由","intro":"30-80字一句话介绍","stay_min":30}],',
  ' "route_reason":"整条路线为什么这样串联（1-2句）"}',
].join('\n');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function joinOr(value, fallback) {
  const list = asArray(value).map((item) => String(item).trim()).filter(Boolean);
  return list.length ? list.join('、') : fallback;
}

function formatTags(tags) {
  const list = asArray(tags).map((tag) => String(tag).trim()).filter(Boolean);
  return list.length ? list.join('/') : '-';
}

function formatOpen(open) {
  if (open === null || open === undefined || open === '') return '未知';
  if (typeof open === 'string') return open.slice(0, 40);
  if (typeof open === 'boolean') return open ? '开放' : '关闭';
  return String(open).slice(0, 40);
}

function formatNumber(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number * 10 ** digits) / 10 ** digits) : '-';
}

function formatSummary(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '-';
}

function catalogRow(poi) {
  const lat = formatNumber(poi?.lat, 5);
  const lng = formatNumber(poi?.lng, 5);
  const stay = Number.isFinite(Number(poi?.stay_min)) ? String(Math.round(Number(poi.stay_min))) : '-';
  const rating = Number.isFinite(Number(poi?.rating)) ? formatNumber(poi.rating, 1) : '-';
  return [
    String(poi?.id ?? poi?.poi_id ?? ''),
    String(poi?.name ?? ''),
    String(poi?.category ?? ''),
    formatTags(poi?.tags),
    `${lat},${lng}`,
    stay,
    rating,
    formatOpen(poi?.open),
    formatSummary(poi?.summary),
  ].join(' | ');
}

/**
 * @param {{ text?: string, intent?: object, catalog?: Array<object> }} input
 * @returns {Array<{ role: 'system'|'user', content: string }>}
 */
export const SYSTEM_PROMPT_EN_SUFFIX = [
  '',
  'Language: answer in English. Write why / intro / route_reason in natural English.',
  'Place names from the catalog may be kept in Chinese with an English name in parentheses, e.g. "Wangjiang Pavilion (望江楼公园)".',
  'Keep every poi_id exactly as given in the catalog.',
].join('\n');

export function buildMessages({ text = '', intent = {}, catalog = [], lang = 'zh' } = {}) {
  const budgetMin = Number.isFinite(Number(intent?.budget_min)) && Number(intent.budget_min) > 0
    ? Math.round(Number(intent.budget_min))
    : 180;
  const startTime = typeof intent?.start_time === 'string' && intent.start_time ? intent.start_time : '09:00';
  const pace = PACES.includes(intent?.pace) ? intent.pace : 'balanced';
  const interests = joinOr(intent?.interests, '（未指定，按城市经典均衡路线）');
  const constraints = joinOr(intent?.constraints, '无');
  const minStops = Number.isFinite(Number(intent?.min_stops)) && Number(intent.min_stops) >= 2
    ? Math.min(8, Math.round(Number(intent.min_stops)))
    : null;
  const rawText = String(text ?? '').trim() || '（空输入，按成都经典半日路线规划）';
  const list = asArray(catalog).filter((poi) => poi && (poi.id || poi.poi_id));

  const lines = [
    `用户原话：${rawText.slice(0, 500)}`,
    '',
    `系统给定（不得修改）：预算 ${budgetMin} 分钟；开始时间 ${startTime}；节奏 ${pace}；兴趣 ${interests}；约束 ${constraints}。`,
    minStops ? `用户硬性要求：至少 ${minStops} 站。必须排满 ${minStops} 站；请把单站停留压到 25–40 分钟、优先近距离串联来适配 ${budgetMin} 分钟，不得因为预算少选。` : '',
    '',
    '候选表（只能从这些 id 中选，格式：id | name | category | tags | lat,lng | stay_min | rating | open | summary）：',
    'id | name | category | tags | lat,lng | stay_min | rating | open | summary',
    ...list.map(catalogRow),
    '',
    `请挑选 ${minStops ? `至少 ${minStops}` : '3–6'} 站（同类别最多 2 站），在 ${budgetMin} 分钟预算内安排顺序，输出符合上述结构的 JSON：`,
    `{"interests":[...],"constraints":[...],"pace":"${pace}","stops":[{"poi_id":"...","why":"15-40字中文理由","intro":"30-80字一句话介绍","stay_min":30}],"route_reason":"..."}`,
    '注意：只输出 JSON 对象本身，不要输出 ```json 代码块。',
  ];

  const english = lang === 'en';
  return [
    { role: 'system', content: english ? `${SYSTEM_PROMPT}\n${SYSTEM_PROMPT_EN_SUFFIX}` : SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

export default buildMessages;
