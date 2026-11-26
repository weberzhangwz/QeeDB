'use strict';

/**
 * Query 链式状态机（设计文档 3.4）
 * ------------------------------------------------------------------
 * 设计要点：
 *  - 单一数据源 _state，链式方法只改状态，不产生 IO
 *  - 执行方法：状态 → Builder.buildX → Connection.query/execute → 水合
 *  - where AST（3.4.2）在此归一，Builder 只负责翻译，不做语义判断
 *  - 值全部走 bindings；标识符进入 Builder 前均经过白名单转义
 *  - ADR-02：Query 可变链式、一次执行；需要复用请 clone()
 */

import { isPlainObject, deepClone } from '../utils/helpers.js';
import { InvalidQueryError, ModelNotFoundException } from '../exceptions/index.js';

/** 允许的比较运算符（与 Builder 白名单保持一致，用于把 where 参数归一为 AST） */
const COMPARATORS = new Set([
  '=',
  '==',
  '<>',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'LIKE',
  'NOT LIKE',
  'REGEXP',
  'IS',
  'IS NOT',
  'BETWEEN',
  'IN',
  'NOT IN',
]);

/** 批量写单批上限（设计文档 7：insertAll 按 500 条/批） */
const INSERT_BATCH_SIZE = 500;

/** 默认分页大小 */
const DEFAULT_PER_PAGE = 15;

class Query {
  /**
   * @param {object} connection 具备 query/execute/builder 的连接对象
   */
  constructor(connection) {
    if (!connection || typeof connection.query !== 'function') {
      throw new InvalidQueryError('Query 需要一个 Connection 实例');
    }
    this.connection = connection;
    /** @type {object} 查询状态（单一数据源） */
    this._state = createState();
  }

  // ============================================================ 状态构造
  /**
   * 设置表名
   * @param {string} table
   * @param {string} [alias]
   */
  table(table, alias) {
    this._state.table = table;
    if (alias) this._state.alias = alias;
    return this;
  }

  /** 设置别名 */
  alias(alias) {
    this._state.alias = alias;
    return this;
  }

  /**
   * 指定查询字段（覆盖式，与 ThinkORM field() 语义一致）
   * 支持：
   *   field('id','name')
   *   field(['id','name'])
   *   field('name as username')
   *   field('a.b as c')
   */
  field(...fields) {
    this._state.fields = normalizeFields(fields);
    return this;
  }

  /**
   * SELECT 字段（与 field 等价，select 作为执行入口时也可传字段）
   */
  selectFields(...fields) {
    return this.field(...fields);
  }

  /**
   * 原样表达式字段（显式承担 SQL 注入责任，别名仍会转义）
   * 例：fieldRaw('COUNT(*)', 'total')
   */
  fieldRaw(expr, alias) {
    if (typeof expr !== 'string' || !expr.trim()) {
      throw new InvalidQueryError('fieldRaw 的表达式不能为空');
    }
    this._state.fields.push({ raw: true, expr, alias });
    return this;
  }

  /** 是否去重；传字段数组时等价于 field(...).distinct()（MySQL 语法） */
  distinct(value = true) {
    if (Array.isArray(value)) {
      this._state.fields = normalizeFields(value);
      this._state.distinct = true;
    } else {
      this._state.distinct = Boolean(value);
    }
    return this;
  }

  // ============================================================ WHERE
  /**
   * 通用条件，支持多种写法：
   *   where('id', 1)                  → `id` = ?
   *   where('age', '>', 18)           → `age` > ?
   *   where({ status: 1, name: 'a' }) → AND 组合
   *   where({ age: ['>', 18] })       → 运算符数组
   *   where({ age: { '>': 18, '<': 30 } })
   *   where({ deleted_at: null })
   *   where([['a', '=', 1], ['b', 2]])
   *   where('a = 1')                  → 直接抛错（ADR-04）
   */
  where(...args) {
    return this._addWhere(args, 'AND');
  }

  /** OR 条件，写法同 where */
  whereOr(...args) {
    return this._addWhere(args, 'OR');
  }

  /** IN 集合（空数组折叠为恒假） */
  whereIn(field, values, boolean = 'AND') {
    this._pushWhere({ type: 'in', boolean, field, values: toArray(values) });
    return this;
  }

  /** NOT IN 集合（空数组折叠为恒真） */
  whereNotIn(field, values, boolean = 'AND') {
    this._pushWhere({ type: 'notin', boolean, field, values: toArray(values) });
    return this;
  }

