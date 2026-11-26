'use strict';

/**
 * Attribute concern（设计文档 3.8）
 * ------------------------------------------------------------------
 * - casts：int|float|bool|string|json|date|array
 * - getters / setters：模型配置中的访问器/修改器
 * - hidden / visible / appends：序列化控制
 * - 统一入口 get/set/toArray，保证读路径与写路径一致
 */

/** 读取转换 */
const CAST_GET = {
  int: (v) => (v === null || v === undefined || v === '' ? null : parseInt(v, 10)),
  float: (v) => (v === null || v === undefined || v === '' ? null : parseFloat(v)),
  bool: (v) => {
    if (v === null || v === undefined) return null;
    return v === true || v === 1 || v === '1' || v === 'true';
  },
  string: (v) => (v === null || v === undefined ? null : String(v)),
  json: (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v);
    } catch (_) {
      return null;
    }
  },
  array: (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (Array.isArray(v)) return v;
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  },
  date: (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return v;
    const date = new Date(v);
    return Number.isNaN(date.getTime()) ? null : date;
  },
};

/** 写入转换 */
const CAST_SET = {
  json: (v) => (v === null || v === undefined ? null : JSON.stringify(v)),
  array: (v) => (v === null || v === undefined ? null : JSON.stringify(v)),
  int: (v) => (v === null || v === undefined || v === '' ? null : parseInt(v, 10)),
  float: (v) => (v === null || v === undefined || v === '' ? null : parseFloat(v)),
  bool: (v) => (v === null || v === undefined ? null : (v ? 1 : 0)),
  string: (v) => (v === null || v === undefined ? null : String(v)),
  date: (v) => {
    if (v === null || v === undefined || v === '') return null;
    return v instanceof Date ? v : new Date(v);
  },
};

/** 取 getter 函数：支持函数形式或 { get, set } 形式 */
function getterOf(Model, key) {
  const conf = Model.getters && Model.getters[key];
  if (typeof conf === 'function') return conf;
  if (conf && typeof conf.get === 'function') return conf.get;
  return null;
}

/** 取 setter 函数 */
function setterOf(Model, key) {
  const conf = Model.setters && Model.setters[key];
  if (typeof conf === 'function') return conf;
  if (conf && typeof conf.set === 'function') return conf.set;
  return null;
}

/**
 * 读取属性（cast → getter 顺序：先 cast 再 getter，符合 ThinkORM 习惯）
 * @param {Function} Model
 * @param {string} key
 * @param {any} raw 原始值
 * @param {object} instance 实例（供 getter 使用）
 */
function castGet(Model, key, raw, instance) {
  let value = raw;
  const type = Model.casts && Model.casts[key];
  if (type && CAST_GET[type]) value = CAST_GET[type](value);
  const getter = getterOf(Model, key);
  if (getter) value = getter.call(instance, value, instance);
  return value;
}

/**
 * 写入属性（setter → cast）
 */
function castSet(Model, key, value, instance) {
  let next = value;
  const setter = setterOf(Model, key);
  if (setter) next = setter.call(instance, next, instance);
  const type = Model.casts && Model.casts[key];
  if (type && CAST_SET[type]) next = CAST_SET[type](next);
  return next;
}

/**
 * 序列化：hidden/visible 过滤 + casts/getter + 关联 + appends
 * @param {Function} Model
 * @param {object} instance
 */
function toArray(Model, instance) {
  const baseHidden = normalizeList(Model.hidden);
  const baseVisible = normalizeList(Model.visible);
  const appends = [...normalizeList(Model.appends), ...normalizeList(instance._appends)];
  const hidden = new Set([...baseHidden, ...normalizeList(instance._hidden)]);
  const visible = [...baseVisible, ...normalizeList(instance._visible)];
  const keep = (key) => {
    if (hidden.has(key)) return false;
    if (visible.length && !visible.includes(key) && !appends.includes(key)) return false;
    return true;
  };

  const output = {};
  for (const key of Object.keys(instance._data)) {
    if (!keep(key)) continue;
    output[key] = instance.get(key);
  }

  // 关联
  for (const [name, value] of Object.entries(instance._relations || {})) {
    if (!keep(name)) continue;
    output[name] = serializeRelation(value);
  }

  // appends：优先取原型 getter / 模型 getter，其次取关联
  for (const name of appends) {
    if (output[name] !== undefined) continue;
    if (Object.prototype.hasOwnProperty.call(instance._data, name)) {
      output[name] = instance.get(name);
    } else if (name in instance) {
      output[name] = instance[name];
    } else {
      const getter = getterOf(Model, name);
      if (getter) output[name] = getter.call(instance, undefined, instance);
    }
  }

  return output;
}

/** 关联值序列化：实例 / 实例数组 / null */
function serializeRelation(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.map((item) => (item && item.toArray ? item.toArray() : item));
  return value.toArray ? value.toArray() : value;
}

/** 归一化列表配置：数组或逗号分隔字符串 */
function normalizeList(list) {
  if (!list) return [];
  if (Array.isArray(list)) return list;
  if (typeof list === 'string') return list.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

export { castGet, castSet, toArray, normalizeList, getterOf, setterOf };
