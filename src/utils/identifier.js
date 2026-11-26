'use strict';

/**
 * 标识符转义与校验（设计文档 3.2.2 / 3.11）
 * ------------------------------------------------------------------
 * 只允许「安全标识符」进入 SQL 结构位置，避免字符串拼接注入：
 *   - `name`          普通字段/表名
 *   - `a.b`           schema/表 + 字段
 *   - `a as b`        别名（大小写不敏感，支持多空格）
 *   - `a.b as c`      组合形式
 *   - `*` / `a.*`     通配符
 *
 * 任何不满足白名单的写法直接抛 InvalidQueryError，引导调用方改用 whereRaw。
 */

import { InvalidQueryError } from '../exceptions/index.js';

// 单个标识符片段：字母或下划线开头，后续允许字母/数字/下划线/$
const SEGMENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// 别名分隔：as（大小写不敏感）
const AS_RE = /\s+as\s+/i;

// 转义结果缓存（设计文档 7：escapeId 结果可缓存）
const CACHE_LIMIT = 1000;
const cache = new Map();

/**
 * 转义单个片段（列名 / 表名）
 * @param {string} segment
 * @param {string} quote 引用符，MySQL 用反引号
 * @returns {string}
 */
function escapeSegment(segment, quote = '`') {
  if (segment === '*') return '*';
  if (!SEGMENT_RE.test(segment)) {
    throw new InvalidQueryError(`非法标识符片段：${JSON.stringify(segment)}`, {
      code: 'QEEDB_INVALID_IDENTIFIER',
    });
  }
  return `${quote}${segment}${quote}`;
}

/**
 * 转义标识符表达式（支持点号、别名）
 * @param {string} expr
 * @param {string} quote
 * @returns {string}
 */
function escapeId(expr, quote = '`') {
  if (typeof expr !== 'string' || expr.trim() === '') {
    throw new InvalidQueryError(`标识符必须是非空字符串，收到：${String(expr)}`);
  }

  const raw = expr.trim();
  const cacheKey = `${quote}:${raw}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let out;

  // 处理别名：a.b as c
  const asMatch = raw.match(AS_RE);
  if (asMatch && asMatch.index !== undefined) {
    const left = raw.slice(0, asMatch.index).trim();
    const alias = raw.slice(asMatch.index + asMatch[0].length).trim();
    out = `${escapeIdWithoutAlias(left, quote)} AS ${escapeSegment(alias, quote)}`;
  } else {
    out = escapeIdWithoutAlias(raw, quote);
  }

  // 简单 LRU：超过上限清空一半，避免无限增长
  if (cache.size >= CACHE_LIMIT) {
    let drop = Math.floor(CACHE_LIMIT / 2);
    for (const key of cache.keys()) {
      cache.delete(key);
      if (--drop <= 0) break;
    }
  }
  cache.set(cacheKey, out);
  return out;
}

/**
 * 不含 as 的标识符转义
 */
function escapeIdWithoutAlias(raw, quote) {
  if (raw === '*') return '*';
  const parts = raw.split('.');
  if (parts.length > 2) {
    throw new InvalidQueryError(`标识符层级过深（最多 a.b）：${raw}`);
  }
  for (const part of parts) {
    const p = part.trim();
    if (p === '*') continue;
    if (!SEGMENT_RE.test(p)) {
      throw new InvalidQueryError(`非法标识符：${JSON.stringify(raw)}`, {
        code: 'QEEDB_INVALID_IDENTIFIER',
      });
    }
  }
  return parts.map((p) => (p.trim() === '*' ? '*' : escapeSegment(p.trim(), quote))).join('.');
}

/**
 * 清空转义缓存（测试或热更新场景）
 */
function clearIdentifierCache() {
  cache.clear();
}

export { escapeId, escapeSegment, clearIdentifierCache };