  whereNull(field, boolean = 'AND') {
    this._pushWhere({ type: 'null', boolean, field });
    return this;
  }

  whereNotNull(field, boolean = 'AND') {
    this._pushWhere({ type: 'notnull', boolean, field });
    return this;
  }

  whereBetween(field, min, max, boolean = 'AND') {
    this._pushWhere({ type: 'between', boolean, field, min, max });
    return this;
  }

  whereNotBetween(field, min, max, boolean = 'AND') {
    this._pushWhere({ type: 'notbetween', boolean, field, min, max });
    return this;
  }

  /** LIKE 条件（通配符由调用方负责，如 '%foo%'） */
  whereLike(field, pattern, boolean = 'AND') {
    this._pushWhere({ type: 'basic', boolean, field, op: 'LIKE', value: pattern });
    return this;
  }

  /**
   * 原样条件（唯一允许拼接 SQL 条件的入口，显式使用）
   * @param {string} sql
   * @param {any[]} [bindings]
   */
  whereRaw(sql, bindings = [], boolean = 'AND') {
    if (typeof sql !== 'string' || !sql.trim()) {
      throw new InvalidQueryError('whereRaw 的 SQL 不能为空');
    }
    this._pushWhere({ type: 'raw', boolean, sql, bindings: toArray(bindings) });
    return this;
  }

  // ============================================================ JOIN / GROUP / HAVING
  /**
   * JOIN。推荐显式限定字段名：
   *   join('comments', 'posts.id', 'comments.post_id')
   *   leftJoin('comments', 'posts.id', '=', 'comments.post_id')
   *   join('comments', 'posts.id = comments.post_id')   // 原样条件（显式）
   */
  join(table, left, op, right, type = 'INNER') {
    this._state.join.push(normalizeJoin(table, left, op, right, type));
    return this;
  }

  leftJoin(table, left, op, right) {
    return this.join(table, left, op, right, 'LEFT');
  }

  rightJoin(table, left, op, right) {
    return this.join(table, left, op, right, 'RIGHT');
  }

  /** GROUP BY，支持多个字段或数组 */
  group(...fields) {
    for (const field of flatten(fields)) this._state.group.push({ name: field });
    return this;
  }

  /** HAVING，参数语义同 where */
  having(...args) {
    const nodes = normalizeWhereArgs(args, 'AND');
    this._state.having.push(...nodes);
    return this;
  }

  havingRaw(sql, bindings = [], boolean = 'AND') {
    this._state.having.push({ type: 'raw', boolean, sql, bindings: toArray(bindings) });
    return this;
  }

