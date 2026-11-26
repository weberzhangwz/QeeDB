'use strict';

/**
 * belongsTo：父表外键 → 目标表主键（一条）
 * 例：Post.belongsTo(User, 'user_id')
 */

import Relation from './Relation.js';

class BelongsTo extends Relation {
  /** 父模型一侧的键是外键 */
  getLocalKey() {
    return this.foreignKey;
  }

  async eagerLoad(instances) {
    const keys = this.collectKeys(instances);
    const map = new Map();
    const targetPk = this.localKey || this.targetModel.pk || 'id';

    if (keys.length) {
      const rows = await this.targetModel.query().whereIn(targetPk, keys).select();
      for (const row of rows) {
        map.set(row.get(targetPk), row);
      }
    }

    for (const instance of instances) {
      const key = this.read(instance, this.foreignKey);
      instance._relations[this.name] = map.get(key) || null;
    }
    return instances;
  }
}

export default BelongsTo;
