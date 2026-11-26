'use strict';

/**
 * 通用工具方法（无外部依赖）
 */

/** 是否普通对象（排除数组/Date/Model 实例等） */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 深拷贝（仅处理 JSON 安全结构：对象/数组/Date/基本类型） */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

/** UserProfile -> user_profile */
function snakeCase(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** 简单复数化：user -> users, category -> categories */
function pluralize(word) {
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies');
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** 类名推断默认表名：UserProfile -> user_profiles */
function tableNameFromClass(className) {
  return pluralize(snakeCase(className));
}

/** 驼峰化：user_profile -> userProfile */
function camelCase(name) {
  return name.replace(/^_+/, '').replace(/[_\-]+(\w)/g, (_, c) => c.toUpperCase());
}

/** 格式化日期为 MySQL datetime：2026-11-22 10:00:00 */
function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 现在：Date 或 Unix 秒，取决于模型 timestampType */
function nowValue(type) {
  return type === 'int' ? Math.floor(Date.now() / 1000) : new Date();
}

/** 兜底包装 Promise 回调 */
function isPromiseLike(value) {
  return value && typeof value.then === 'function';
}

export {
  isPlainObject,
  deepClone,
  snakeCase,
  pluralize,
  tableNameFromClass,
  camelCase,
  formatDateTime,
  nowValue,
  isPromiseLike,
};