  // ============================================================ ORDER / LIMIT
  /**
   * 排序：
   *   order('id','desc')
   *   order('id desc')
   *   order({ id: 'desc', name: 'asc' })
   *   order(['id desc','name asc'])
   */
  order(field, direction) {
    if (Array.isArray(field)) {
      for (const item of field) this.order(item);
      return this;
    }
    if (isPlainObject(field)) {
      for (const [key, dir] of Object.entries(field)) this.order(key, dir);
      return this;
    }
    if (typeof field !== 'string' || !field.trim()) {
      throw new InvalidQueryError('order 需要字段名');
    }

    let name = field.trim();
    let dir = direction;
    if (!dir) {
      const matched = name.match(/^(.*?)\s+(asc|desc)$/i);
      if (matched) {
        name = matched[1];
        dir = matched[2];
      }
    }
    this._state.order.push({
      field: name,
      direction: String(dir || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
    });
    return this;
  }

  /**
   * 限制条数
   * @param {number} limit
   * @param {number} [offset]
   */
  limit(limit, offset) {
    this._state.limit = Number(limit);
    if (offset !== undefined) this._state.offset = Number(offset);
    return this;
  }

  offset(offset) {
    this._state.offset = Number(offset);
    return this;
  }

  /** 页码分页：page(2, 10) → LIMIT 10 OFFSET 10 */
  page(page, perPage = DEFAULT_PER_PAGE) {
    const current = Math.max(1, Number(page) || 1);
    const size = Math.max(1, Number(perPage) || DEFAULT_PER_PAGE);
    this._state.limit = size;
    this._state.offset = (current - 1) * size;
    return this;
  }

  /** 加锁：'update' | 'share' */
  lock(mode = 'update') {
    this._state.lock = mode;
    return this;
  }

  /** 预载入关联，支持 'posts'、'posts.comments' 或多参数/数组 */
  with(...relations) {
    for (const rel of flatten(relations)) {
      if (typeof rel === 'string' && rel.trim() && !this._state.with.includes(rel.trim())) {
        this._state.with.push(rel.trim());
      }
    }
    return this;
  }

  /** 软删除作用域（ModelQuery 使用） */
  withTrashed() {
    this._state.softDelete = 'with';
    return this;
  }

  onlyTrashed() {
    this._state.softDelete = 'only';
    return this;
  }

  /** 设置后执行方法只返回 { sql, bindings }，不触库（DEBUG 用） */
  fetchSql(value = true) {
    this._state.fetchSql = Boolean(value);
    return this;
  }

  /** 标记走主库（预留读写分离；v1.0 由 Adapter 主池执行） */
  useWrite(value = true) {
    this._state.useWrite = Boolean(value);
    return this;
  }

  /** 克隆查询状态（ADR-02：需要重复执行时使用，保留 ModelQuery 子类语义） */
  clone() {
    const cloned = Object.create(Object.getPrototypeOf(this));
    this.connection && (cloned.connection = this.connection);
    cloned._state = deepCloneState(this._state);
    // 复制子类扩展属性（如 ModelQuery.ModelClass），保持行为一致
    for (const key of Object.keys(this)) {
      if (key === '_state' || key === 'connection') continue;
      cloned[key] = this[key];
    }
    return cloned;
  }

  // ============================================================ 执行：读
  /**
   * 查询多行
   * @param {...string} [fields] 可选，等价于 field()
   */
  async select(...fields) {
    if (fields.length) this.field(...fields);
    const state = this._prepareState();
    const built = this.connection.getBuilder().buildSelect(state);
    if (this._state.fetchSql) return built;

    const rows = await this.connection.query(built.sql, built.bindings);
    const hydrated = this._hydrate(rows, state);
    return this._afterFetch(hydrated, state);
  }

  /** 查询全部（select 的别名） */
  async all() {
    return this.select();
  }

  /**
   * 查询单条
   * @param {string[]} [fields]
   */
  async first(...fields) {
    if (fields.length) this.field(...fields);
    this._state.limit = 1;
    const rows = await this.select();
    return rows.length ? rows[0] : null;
  }

  /**
   * 按主键查询
   * @param {any} id
   */
  async find(id) {
    const pk = this._pk();
    if (Array.isArray(id)) return this.whereIn(pk, id).select();
    return this.where(pk, id).first();
  }

  /** 按主键查询，不存在则抛 ModelNotFoundException */
  async findOrFail(id) {
    const row = await this.find(id);
    if (!row) {
      throw new ModelNotFoundException(`记录不存在：${this._pk()} = ${id}`);
    }
    return row;
  }

  /** 取单个字段值（不做水合） */
  async value(field) {
    const state = this._prepareState();
    const built = this.connection.getBuilder().buildSelect({
      ...state,
      fields: [{ name: field }],
      limit: 1,
      offset: null,
    });
    if (this._state.fetchSql) return built;
    const rows = await this.connection.query(built.sql, built.bindings);
    if (!rows.length) return null;
    const key = String(field).includes('.') ? String(field).split('.').pop() : field;
    return rows[0][key];
  }

  /** 取某列数组 */
  async column(field) {
    const state = this._prepareState();
    const built = this.connection.getBuilder().buildSelect({
      ...state,
      fields: [{ name: field }],
    });
    if (this._state.fetchSql) return built;
    const rows = await this.connection.query(built.sql, built.bindings);
    const key = String(field).includes('.') ? String(field).split('.').pop() : field;
    return rows.map((row) => row[key]);
  }

  // ============================================================ 执行：聚合
  /** COUNT（distinct 由 state.distinct 决定） */
  async count(field = '*', distinct = false) {
    return this._aggregate('COUNT', field, Boolean(distinct || this._state.distinct));
  }

  async sum(field) {
    return this._aggregate('SUM', field);
  }

  async max(field) {
    return this._aggregate('MAX', field);
  }

  async min(field) {
    return this._aggregate('MIN', field);
  }

  async avg(field) {
    return this._aggregate('AVG', field);
  }

  /** 是否存在满足条件的记录 */
  async exists() {
    const state = this._prepareState();
    const built = this.connection.getBuilder().buildExists(state);
    if (this._state.fetchSql) return built;
    const rows = await this.connection.query(built.sql, built.bindings);
    return rows.length > 0;
  }

  // ============================================================ 执行：写
  /**
   * 插入单行
   * @param {object} data
   * @returns {Promise<{affectedRows:number, insertId:any, changedRows:number}>}
   */
  async insert(data) {
    if (!isPlainObject(data)) throw new InvalidQueryError('insert 需要普通对象');
    const state = this._prepareState();
    state.data = data;
    const built = this.connection.getBuilder().buildInsert(state);
    if (this._state.fetchSql) return built;
    return this.connection.execute(built.sql, built.bindings);
  }

  /** 插入并返回自增主键 */
  async insertGetId(data) {
    const result = await this.insert(data);
    return result.insertId;
  }

  /**
   * 批量插入（自动分批 500 条）
   * @param {object[]} rows
   */
  async insertAll(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new InvalidQueryError('insertAll 需要非空数组');
    }
    if (this._state.fetchSql) {
      const state = this._prepareState();
      state.data = rows;
      return this.connection.getBuilder().buildInsertAll(state);
    }

    const total = { affectedRows: 0, insertId: null, changedRows: 0 };
    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
      const state = this._prepareState();
      state.data = batch;
      const built = this.connection.getBuilder().buildInsertAll(state);
      const result = await this.connection.execute(built.sql, built.bindings);
      total.affectedRows += result.affectedRows;
      total.changedRows += result.changedRows || 0;
      if (i === 0) total.insertId = result.insertId;
    }
    return total;
  }

  /**
   * 更新
   * @param {object} data 支持 { field: {__qeeOp:'inc', value:1} } 形式的自增
   */
  async update(data) {
    if (!isPlainObject(data)) throw new InvalidQueryError('update 需要普通对象');
    const state = this._prepareState();
    state.data = data;
    const built = this.connection.getBuilder().buildUpdate(state);
    if (this._state.fetchSql) return built;
    return this.connection.execute(built.sql, built.bindings);
  }

  /** 字段自增（原子 SQL：`field` = `field` + ?） */
  async setInc(field, amount = 1) {
    return this.update({ [field]: { __qeeOp: 'inc', value: Number(amount) } });
  }

  /** 字段自减 */
  async setDec(field, amount = 1) {
    return this.update({ [field]: { __qeeOp: 'dec', value: Number(amount) } });
  }

  /** 删除（ModelQuery 会覆盖为软删除） */
  async delete() {
    const state = this._prepareState();
    const built = this.connection.getBuilder().buildDelete(state);
    if (this._state.fetchSql) return built;
    return this.connection.execute(built.sql, built.bindings);
  }

  // ============================================================ 分页 / 批处理
  /**
   * 分页查询
   * @param {number} [pageNo]
   * @param {number} [perPage]
   * @returns {Promise<{data:any[], total:number, per_page:number, current_page:number, last_page:number, has_more:boolean}>}
   */
  async paginate(pageNo = 1, perPage = DEFAULT_PER_PAGE) {
    const current = Math.max(1, Number(pageNo) || 1);
    const size = Math.max(1, Number(perPage) || DEFAULT_PER_PAGE);

    const total = await this.clone().count('*');
    const data = await this.clone().limit(size, (current - 1) * size).select();
    const lastPage = total === 0 ? 1 : Math.ceil(total / size);

    return {
      data,
      total,
      per_page: size,
      current_page: current,
      last_page: lastPage,
      has_more: current < lastPage,
    };
  }

  /**
   * 分块处理（避免一次性载入）
   * @param {number} size 每块条数
   * @param {(rows:any[], page:number)=>Promise<any>|any} callback 返回 false 提前终止
   */
  async chunk(size, callback) {
    if (typeof callback !== 'function') throw new InvalidQueryError('chunk 需要回调函数');
    const batch = Math.max(1, Number(size) || 100);
    let pageNo = 1;
    while (true) {
      const rows = await this.clone().limit(batch, (pageNo - 1) * batch).select();
      if (!rows.length) break;
      const result = await callback(rows, pageNo);
      if (result === false) break;
      if (rows.length < batch) break;
      pageNo += 1;
    }
    return this;
  }

  /**
   * 游标：v1.0 以分页游标实现（非流式），接口形态与后续流式版本保持一致
   * @param {number} [size]
   */
  async *cursor(size = 100) {
    const batch = Math.max(1, Number(size) || 100);
    let pageNo = 1;
    while (true) {
      const rows = await this.clone().limit(batch, (pageNo - 1) * batch).select();
      if (!rows.length) break;
      for (const row of rows) yield row;
      if (rows.length < batch) break;
      pageNo += 1;
    }
  }

  /** 调试：返回可读 SQL（绑定值内联，仅用于日志，勿用于执行） */
  toSql() {
    const built = this.connection.getBuilder().buildSelect(this._prepareState());
    return interpolate(built.sql, built.bindings);
  }

  /** 当前状态快照（只读副本） */
  getState() {
    return deepCloneState(this._state);
  }

  // ============================================================ 内部
  /**
   * 送入 Builder 前的最终状态（钩子）
   * ModelQuery 覆盖此方法以注入软删除作用域
   */
  _prepareState() {
    return this._state;
  }

  /** 结果水合（钩子） */
  _hydrate(rows) {
    return rows;
  }

  /** 取回后处理（钩子，ModelQuery 用于 with 预载入） */
  async _afterFetch(rows) {
    return rows;
  }

  async _aggregate(fn, field, distinct = false) {
    const state = this._prepareState();
    const built = this.connection.getBuilder().buildAggregate(
      { ...state, distinct },
      fn,
      field,
    );
    if (this._state.fetchSql) return built;
    const rows = await this.connection.query(built.sql, built.bindings);
    if (!rows.length) return fn === 'COUNT' ? 0 : null;
    const value = rows[0].qee_agg !== undefined ? rows[0].qee_agg : Object.values(rows[0])[0];
    if (fn === 'COUNT') return Number(value || 0);
    return value === undefined ? null : value;
  }

  /** where 归一入口 */
  _addWhere(args, boolean) {
    const nodes = normalizeWhereArgs(args, boolean);
    for (const node of nodes) this._pushWhere(node);
    return this;
  }

  _pushWhere(node) {
    this._state.where.push(node);
  }

  /** 主键名（ModelQuery 覆盖为模型 pk） */
  _pk() {
    return this._state.model ? this._state.model.pk || 'id' : 'id';
  }
}

