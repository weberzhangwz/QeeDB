'use strict';

/**
 * with 预载入调度（设计文档 3.9）
 * ------------------------------------------------------------------
 * 支持嵌套路径：with('posts','posts.comments')
 * 逐段解析：先载入第一段 → 收集已载入实例 → 对下一段递归，
 * 全程批量 IN 查询，避免 N+1。
 */

import { resolveRelation, listRelations } from './registry.js';
import { ModelError } from '../exceptions/index.js';

/**
 * @param {Array} models 已水合的实例数组
 * @param {string[]} paths 关联路径
 * @param {Function} [ModelClass] 这些实例所属的模型类（默认从实例取）
 */
async function loadRelations(models, paths, ModelClass) {
  if (!Array.isArray(models) || models.length === 0) return models;
  if (!Array.isArray(paths) || paths.length === 0) return models;

  const Model = ModelClass || models[0].constructor;

  for (const path of paths) {
    if (typeof path !== 'string' || !path.trim()) continue;
    const segments = path.split('.').filter(Boolean);
    const head = segments[0];
    const relation = resolveRelation(Model, head);
    if (!relation) {
      throw new ModelError(
        `未定义的关联「${head}」（模型 ${Model.name}）。已注册关联：${listRelations(Model).join(', ') || '无'}；` +
          '请先在模型上调用 hasOne/hasMany/belongsTo/belongsToMany 注册',
      );
    }

    await relation.eagerLoad(models);

    const rest = segments.slice(1).join('.');
    if (rest) {
      const related = [];
      for (const model of models) {
        const value = model._relations[head];
        if (Array.isArray(value)) related.push(...value);
        else if (value) related.push(value);
      }
      if (related.length) {
        await loadRelations(related, [rest], relation.targetModel);
      }
    }
  }

  return models;
}

/**
 * 校验关联路径是否都已注册（不触库，空结果集也能及时发现拼写错误）
 * @param {Function} Model
 * @param {string[]} paths
 */
function validatePaths(Model, paths) {
  for (const path of paths) {
    const segments = String(path).split('.').filter(Boolean);
    const head = segments[0];
    const relation = resolveRelation(Model, head);
    if (!relation) {
      throw new ModelError(
        `未定义的关联「${head}」（模型 ${Model.name}）。已注册关联：${listRelations(Model).join(', ') || '无'}；` +
          '请先在模型上调用 hasOne/hasMany/belongsTo/belongsToMany 注册',
      );
    }
    const rest = segments.slice(1).join('.');
    if (rest) validatePaths(relation.targetModel, [rest]);
  }
  return true;
}

export { loadRelations, validatePaths };
