/**
 * 云径·CityWalk — 零依赖 JSON Schema 子集校验器
 *
 * 只做本仓库契约真正用得到的那一层，不引入 ajv：
 *   type / required / enum / const / minimum / maximum / exclusiveMinimum / exclusiveMaximum
 *   minLength / maxLength / pattern / minItems / maxItems / items
 *   minProperties / maxProperties / properties / additionalProperties
 *
 * 用法（Node）：
 *   node tools/schema-check.mjs ../outputs/samples/chengdu-tea.json
 *   不带参数时校验 knowledge/ 下的示例 schema 自身可解析。
 *
 * 作为库：
 *   import { validateAgainstSchema } from '../tools/schema-check.mjs';
 *   const { valid, issues } = validateAgainstSchema(script, schema);
 *
 * 返回的 issues 是带 JSON 路径的人类可读字符串，例如：
 *   $.route[0].energy: 取值 99 超出 maximum 3
 */

const KNOWN_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'non-finite number';
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function joinKey(path, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(node, key)) return null;
    node = node[key];
  }
  return node;
}

function walk(value, schema, path, issues, root) {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema === false) {
    issues.push(`${path}: 该位置不允许出现任何值`);
    return;
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) return;

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root ?? schema);
    if (target === null) {
      issues.push(`${path}: 无法解析 $ref「${schema.$ref}」`);
      return;
    }
    walk(value, target, path, issues, root ?? schema);
    return;
  }

  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (alternatives) {
    const branches = alternatives.map((sub) => {
      const branchIssues = [];
      walk(value, sub, path, branchIssues, root ?? schema);
      return branchIssues;
    });
    const passing = schema.oneOf ? branches.filter((b) => b.length === 0).length === 1 : branches.some((b) => b.length === 0);
    if (!passing) {
      // 分支选择：优先报「类型匹配但内容有误」的分支，而不是「类型就不对」的分支。
      // 否则 anyOf:[null, object] 会永远只报「类型应为 null」。
      const typedMismatch = (list) => list.some((msg) => msg.startsWith(`${path}: 类型应为`));
      const contentful = branches.filter((list) => list.length > 0 && !typedMismatch(list));
      const pool = contentful.length > 0 ? contentful : branches;
      pool.sort((a, b) => a.length - b.length);
      issues.push(...pool[0]);
    }
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const unknown = types.find((t) => !KNOWN_TYPES.has(t));
    if (unknown !== undefined) {
      issues.push(`${path}: schema 使用了不支持的 type「${unknown}」`);
      return;
    }
    if (!types.some((t) => matchesType(value, t))) {
      issues.push(`${path}: 类型应为 ${types.join(' | ')}，实际为 ${describeType(value)}`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
    issues.push(`${path}: 取值 ${JSON.stringify(value)} 不在枚举 [${schema.enum.map((v) => JSON.stringify(v)).join(', ')}] 内`);
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(schema.const, value)) {
    issues.push(`${path}: 必须恒等于 ${JSON.stringify(schema.const)}，实际为 ${JSON.stringify(value)}`);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push(`${path}: 取值 ${value} 小于 minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push(`${path}: 取值 ${value} 大于 maximum ${schema.maximum}`);
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      issues.push(`${path}: 取值 ${value} 必须大于 ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      issues.push(`${path}: 取值 ${value} 必须小于 ${schema.exclusiveMaximum}`);
    }
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      issues.push(`${path}: 长度 ${length} 小于 minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      issues.push(`${path}: 长度 ${length} 大于 maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string') {
      let re = null;
      try {
        re = new RegExp(schema.pattern, 'u');
      } catch (error) {
        issues.push(`${path}: schema 的 pattern 无法编译（${error.message}）`);
      }
      if (re && !re.test(value)) {
        issues.push(`${path}: 取值 ${JSON.stringify(value)} 不匹配 pattern ${schema.pattern}`);
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push(`${path}: 元素数 ${value.length} 小于 minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      issues.push(`${path}: 元素数 ${value.length} 大于 maxItems ${schema.maxItems}`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => walk(item, schema.items, `${path}[${index}]`, issues, root ?? schema));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const keys = Object.keys(value);

    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        issues.push(`${path}: 缺少必填字段 ${key}`);
      }
    }

    for (const [key, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        walk(value[key], sub, joinKey(path, key), issues, root ?? schema);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          issues.push(`${path}: 不允许的字段 ${key}`);
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          walk(value[key], schema.additionalProperties, joinKey(path, key), issues, root ?? schema);
        }
      }
    }

    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      issues.push(`${path}: 字段数 ${keys.length} 小于 minProperties ${schema.minProperties}`);
    }
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      issues.push(`${path}: 字段数 ${keys.length} 大于 maxProperties ${schema.maxProperties}`);
    }
  }
}

/**
 * @param {unknown} data 待校验数据
 * @param {object} schema JSON Schema（子集）
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validateAgainstSchema(data, schema) {
  const issues = [];
  walk(data, schema, '$', issues, schema);
  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// 可选 CLI：node tools/schema-check.mjs <script.json> [schema.json]
// 仅在直接被 node 执行时生效，作为库 import 时没有任何副作用或外部依赖。
// ---------------------------------------------------------------------------
// CLI 逻辑包进 async 函数：避免顶层 await，浏览器端打包时不会因目标环境不支持而失败。
async function runCli() {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url !== pathToFileURL(process.argv[1]).href) return;
  const { readFileSync } = await import('node:fs');
  const defaultSchema = new URL('../knowledge/tour_script.schema.json', import.meta.url);
  const target = process.argv[2];
  const schemaPath = process.argv[3] || defaultSchema;
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    if (!target) {
      console.log('用法：node tools/schema-check.mjs <tour_script.json> [schema.json]');
      process.exitCode = 1;
    } else {
      const data = JSON.parse(readFileSync(target, 'utf8'));
      const { valid, issues } = validateAgainstSchema(data, schema);
      if (valid) {
        console.log(`✅ ${target} 通过 schema 校验（${schema.title || 'schema'}）`);
      } else {
        console.error(`❌ ${target} 有 ${issues.length} 处不符合契约：`);
        for (const issue of issues) console.error(`   · ${issue}`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(`读取或解析失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (typeof process !== 'undefined' && process.argv?.[1]) {
  runCli().catch((error) => {
    console.error(`读取或解析失败：${error.message}`);
    process.exitCode = 1;
  });
}
