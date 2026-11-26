'use strict';

/**
 * ModelQuery（设计文档 3.4 / 3.5.2）
 * ------------------------------------------------------------------
 * 绑定 Model 类的 Query：
 *  - 表名 / 主键来自模型配置
 *  - 结果水合为 Model 实例
 *  - 自动注入软删除作用域（auto / with / only）
 *  - 更新时自动注入 updateTime（timestamps 开启）
 *  - select 之后执行 with 预载入
 */

import Query from './Query.js';
import { nowValue } from '../utils/helpers.js';
import { loadRelations, validatePaths } from '../relations/eager.js';

class ModelQuery extends Query {
  /**
   * @param {typeof import('../model/Model')} ModelClass
   * @param {object} connection
   */
  constructor(ModelClass, connection) {
    super(connection);
    this.ModelClass = ModelClass;
    this._state.model = ModelClass;
    this._state.table = ModelClass.getTable();
  }

  /** 主键名来自模型 */
  _pk() {
    return this.ModelClass.pk || 'id';
  }

  /** 注入软删除作用域（设计文档 3.8 SoftDelete / _state.softDelete 防重复注入） */
  _prepareState() {
    const state = { ...this._state, where: this._state.where.slice() };
    const Model = this.ModelClass;
    const softField = Model.getSoftDeleteField();

    if (softField && state.softDelete === 'auto') {
      state.where.push({
        type: 'basic',
        boolean: 'AND',
        field: softField,
        op: '=',
        value: Model.softDeleteDefault,
      });
    } else if (softField && state.softDelete === 'only') {
      state.where.push({ type: 'notnull', boolean: 'AND', field: softField });
    }
    return state;
  }

  /** 结果水合 */
  _hydrate(rows) {
    if (!Array.isArray(rows)) return rows;
    return rows.map((row) => this.ModelClass.hydrate(row));
  }

  /** 关联预载入（避免 N+1） */
  async _afterFetch(rows) {
    if (!Array.isArray(rows)) return rows;
    if (this._state.with.length) {
      // 先校验路径，空结果集也能及时发现关联拼写错误
      validatePaths(this.ModelClass, this._state.with);
      if (rows.length === 0) return rows;
      await loadRelations(rows, this._state.with, this.ModelClass);
    }
    return rows;
  }

  /** 更新时补充 updateTime */
  async update(data) {
    const Model = this.ModelClass;
    if (Model.timestamps && data && typeof data === 'object') {
      const field = Model.getUpdateTimeField();
      if (field && !Object.prototype.hasOwnProperty.call(data, field)) {
        data = { ...data, [field]: nowValue(Model.timestampType) };
      }
    }
    return super.update(data);
  }

  /** 软删除：delete() 改写为 UPDATE 删除标记 */
  async delete() {
    const Model = this.ModelClass;
    const softField = Model.getSoftDeleteField();
    if (!softField) return super.delete();

    const value = typeof Model.softDeleteDefault === 'number' ? Math.floor(Date.now() / 1000) : new Date();
    return super.update({ [softField]: value });
  }

  /** 物理删除（软删除模型需要真正移除行时显式调用） */
  async forceDelete() {
    return Query.prototype.delete.call(this);
  }
}

export default ModelQuery;
