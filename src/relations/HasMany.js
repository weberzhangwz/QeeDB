'use strict';

/**
 * hasMany：父表主键 ← 目标表外键（多条）
 * 例：Post.hasMany(Comment, 'post_id')
 */

import Relation from './Relation.js';

class HasMany extends Relation {
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
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
      }
    }

    for (const instance of instances) {
      const key = this.read(instance, this.getLocalKey(instance));
      instance._relations[this.name] = map.get(key) || [];
    }
    return instances;
  }
}

export default HasMany;
