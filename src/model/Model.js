'use strict';

/**
 * Model 基类（设计文档 3.5）
 * ------------------------------------------------------------------
 * 用法：class User extends Model {}
 *   - 静态配置通过 static 字段/访问器覆盖（table/pk/connection/timestamps/...）
 *   - 静态方法通过原型链继承 + this 指向子类，各子类互不干扰（ADR-06）
 *   - 实例维护 _data/_origin/_exists，save() 自动区分插入与更新
 *
 * 配置优先级：子类 static 字段 > 基类默认 getter。
 */

import ModelQuery from '../query/ModelQuery.js';
import manager from '../manager.js';
import { ModelError, ModelNotFoundException } from '../exceptions/index.js';
import {
  deepClone,
  tableNameFromClass,
  snakeCase,
  camelCase,
  nowValue,
} from '../utils/helpers.js';

import * as Attribute from '../concerns/Attribute.js';
import * as Timestamp from '../concerns/Timestamp.js';
import * as SoftDelete from '../concerns/SoftDelete.js';
import * as ModelEvent from '../concerns/Event.js';

import { defineRelation } from '../relations/registry.js';
import { loadRelations } from '../relations/eager.js';
import HasOne from '../relations/HasOne.js';
import HasMany from '../relations/HasMany.js';
import BelongsTo from '../relations/BelongsTo.js';
import BelongsToMany from '../relations/BelongsToMany.js';

class Model {
  // ============================================================ 静态配置默认值
  static get table() {
    return tableNameFromClass(this.name || 'model');
  }

  static get pk() {
    return 'id';
  }

  static get connection() {
    return manager.defaultName;
  }

  static get timestamps() {
    return false;
  }

  static get createTime() {
    return 'create_time';
  }

  static get updateTime() {
    return 'update_time';
  }

  static get timestampType() {
    return 'datetime';
  }

  static get softDelete() {
    return false;
  }

  static get softDeleteDefault() {
    return null;
  }

  static get hidden() {
    return [];
  }

  static get visible() {
    return [];
  }

  static get appends() {
    return [];
  }

  static get casts() {
    return {};
  }

  static get getters() {
    return {};
  }

  static get setters() {
    return {};
  }

  // ============================================================ 静态：连接 / 查询
  /** 连接名（字符串） */
  static get connectionName() {
    return this.connection;
  }

  /** 当前模型的连接实例 */
  static getConnection() {
    return manager.get(this.connection);
  }

  /** 表名（必填校验） */
  static getTable() {
    const table = this.table;
    if (!table || typeof table !== 'string') {
      throw new ModelError(`模型 ${this.name} 缺少 table 配置`);
    }
    return table;
  }

  /** 构造绑定该模型的查询 */
  static query() {
    ModelEvent.ensureBooted(this);
    return new ModelQuery(this, this.getConnection());
  }

  /** 行 → 实例 */
  static hydrate(row) {
    return new this(row || {}, true);
  }

  /** 软删除字段（false 表示未启用） */
  static getSoftDeleteField() {
    return SoftDelete.getSoftDeleteField(this);
  }

  /** 创建时间字段名 */
  static getCreateTimeField() {
    return this.createTime;
  }

  /** 更新时间字段名 */
  static getUpdateTimeField() {
    return this.updateTime;
  }

  /** 记录是否已存在 */
  static isExists() {
    return true;
  }

  // ============================================================ 静态：执行方法
  static async find(id) {
    return this.query().find(id);
  }

  static async findOrFail(id) {
    return this.query().findOrFail(id);
  }

  static async select(...fields) {
    return this.query().select(...fields);
  }

  static async all() {
    return this.query().select();
  }

  static async first(...fields) {
    return this.query().first(...fields);
  }

  static async value(field) {
    return this.query().value(field);
  }

  static async column(field) {
    return this.query().column(field);
  }

  static async count(field = '*', distinct = false) {
    return this.query().count(field, distinct);
  }

  static async sum(field) {
    return this.query().sum(field);
  }

  static async max(field) {
    return this.query().max(field);
  }

  static async min(field) {
    return this.query().min(field);
  }

  static async avg(field) {
    return this.query().avg(field);
  }

  static async exists() {
    return this.query().exists();
  }

  static async insert(data) {
    return this.query().insert(data);
  }

  static async insertAll(rows) {
    return this.query().insertAll(rows);
  }

  static async insertGetId(data) {
    return this.query().insertGetId(data);
  }

  /**
   * 新建并保存实例
   * @param {object} data
   * @returns {Promise<Model>}
   */
  static async create(data = {}) {
    const instance = new this(data);
    await instance.save();
    return instance;
  }

