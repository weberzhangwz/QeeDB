'use strict';

/**
 * hasOne：父表主键 ← 目标表外键（一条）
 * 例：User.hasOne(Profile, 'user_id')
 */

import Relation from './Relation.js';

class HasOne extends Relation {
  async eagerLoad(instances) {
    const keys = this.collectKeys(instances);
    const map = new Map();

    if (keys.length) {
      const rows = await this.targetModel
        .query()
        .whereIn(this.foreignKey, keys)
        .select();

      for (const row of rows) {
        const key = row.get(this.foreignKey);
        if (!map.has(key)) map.set(key, row);
      }
    }

    for (const instance of instances) {
      const key = this.read(instance, this.getLocalKey(instance));
      instance._relations[this.name] = map.get(key) || null;
    }
    return instances;
  }
}

export default HasOne;
