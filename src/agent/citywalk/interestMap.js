/**
 * T4.4 STEP2 · 兴趣词映射（口语 → category 权重）
 *
 * 只做「文本 → preferences」的翻译，不选点、不打分、不动预算。
 * 输出直接交给 planner.normalizePreferences，仍走 T4.4 STEP1 的权重层。
 *
 * 词表依据 knowledge/attractions/chengdu/*.json 的 summary 实写内容：
 *   熊猫基地「竹林、啃竹子」→ 自然保护地
 *   九眼桥「江水、灯光、啤酒、烤串」→ 河岸夜景
 *   锦里「辣油、桂花糖、灯笼」→ 民俗夜市
 *   武侯祠「红墙、三国」→ 历史祠庙
 *   宽窄巷子「青砖墙、盖碗」→ 历史街区
 *   人民公园「热水瓶、麻将、树影」→ 城市公园
 *   望江楼「竹叶、江面船笛」→ 古典园林
 *   东郊记忆「红砖、钢管、金属声」→ 工业遗址艺术区
 *   太古里「咖啡机、香水、鞋跟」→ 潮流街区
 *   大慈寺「香火、银杏、青石板」→ 寺院
 * 没有数据支撑的词一律不收录，避免把用户引到不存在的场景。
 */

export const INTEREST_DICTIONARY = Object.freeze([
  {
    category: '自然保护地',
    weight: 1.5,
    basis: '熊猫基地：竹林、啃竹子',
    terms: ['熊猫', '大熊猫', '看熊猫', '竹林', '动物', '熊猫基地', '大熊猫基地', '看大熊猫'],
  },
  {
    category: '河岸夜景',
    weight: 1.4,
    basis: '九眼桥：江水灯光、啤酒烤串、吉他',
    terms: ['夜景', '夜游', '酒吧', '小酒馆', '夜生活', '江边', '看江', '啤酒', '烤串', '撸串', '吉他', '夜色', '灯光'],
  },
  {
    category: '民俗夜市',
    weight: 1.4,
    basis: '锦里：辣油、桂花糖、灯笼',
    terms: ['小吃', '夜市', '美食', '好吃', '吃货', '辣', '灯笼', '辣油', '桂花糖', '红灯笼'],
  },
  {
    category: '历史祠庙',
    weight: 1.4,
    basis: '武侯祠：红墙、三国',
    terms: ['祠堂', '三国', '武侯', '诸葛亮', '红墙', '刘备', '蜀汉'],
  },
  {
    category: '寺院',
    weight: 1.3,
    basis: '大慈寺：香火、银杏、青石板',
    terms: ['寺庙', '寺院', '香火', '祈福', '拜佛', '银杏', '烧香', '上香', '礼佛', '青石板'],
  },
  {
    category: '古典园林',
    weight: 1.3,
    basis: '望江楼：竹叶、江面船笛',
    terms: ['园林', '古典', '竹子', '江景', '望江', '竹叶', '船笛', '望江楼'],
  },
  {
    category: '工业遗址艺术区',
    weight: 1.3,
    basis: '东郊记忆：红砖、钢管、金属声',
    terms: ['工业风', '工业', '艺术区', '文艺', '拍照', '红砖', '厂房', '钢管', '金属声', '老厂房', '文创园', '工业遗址'],
  },
  {
    category: '潮流街区',
    weight: 1.3,
    basis: '太古里：咖啡机、香水、鞋跟',
    terms: ['潮牌', '购物', '逛街', '商圈', '咖啡', '太古里', '时尚', '香水', '咖啡机', '大牌', '专柜', '买衣服'],
  },
  {
    category: '历史街区',
    weight: 1.3,
    basis: '宽窄巷子：青砖墙、盖碗',
    terms: ['历史', '人文', '古街', '老街', '巷子', '盖碗茶', '喝茶', '茶馆', '茶', '青砖', '青砖墙', '采耳', '掏耳朵', '老巷'],
  },
  {
    category: '城市公园',
    weight: 1.2,
    basis: '人民公园：热水瓶、麻将、树影',
    terms: ['公园', '休闲', '慢生活', '麻将', '市井', '散步', '热水瓶', '光斑', '树影'],
  },
]);

