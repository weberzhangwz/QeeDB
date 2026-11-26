'use strict';

/**
 * Relation 基类（设计文档 3.9）
 * ------------------------------------------------------------------
 * 关联查询统一走「批量 IN 预载入」：
 *   1. 收集父模型外键/主键
 *   2. 目标表 WHERE IN 一次查询
 *   3. 内存分组回填 _relations，避免 N+1
 */

import { ModelError } from '../exceptions/index.js';

class Relation {
  /**
   * @param {Function} parentModel 父模型类
   * @param {Function} targetModel 目标模型类
   * @param {object} options { name, foreignKey, localKey, ... }
   */
  constructor(parentModel, targetModel, options = {}) {
    if (typeof parentModel !== 'function' || typeof targetModel !== 'function') {
      throw new ModelError('关联需要父模型类与目标模型类');
    }
    this.parentModel = parentModel;
    this.targetModel = targetModel;
    this.name = options.name;
    this.foreignKey = options.foreignKey;
    this.localKey = options.localKey;
  }

  /** 父模型一侧的键（默认主键） */
  getLocalKey(instance) {
    return this.localKey || this.parentModel.pk || 'id';
  }

  /** 读取实例字段 */
  read(instance, key) {
    return instance.get ? instance.get(key) : instance._data[key];
  }

  /** 收集父实例上的键值（去重、剔除空值） */
  collectKeys(instances) {
    const values = [];
    const seen = new Set();
    for (const instance of instances) {
      const value = this.read(instance, this.getLocalKey(instance));
      if (value === undefined || value === null || value === '') continue;
      const mark = typeof value === 'object' ? JSON.stringify(value) : value;
      if (seen.has(mark)) continue;
      seen.add(mark);
      values.push(value);
    }
    return values;
  }

  /** 子类实现：批量预载入 */
  async eagerLoad() {
    throw new ModelError(`${this.constructor.name} 未实现 eagerLoad()`);
  }

  /** 子类实现：单实例懒加载 */
  async loadFor(instance) {
    const result = await this.eagerLoad([instance]);
    return instance._relations[this.name];
  }
}

export default Relation;
