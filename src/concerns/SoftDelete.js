'use strict';

/**
 * SoftDelete concern（设计文档 3.8）
 * ------------------------------------------------------------------
 * 软删除能力由 Query 的软删除作用域 + Model 的 delete/restore 协作完成：
 *  - 标记值：softDeleteDefault 为 0 时用 Unix 秒，否则用 Date
 *  - 查询：auto 注入「未删除」条件，with / only 由 withTrashed / onlyTrashed 控制
 */

import { nowValue, isPlainObject } from '../utils/helpers.js';

/**
 * 解析软删除字段：false | 'delete_time' | true
 * @param {Function} Model
 * @returns {string|false}
 */
function getSoftDeleteField(Model) {
  const value = Model.softDelete;
  if (!value) return false;
  if (value === true) return 'delete_time';
  return String(value);
}

/** 软删除标记值 */
function deletedValue(Model) {
  const field = getSoftDeleteField(Model);
  if (!field) return undefined;
  return typeof Model.softDeleteDefault === 'number'
    ? Math.floor(Date.now() / 1000)
    : new Date();
}

/** 恢复值（与判定值一致） */
function restoredValue(Model) {
  return Model.softDeleteDefault;
}

/** 是否处于已删除状态 */
function isTrashed(Model, instance) {
  const field = getSoftDeleteField(Model);
  if (!field) return false;
  const value = instance._data[field];
  return value !== null && value !== undefined && value !== Model.softDeleteDefault;
}

/**
 * 查询作用域注入（供 ModelQuery 使用）
 * @param {object} state Query 状态
 * @param {Function} Model
 * @returns {object[]} 需追加的 where AST 节点
 */
function scopeNodes(state, Model) {
  const field = getSoftDeleteField(Model);
  if (!field) return [];
  if (state.softDelete === 'with') return [];
  if (state.softDelete === 'only') {
    return [{ type: 'notnull', boolean: 'AND', field }];
  }
  return [{ type: 'basic', boolean: 'AND', field, op: '=', value: Model.softDeleteDefault }];
}

/**
 * 提取软删除相关字段（插入时如模型默认值未提供，可按需补 null）
 */
function fillDefaults(Model, data) {
  if (!isPlainObject(data)) return data;
  const field = getSoftDeleteField(Model);
  if (field && data[field] === undefined) data[field] = Model.softDeleteDefault;
  return data;
}

export {
  getSoftDeleteField,
  deletedValue,
  restoredValue,
  isTrashed,
  scopeNodes,
  fillDefaults,
  nowValue,
};