  /** 批量新建（自动补时间戳） */
  static async createMany(rows = []) {
    const prepared = rows.map((row) => {
      const data = { ...row };
      Timestamp.applyInsert(this, data);
      SoftDelete.fillDefaults(this, data);
      return data;
    });
    await this.query().insertAll(prepared);
    return prepared.map((row) => this.hydrate(row));
  }

  /** 批量更新（不带 where 时更新全表，调用方需自行确认） */
  static async update(data) {
    return this.query().update(data);
  }

  /** 批量删除（软删除模型自动改写为 UPDATE） */
  static async delete() {
    return this.query().delete();
  }

  /** 按主键批量删除 */
  static async destroy(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    if (list.length === 0) return { affectedRows: 0, insertId: null, changedRows: 0 };
    return this.query().whereIn(this.pk, list).delete();
  }

  /** 分页 */
  static async paginate(page, perPage) {
    return this.query().paginate(page, perPage);
  }

  /** 分块 */
  static async chunk(size, callback) {
    return this.query().chunk(size, callback);
  }

  /** 游标迭代 */
  static cursor(size) {
    return this.query().cursor(size);
  }

  /** 事务（同连接嵌套自动 savepoint） */
  static async transaction(cb) {
    return this.getConnection().transaction(cb);
  }

  /** 注册模型事件 */
  static on(event, handler) {
    ModelEvent.on(this, event, handler);
    return this;
  }

  /** 取消事件 */
  static off(event, handler) {
    ModelEvent.off(this, event, handler);
    return this;
  }

  /** 首次使用时执行一次（子类可覆盖） */
  static boot() {
    /* 默认空实现 */
  }

  // ============================================================ 静态：关联定义
  /**
   * hasOne：目标表外键指向当前模型
   * @param {Function} Target 目标模型类
   * @param {string} [foreignKey] 目标表外键，默认 `<当前模型名>_id`
   * @param {string} [localKey] 当前模型键，默认主键
   * @param {string} [name] 关联名，默认目标类名小写
   */
  static hasOne(Target, foreignKey, localKey, name) {
    const fk = foreignKey || `${snakeCase(this.name)}_${this.pk}`;
    const relation = new HasOne(this, Target, {
      foreignKey: fk,
      localKey: localKey || this.pk,
    });
    return defineRelation(this, name || camelCase(Target.name), relation);
  }

  /** hasMany：目标表外键指向当前模型（多条） */
  static hasMany(Target, foreignKey, localKey, name) {
    const fk = foreignKey || `${snakeCase(this.name)}_${this.pk}`;
    const relation = new HasMany(this, Target, {
      foreignKey: fk,
      localKey: localKey || this.pk,
    });
    return defineRelation(this, name || pluralName(Target.name), relation);
  }

  /** belongsTo：当前模型外键指向目标表 */
  static belongsTo(Target, foreignKey, ownerKey, name) {
    const fk = foreignKey || `${snakeCase(Target.name)}_${Target.pk || 'id'}`;
    const relation = new BelongsTo(this, Target, {
      foreignKey: fk,
      localKey: ownerKey || Target.pk || 'id',
    });
    return defineRelation(this, name || camelCase(Target.name), relation);
  }

  /** belongsToMany：中间表多对多 */
  static belongsToMany(Target, pivot, foreignPivotKey, relatedPivotKey, name) {
    const relation = new BelongsToMany(this, Target, pivot, foreignPivotKey, relatedPivotKey, {
      parentKey: this.pk,
      relatedKey: Target.pk,
    });
    return defineRelation(this, name || pluralName(Target.name), relation);
  }

  // ============================================================ 实例
  /**
   * @param {object} data 初始数据
   * @param {boolean} exists 是否来自数据库
   */
  constructor(data = {}, exists = false) {
    this._relations = {};
    this._pivot = null;
    this._hidden = [];
    this._visible = [];
    this._appends = [];
    this._trashed = false;

    if (exists) {
      // 来自数据库的行：保持原始值，读取时再 cast
      this._data = { ...data };
      this._trashed = SoftDelete.isTrashed(this.constructor, this);
    } else {
      // 用户态数据：写入时执行 setter/cast（如 json 字段序列化）
      this._data = {};
      for (const [key, value] of Object.entries(data)) {
        this._data[key] = Attribute.castSet(this.constructor, key, value, this);
      }
    }

    this._origin = deepClone(this._data);
    this._exists = Boolean(exists);
  }

  /** 读取属性（cast + getter） */
  get(key) {
    if (key === undefined) return this._data;
    return Attribute.castGet(this.constructor, key, this._data[key], this);
  }