// ============================================================ 纯函数工具
/** 初始状态 */
function createState() {
  return {
    table: null,
    alias: null,
    fields: [],
    distinct: false,
    where: [],
    join: [],
    order: [],
    group: [],
    having: [],
    limit: null,
    offset: null,
    lock: null,
    union: [],
    with: [],
    softDelete: 'auto',
    useWrite: false,
    fetchSql: false,
    model: null,
    data: null,
  };
}

/** 字段归一：字符串/数组/对象都展开为 { name } | { raw } */
function normalizeFields(fields) {
  const out = [];
  for (const field of flatten(fields)) {
    if (typeof field === 'string') {
      if (!field.trim()) throw new InvalidQueryError('field 不能为空字符串');
      out.push({ name: field.trim() });
    } else if (isPlainObject(field)) {
      if (field.raw) out.push({ raw: true, expr: field.expr, alias: field.alias });
      else if (field.name) out.push({ name: field.name, alias: field.alias });
      else {
        for (const [name, alias] of Object.entries(field)) out.push({ name, alias });
      }
    } else {
      throw new InvalidQueryError(`不支持的 field 参数：${String(field)}`);
    }
  }
  return out;
}

/** where 参数 → AST 节点数组 */
function normalizeWhereArgs(args, boolean) {
  const first = args[0];

  if (typeof first === 'string') {
    if (args.length === 1) {
      // ADR-04：禁止字符串条件，避免拼接注入
      throw new InvalidQueryError(
        `where('${first}') 不支持字符串条件，请使用对象条件或 whereRaw(sql, bindings)`,
      );
    }
    if (args.length === 2) {
      return [basicNode(first, '=', args[1], boolean)];
    }
    return [basicNode(first, args[1], args[2], boolean)];
  }

  if (Array.isArray(first)) {
    // [['a','=',1], ['b',2]] 或 ['a', 1]
    if (Array.isArray(first[0])) {
      return first.flatMap((item) => normalizeWhereArgs(item, boolean));
    }
    return normalizeWhereArgs(first, boolean);
  }

  if (isPlainObject(first)) {
    return objectNodes(first, boolean);
  }

  throw new InvalidQueryError('where 需要字段名、对象或条件数组');
}

