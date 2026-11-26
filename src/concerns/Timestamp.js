'use strict';

/**
 * Timestamp concern（设计文档 3.8）
 * ------------------------------------------------------------------
 * 在 save 前注入 createTime / updateTime，按 timestampType 生成 Date 或 Unix 秒。
 * 已显式提供的字段不会被覆盖。
 */

import { nowValue } from '../utils/helpers.js';

/**
 * 插入前：同时补 createTime 与 updateTime
 * @param {Function} Model 模型类
 * @param {object} data 待写入数据（原地修改）
 */
function applyInsert(Model, data) {
  if (!Model.timestamps) return data;
  const now = nowValue(Model.timestampType);
  const createField = Model.createTime;
  const updateField = Model.updateTime;

  if (createField && data[createField] === undefined) data[createField] = now;
  if (updateField && data[updateField] === undefined) data[updateField] = now;
  return data;
}

/**
 * 更新前：只补 updateTime
 */
function applyUpdate(Model, data) {
  if (!Model.timestamps) return data;
  const updateField = Model.updateTime;
  if (updateField && data[updateField] === undefined) {
    data[updateField] = nowValue(Model.timestampType);
  }
  return data;
}

export { applyInsert, applyUpdate };