  /** 原始值（跳过 getter/cast），用于脏检查与持久化 */
  getRaw(key) {
    return key === undefined ? this._data : this._data[key];
  }

  /** 全部原始数据副本 */
  getData() {
    return { ...this._data };
  }

  /** 写入属性：set(key, value) 或 set({a:1,b:2}) */
  set(key, value) {
    if (key && typeof key === 'object') {
      for (const [field, val] of Object.entries(key)) this.set(field, val);
      return this;
    }
    if (typeof key !== 'string') throw new ModelError('set 需要字段名');
    this._data[key] = Attribute.castSet(this.constructor, key, value, this);
    return this;
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this._data, key);
  }

  /** 是否已持久化 */
  isExists() {
    return this._exists;
  }

  /** 关联中间行（belongsToMany 预载入时附带） */
  getPivot() {
    return this._pivot;
  }

  /** 设置隐藏字段（实例级） */
  hidden(...fields) {
    this._hidden.push(...fields.flat());
    return this;
  }

  /** 设置可见字段（实例级，优先级高于 hidden） */
  visible(...fields) {
    this._visible.push(...fields.flat());
    return this;
  }

  /** 追加序列化属性 */
  append(...fields) {
    this._appends.push(...fields.flat());
    return this;
  }

  /** 序列化为普通对象 */
  toArray() {
    return Attribute.toArray(this.constructor, this);
  }

  toJSON() {
    return this.toArray();
  }

  // ============================================================ 实例：持久化
  /**
   * 保存（设计文档 3.5.4 时序）
   * 未持久化：beforeSave → beforeInsert → 补时间戳 → INSERT → 回填 pk → afterInsert → afterSave
   * 已持久化：脏检查 → beforeSave → beforeUpdate → 补 updateTime → UPDATE → 同步 origin → afterUpdate → afterSave
   */
  async save() {
    return this._exists ? this._updateExisting() : this._insertNew();
  }

  async _insertNew() {
    const Model = this.constructor;
    const pk = Model.pk;

    ModelEvent.emit(Model, 'beforeSave', this);
    ModelEvent.emit(Model, 'beforeInsert', this);

    const data = { ...this._data };
    Timestamp.applyInsert(Model, data);
    SoftDelete.fillDefaults(Model, data);

    const result = await Model.query().insert(data);
    // 回填自增主键（显式提供主键时保留）
    if ((this._data[pk] === undefined || this._data[pk] === null) && result.insertId) {
      data[pk] = result.insertId;
    }
    if (data[pk] !== undefined) this._data[pk] = data[pk];

    // 以实际写入的数据作为新基线
    for (const [key, value] of Object.entries(data)) {
      if (this._data[key] === undefined) this._data[key] = value;
    }

    this._origin = deepClone(this._data);
    this._exists = true;
    this._trashed = false;

    ModelEvent.emit(Model, 'afterInsert', this);
    ModelEvent.emit(Model, 'afterSave', this);
    return this;
  }

  async _updateExisting() {
    const Model = this.constructor;
    const pk = Model.pk;
    const pkValue = this._data[pk];

    if (pkValue === undefined || pkValue === null) {
      throw new ModelError(`模型 ${Model.name} 更新时缺少主键 ${pk}`);
    }

    if (this._dirtyFields().length === 0) return this;

    ModelEvent.emit(Model, 'beforeSave', this);
    ModelEvent.emit(Model, 'beforeUpdate', this);

    // 事件处理器可能改写数据，重新计算脏字段
    const fields = this._dirtyFields();
    if (fields.length === 0) return this;

    const data = {};
    for (const field of fields) data[field] = this._data[field];
    Timestamp.applyUpdate(Model, data);

    await Model.query().where(pk, pkValue).update(data);

    // 同步数据库侧补齐的字段（如 update_time），避免实例读到旧值
    for (const [key, value] of Object.entries(data)) this._data[key] = value;

    this._origin = deepClone(this._data);
    this._trashed = SoftDelete.isTrashed(Model, this);
    ModelEvent.emit(Model, 'afterUpdate', this);
    ModelEvent.emit(Model, 'afterSave', this);
    return this;
  }

  /** 计算脏字段（跳过主键） */
  _dirtyFields() {
    const pk = this.constructor.pk;
    const fields = [];
    for (const key of Object.keys(this._data)) {
      if (key === pk) continue;
      if (!isEqual(this._data[key], this._origin[key])) fields.push(key);
    }
    return fields;
  }

  /**
   * 删除
   * @param {{force?: boolean}} [options] force=true 时物理删除（即使启用软删除）
   */
  async delete(options = {}) {
    const Model = this.constructor;
    if (!this._exists) return { affectedRows: 0, insertId: null, changedRows: 0 };

    const pkValue = this._data[Model.pk];
    ModelEvent.emit(Model, 'beforeDelete', this);

    let result;
    const softField = Model.getSoftDeleteField();
    if (softField && !options.force) {
      const value = SoftDelete.deletedValue(Model);
      result = await Model.query().where(Model.pk, pkValue).update({ [softField]: value });
      this._data[softField] = value;
      this._origin[softField] = value;
      this._trashed = true;
    } else {
      result = await Model.query().where(Model.pk, pkValue).forceDelete();
      this._exists = false;
    }

    ModelEvent.emit(Model, 'afterDelete', this);
    return result;
  }

  /**
   * 批量更新（先合并到实例再 save）
   */
  async update(data = {}) {
    for (const [key, value] of Object.entries(data)) this.set(key, value);
    return this.save();
  }

  /** 恢复软删除记录 */
  async restore() {
    const Model = this.constructor;
    const softField = Model.getSoftDeleteField();
    if (!softField) throw new ModelError(`模型 ${Model.name} 未启用软删除`);

    const pkValue = this._data[Model.pk];
    const value = SoftDelete.restoredValue(Model);
    await Model.query().withTrashed().where(Model.pk, pkValue).update({ [softField]: value });
    this._data[softField] = value;
    this._origin[softField] = value;
    this._trashed = false;
    return this;
  }

  /** 从数据库刷新当前实例 */
  async refresh() {
    const Model = this.constructor;
    const row = await Model.query().withTrashed().where(Model.pk, this._data[Model.pk]).first();
    if (!row) throw new ModelNotFoundException(`记录不存在：${Model.pk} = ${this._data[Model.pk]}`);
    this._data = { ...row._data };
    this._origin = deepClone(row._data);
    this._relations = row._relations;
    this._exists = true;
    this._trashed = row._trashed;
    return this;
  }

  /** 懒加载关联 */
  async load(...relations) {
    await loadRelations([this], flattenRelationArgs(relations), this.constructor);
    return this;
  }

  /** 字段自增并同步本地值 */
  async setInc(field, amount = 1) {
    await this.constructor.query().where(this.constructor.pk, this._data[this.constructor.pk]).setInc(field, amount);
    this._data[field] = Number(this._data[field] || 0) + Number(amount);
    this._origin[field] = this._data[field];
    return this;
  }

  /** 字段自减并同步本地值 */
  async setDec(field, amount = 1) {
    await this.constructor.query().where(this.constructor.pk, this._data[this.constructor.pk]).setDec(field, amount);
    this._data[field] = Number(this._data[field] || 0) - Number(amount);
    this._origin[field] = this._data[field];
    return this;
  }

  /** 已删除标记 */
  trashed() {
    return this._trashed;
  }
}