// 长词优先：先匹配「盖碗茶」再匹配「茶」，避免短词吃掉长词。
const TERM_INDEX = INTEREST_DICTIONARY.flatMap((entry) =>
  entry.terms.map((term) => ({ term, category: entry.category, weight: entry.weight, basis: entry.basis })),
).sort((a, b) => b.term.length - a.term.length);

/**
 * 把一句口语拆成 { 类别: 权重 }。
 * 同类多词命中取最大权重，不做倍率叠乘（防止「喝茶看茶」把权重推到上限）。
 *
 * @param {string} text
 * @returns {{ categories: Record<string, number>, hits: Array, text: string }}
 */
export function mapInterests(text) {
  const raw = String(text ?? '');
  const hits = [];
  const categories = Object.create(null);
  if (raw.trim().length === 0) return { categories: {}, hits, text: raw };

  let rest = raw;
  for (const entry of TERM_INDEX) {
    if (!rest.includes(entry.term)) continue;
    // 命中后把该片段挖空，避免「人民公园」再被「公园」二次计数
    rest = rest.split(entry.term).join('\u3000');
    hits.push({ term: entry.term, category: entry.category, weight: entry.weight, basis: entry.basis });
    categories[entry.category] = Math.max(categories[entry.category] ?? 0, entry.weight);
  }

  return { categories: { ...categories }, hits, text: raw };
}

/**
 * 口语直接转成 planner 可消费的 preferences；一个类别都没命中时返回 null，
 * 由调用方决定是否提示（不伪造类别，也不默默返回空偏好）。
 */
export function preferencesFromInterests(text) {
  const { categories } = mapInterests(text);
  return Object.keys(categories).length > 0 ? { categories } : null;
}

/* ------------------------------------------------------------------
 * T4.13 扩展维度：人群 / 餐饮 / 节奏 / 模糊时间
 *
 * 只做「口语 → 参数」的映射，不参与选点计算。权重值交给 planner 的
 * weightOf 使用；stayFactor 交给调用方，当前 budget 只读，暂不生效。
 * ------------------------------------------------------------------ */

/** 人群维度：决定步速与建议停留系数。 */
export const CROWD_RULES = Object.freeze([
  {
    key: 'elderly',
    label: '带长辈',
    pace: 'relaxed',
    stayFactor: 1.2,
    words: ['带老人', '带爸妈', '带父母', '陪老人', '带爷爷', '带奶奶', '陪长辈', '带长辈', '陪爸妈', '陪父母', '带外公', '带外婆', '带姥姥', '带姥爷'],
  },
  {
    key: 'family',
    label: '带小孩',
    pace: 'relaxed',
    stayFactor: 1.2,
    words: ['带小孩', '带娃', '带孩子', '亲子', '全家出游', '一家老小', '带宝宝', '带小朋友', '遛娃'],
  },
  {
    key: 'couple',
    label: '情侣',
    pace: 'balanced',
    stayFactor: 1.05,
    words: ['情侣', '约会', '二人世界', '两个人逛', '谈恋爱', '小两口'],
  },
  {
    key: 'friends',
    label: '朋友同行',
    pace: 'balanced',
    stayFactor: 1,
    words: ['和朋友', '朋友一起', '闺蜜', '兄弟', '聚会', '结伴', '团建', '室友'],
  },
  {
    key: 'solo',
    label: '独自',
    pace: 'balanced',
    stayFactor: 1,
    words: ['独自', '一个人逛', '自己逛', '单人', '独行', '单人游'],
  },
]);

/** 餐饮维度：影响美食相关类别的权重。 */
export const DINING_RULES = Object.freeze([
  {
    key: 'skip',
    label: '不安排餐饮',
    weights: { 民俗夜市: 0.3, 历史街区: 0.3 },
    words: ['不安排餐饮', '不安排吃饭', '不安排吃', '只逛不吃', '不用吃饭', '不吃饭', '吃完再来', '不吃东西', '不想吃饭', '不饿', '免餐', '不需要吃饭'],
  },
  {
    key: 'need',
    label: '需要餐饮',
    weights: { 民俗夜市: 1.5, 历史街区: 1.5 },
    words: ['吃小吃', '吃点小吃', '找美食', '顺路吃饭', '顺路吃', '吃点东西', '苍蝇馆子', '火锅', '串串', '小吃街', '想吃', '觅食', '川菜', '冒菜', '钵钵鸡', '夜宵', '吃饭', '找吃的', '干饭'],
  },
]);

