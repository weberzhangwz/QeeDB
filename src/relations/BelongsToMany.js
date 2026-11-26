'use strict';

/**
 * belongsToMany：中间表 join（多对多）
 * 例：Post.belongsToMany(Tag, 'post_tag', 'post_id', 'tag_id')
 *
 * 预载入流程：
 *   父键集合 → 中间表 WHERE fk IN (...) → 目标表 WHERE pk IN (...)
 *   → 内存分组回填，目标实例附带 _pivot（中间行）
 */

import Relation from './Relation.js';
import Query from '../query/Query.js';

class BelongsToMany extends Relation {
  /**
   * @param {Function} parentModel
   * @param {Function} targetModel
   * @param {string} pivot 中间表名
   * @param {string} foreignPivotKey 中间表中指向父模型的字段
   * @param {string} relatedPivotKey 中间表中指向目标模型的字段
   * @param {object} options { name, parentKey, relatedKey }
   */
  constructor(parentModel, targetModel, pivot, foreignPivotKey, relatedPivotKey, options = {}) {
    super(parentModel, targetModel, options);
    this.pivot = pivot;
    this.foreignPivotKey = foreignPivotKey;
    this.relatedPivotKey = relatedPivotKey;
    this.parentKey = options.parentKey || parentModel.pk || 'id';
    this.relatedKey = options.relatedKey || targetModel.pk || 'id';
  }

  getLocalKey() {
    return this.parentKey;
  }

  async eagerLoad(instances) {
    const parentKeys = this.collectKeys(instances);
    /** @type {Map<any, object[]>} 父键 → 中间行 */
    const pivotMap = new Map();
    /** @type {Map<any, object>} 目标主键 → 目标实例 */
    const targetMap = new Map();

    if (parentKeys.length) {
      // 1) 中间表批量查询
      const pivotRows = await new Query(this.parentModel.getConnection())
        .table(this.pivot)
        .whereIn(this.foreignPivotKey, parentKeys)
        .select();

      const relatedKeys = [];
      const seen = new Set();
      for (const row of pivotRows) {
        const parentKey = row[this.foreignPivotKey];
        if (!pivotMap.has(parentKey)) pivotMap.set(parentKey, []);
        pivotMap.get(parentKey).push(row);

        const relatedKey = row[this.relatedPivotKey];
        if (!seen.has(relatedKey)) {
          seen.add(relatedKey);
          relatedKeys.push(relatedKey);
        }
      }

      // 2) 目标表批量查询
      if (relatedKeys.length) {
        const targets = await this.targetModel
          .query()
          .whereIn(this.relatedKey, relatedKeys)
          .select();
        for (const target of targets) {
          targetMap.set(target.get(this.relatedKey), target);
        }
      }
    }

    // 3) 分组回填 + pivot 信息
    for (const instance of instances) {
      const key = this.read(instance, this.parentKey);
      const rows = pivotMap.get(key) || [];
      const related = [];
      for (const row of rows) {
        const target = targetMap.get(row[this.relatedPivotKey]);
        if (!target) continue;
        // 同一目标可能被多个父模型关联：复制实例，pivot 互不覆盖
        const instanceCopy = this.targetModel.hydrate(target.getData());
        instanceCopy._pivot = { ...row };
        related.push(instanceCopy);
      }
      instance._relations[this.name] = related;
    }
    return instances;
  }
}

export default BelongsToMany;
