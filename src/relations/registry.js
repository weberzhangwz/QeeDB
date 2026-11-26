'use strict';

/**
 * 关联注册表
 * ------------------------------------------------------------------
 * 每个 Model 子类一份关联定义表（WeakMap，避免挂在类上被继承污染）。
 * 关联在类定义阶段通过 hasOne/hasMany/belongsTo/belongsToMany 注册。
 */

import { ModelError } from '../exceptions/index.js';
import { pluralize } from '../utils/helpers.js';

/** @type {WeakMap<Function, Map<string, object>>} */
const registry = new WeakMap();

function relationMap(Model) {
  let map = registry.get(Model);
  if (!map) {
    map = new Map();
    registry.set(Model, map);
  }
  return map;
}

/** 注册关联并返回关联对象 */
function defineRelation(Model, name, relation) {
  if (!name || typeof name !== 'string') throw new ModelError('关联名称必须是非空字符串');
  relation.name = name;
  relationMap(Model).set(name, relation);
  return relation;
}

/** 取关联定义 */
function getRelation(Model, name) {
  return relationMap(Model).get(name);
}

/** 列出某模型的全部关联名 */
function listRelations(Model) {
  return Array.from(relationMap(Model).keys());
}

/** 是否存在关联（含继承链：逐级向上查找） */
function hasRelation(Model, name) {
  let current = Model;
  while (current && current !== Function.prototype) {
    const map = registry.get(current);
    if (map && map.has(name)) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}

/** 取关联，沿原型链向上查找（子类可使用父类定义的关联） */
function resolveRelation(Model, name) {
  let current = Model;
  while (current && current !== Function.prototype) {
    const map = registry.get(current);
    if (map && map.has(name)) return map.get(name);
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/** 由类名推断关联名：Comment -> comment / comments */
function defaultRelationName(TargetClass, many = false) {
  const base = decapitalize(TargetClass.name || 'relation');
  return many ? pluralize(base) : base;
}

function decapitalize(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export {
  defineRelation,
  getRelation,
  resolveRelation,
  listRelations,
  hasRelation,
  defaultRelationName,
};