/** 节奏维度：决定步速与建议停留系数。 */
export const TEMPO_RULES = Object.freeze([
  {
    key: 'rush',
    label: '赶时间',
    pace: 'packed',
    stayFactor: 0.8,
    words: ['赶时间', '快逛', '快点逛', '时间紧', '抓紧看', '高效逛', '没时间', '时间不够', '速逛', '打卡式'],
  },
  {
    key: 'deep',
    label: '深度游',
    pace: 'relaxed',
    stayFactor: 1.3,
    words: ['深度游', '深度逛', '仔细看', '慢慢看', '沉浸式', '认真逛', '细看', '沉浸', '慢品'],
  },
  {
    key: 'leisure',
    label: '休闲逛',
    pace: 'relaxed',
    stayFactor: 1.1,
    words: ['休闲逛', '慢慢逛', '随便逛', '闲逛', '慢悠悠', '不赶路', '随意逛', '悠着点', '慢生活'],
  },
]);

/** 模糊时间：数字与「小时/分钟」之外的常见说法。顺序即优先级。 */
export const FUZZY_TIME_RULES = Object.freeze([
  { key: '小半天', minutes: 120, words: ['小半天'] },
  { key: '大半天', minutes: 300, words: ['大半天'] },
  { key: '半天', minutes: 240, words: ['半天', '半日', '整半天'] },
  { key: '一上午', minutes: 180, words: ['一上午', '上午逛', '一个上午'] },
  { key: '一下午', minutes: 240, words: ['一下午', '下午逛', '一个下午', '一整个下午'] },
  { key: '一天', minutes: 480, words: ['一整天', '一天', '全天', '一日游'] },
]);

function firstRule(rules, text) {
  for (const rule of rules) {
    const hit = rule.words.find((word) => text.includes(word));
    if (hit) return { ...rule, hit };
  }
  return null;
}

export function parseAudience(text = '') {
  const matched = firstRule(CROWD_RULES, String(text));
  if (!matched) return null;
  return { key: matched.key, label: matched.label, pace: matched.pace, stayFactor: matched.stayFactor, hit: matched.hit };
}

export function parseDining(text = '') {
  const matched = firstRule(DINING_RULES, String(text));
  if (!matched) return null;
  return { key: matched.key, label: matched.label, weights: { ...matched.weights }, hit: matched.hit };
}

export function parseTempo(text = '') {
  const matched = firstRule(TEMPO_RULES, String(text));
  if (!matched) return null;
  return { key: matched.key, label: matched.label, pace: matched.pace, stayFactor: matched.stayFactor, hit: matched.hit };
}

export function parseFuzzyTime(text = '') {
  const matched = firstRule(FUZZY_TIME_RULES, String(text));
  if (!matched) return null;
  return { key: matched.key, minutes: matched.minutes, hit: matched.hit };
}

/**
 * 汇总四类维度，产出可直接交给 planner 的偏好对象。
 *
 * categories 为空 Set 时，planner 的 normalizePreferences 会判为无偏好，
 * 因此未命中新维度的输入行为与升级前完全一致。
 */
export function buildPreferenceProfile(text = '') {
  const raw = String(text ?? '');
  const interest = mapInterests(raw);
  const dining = parseDining(raw);
  const crowd = parseAudience(raw);
  const tempo = parseTempo(raw);

  const weights = { ...interest.categories };
  if (dining) {
    for (const [category, weight] of Object.entries(dining.weights)) {
      weights[category] = weight;
    }
  }

  const categories = new Set(Object.keys(weights));
  const weightMap = new Map(Object.entries(weights));
  const fallbackWeight = 1;

  let stayFactor = 1;
  if (crowd) stayFactor *= crowd.stayFactor;
  if (tempo) stayFactor *= tempo.stayFactor;
  stayFactor = Math.round(stayFactor * 100) / 100;

  return {
    categories,
    weights: weightMap,
    weightOf: (category) => weightMap.get(category) ?? fallbackWeight,
    pace: tempo?.pace ?? crowd?.pace ?? null,
    crowd: crowd?.key ?? null,
    dining: dining?.key ?? null,
    tempo: tempo?.key ?? null,
    crowd_label: crowd?.label ?? null,
    dining_label: dining?.label ?? null,
    tempo_label: tempo?.label ?? null,
    stay_factor: stayFactor,
    hits: [...interest.hits, crowd?.hit, dining?.hit, tempo?.hit].filter(Boolean),
  };
}