// ============================================================ 静态链式转发（ADR-06）
/** 链式方法：返回 this.query()[method](...args)，this 指向调用子类 */
const CHAIN_METHODS = [
  'where',
  'whereOr',
  'whereIn',
  'whereNotIn',
  'whereNull',
  'whereNotNull',
  'whereBetween',
  'whereNotBetween',
  'whereLike',
  'whereRaw',
  'order',
  'field',
  'fieldRaw',
  'limit',
  'offset',
  'page',
  'join',
  'leftJoin',
  'rightJoin',
  'group',
  'having',
  'havingRaw',
  'alias',
  'distinct',
  'lock',
  'with',
  'withTrashed',
  'onlyTrashed',
  'fetchSql',
  'useWrite',
];

for (const method of CHAIN_METHODS) {
  Model[method] = function forwarded(...args) {
    return this.query()[method](...args);
  };
}

// ============================================================ 辅助
/** 目标类名 → 默认复数关联名：Comment -> comments */
function pluralName(className) {
  const base = camelCase(className);
  if (/[^aeiou]y$/i.test(base)) return base.replace(/y$/i, 'ies');
  if (/(s|x|z|ch|sh)$/i.test(base)) return `${base}es`;
  return `${base}s`;
}

/** 关联参数归一：可选字符串或数组 */
function flattenRelationArgs(items) {
  const out = [];
  for (const item of items) {
    if (Array.isArray(item)) out.push(...flattenRelationArgs(item));
    else if (typeof item === 'string' && item.trim()) out.push(item.trim());
  }
  return out;
}

/** 值比较（Date / 普通值） */
function isEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export default Model;