/** 单个 basic 节点（自动处理 IN / NULL 语义） */
function basicNode(field, op, value, boolean) {
  if (typeof field !== 'string' || !field.trim()) {
    throw new InvalidQueryError('where 字段必须是非空字符串');
  }
  const normalized = String(op === undefined || op === null ? '=' : op).trim();

  if (normalized === '==' ) return { type: 'basic', boolean, field, op: '=', value };
  const upper = normalized.toUpperCase();
  const mapped = upper === '==' ? '=' : upper;

  if (!COMPARATORS.has(mapped)) {
    throw new InvalidQueryError(`不支持的比较运算符：${op}（如需自定义请用 whereRaw）`);
  }

  if (mapped === 'IN' || mapped === 'NOT IN') {
    const values = Array.isArray(value) ? value : toArray(value);
    return {
      type: mapped === 'IN' ? 'in' : 'notin',
      boolean,
      field,
      values,
    };
  }
  if (mapped === 'IS' || (mapped === '=' && (value === null || value === undefined))) {
    return value === null || value === undefined
      ? { type: 'null', boolean, field }
      : { type: 'basic', boolean, field, op: '=', value };
  }
  if (mapped === 'IS NOT') {
    return { type: 'notnull', boolean, field };
  }
  return { type: 'basic', boolean, field, op: mapped, value };
}

/** 对象条件 → AST */
function objectNodes(obj, boolean) {
  const nodes = [];
  for (const [field, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      // ['>', 18] / [1,2,3]
      if (typeof value[0] === 'string' && COMPARATORS.has(value[0].toUpperCase())) {
        const op = value[0].toUpperCase();
        if (op === 'IN' || op === 'NOT IN') {
          nodes.push({ type: op === 'IN' ? 'in' : 'notin', boolean, field, values: value[1] });
        } else if (op === 'BETWEEN') {
          nodes.push({ type: 'between', boolean, field, min: value[1], max: value[2] });
        } else {
          nodes.push(basicNode(field, op, value[1], boolean));
        }
      } else if (value[0] !== undefined && typeof value[0] === 'string' && isOperatorToken(value[0])) {
        nodes.push(basicNode(field, value[0], value[1], boolean));
      } else {
        nodes.push({ type: 'in', boolean, field, values: value });
      }
    } else if (isPlainObject(value)) {
      for (const [op, operand] of Object.entries(value)) {
        if (op.toLowerCase() === 'between' && Array.isArray(operand)) {
          nodes.push({ type: 'between', boolean, field, min: operand[0], max: operand[1] });
        } else {
          nodes.push(basicNode(field, op, operand, boolean));
        }
      }
    } else if (value === null) {
      nodes.push({ type: 'null', boolean, field });
    } else {
      nodes.push({ type: 'basic', boolean, field, op: '=', value });
    }
  }
  return nodes;
}

/** 是否为运算符 token（如 like / not like） */
function isOperatorToken(token) {
  return typeof token === 'string' && COMPARATORS.has(token.toUpperCase());
}

/** UNION 支持在后续版本扩展，这里保留状态位 */

/** JOIN 归一 */
function normalizeJoin(table, left, op, right, type) {
  if (typeof table !== 'string' || !table.trim()) {
    throw new InvalidQueryError('join 需要表名');
  }
  // 三参数形式：join('comments', 'posts.id', 'comments.post_id')
  if (right === undefined) {
    if (typeof op === 'string' && op.trim()) {
      // 原样条件（显式）
      return { type, table: table.trim(), on: [{ type: 'raw', sql: op.trim() }] };
    }
    throw new InvalidQueryError('join 需要 ON 条件');
  }
  if (left === undefined || left === null) throw new InvalidQueryError('join 需要 ON 条件');

  const condition = {
    left: String(left),
    op: op || '=',
    right: String(right),
  };
  return { type, table: table.trim(), on: [condition] };
}

/** 单值/数组归一 */
function toArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.slice();
  if (value instanceof Set) return Array.from(value);
  return [value];
}

/** 打平一层数组 */
function flatten(items) {
  const out = [];
  for (const item of items) {
    if (Array.isArray(item)) out.push(...flatten(item));
    else out.push(item);
  }
  return out;
}

/** 深拷贝状态（AST 节点为普通对象） */
function deepCloneState(state) {
  return {
    ...state,
    fields: deepClone(state.fields),
    where: deepClone(state.where),
    join: deepClone(state.join),
    order: deepClone(state.order),
    group: deepClone(state.group),
    having: deepClone(state.having),
    union: deepClone(state.union),
    with: state.with.slice(),
  };
}

/** 绑定值内联（调试用） */
function interpolate(sql, bindings) {
  let index = 0;
  return sql.replace(/\?/g, () => {
    const value = bindings[index++];
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`;
    return `'${String(value).replace(/'/g, "\\'")}'`;
  });
}

export default Query;
export { createState, normalizeWhereArgs };
