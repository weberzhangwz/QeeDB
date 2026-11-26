'use strict';

/**
 * MySQL 方言 Builder（设计文档 3.2.2 / 3.2.3）
 * ------------------------------------------------------------------
 * 纯函数：不触碰连接、不读写状态；输入 state，输出 { sql, bindings }。
 * 生成的 SQL 顺序严格按文档 3.2.3：
 *   SELECT [DISTINCT] fields → FROM → JOIN → WHERE → GROUP BY → HAVING
 *   → ORDER BY → LIMIT/OFFSET → LOCK → UNION
 */

import Builder from './Builder.js';
import { escapeId } from '../utils/identifier.js';
import { InvalidQueryError } from '../exceptions/index.js';

/** 允许的比较运算符（白名单，防止把任意字符串拼进 SQL 结构位置） */
const COMPARATORS = new Set([
  '=',
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

/** 锁语义映射 */
const LOCKS = {
  update: ' FOR UPDATE',
  'for update': ' FOR UPDATE',
  share: ' FOR SHARE',
  'for share': ' FOR SHARE',
  'lock in share mode': ' LOCK IN SHARE MODE',
};

class MysqlBuilder extends Builder {
  constructor() {
    super();
    this.quote = '`';
  }

  // ---------------------------------------------------------------- 基础
  /** `a.b as c` → `a`.`b` AS `c` */
  escapeId(name) {
    return escapeId(name, this.quote);
  }

  /** MySQL 占位符恒为 ? */
  placeholder() {
    return '?';
  }

  // ---------------------------------------------------------------- SELECT
  /**
   * @param {object} state Query 状态
   * @returns {{sql: string, bindings: any[]}}
   */
  buildSelect(state) {
    const bindings = [];
    const distinct = state.distinct ? 'DISTINCT ' : '';

    let sql = `SELECT ${distinct}${this._buildFieldList(state.fields)}`;
    sql += this._from(state);

    // JOIN
    if (state.join && state.join.length) {
      sql += ' ' + state.join.map((join) => this._buildJoin(join)).join(' ');
    }

    // WHERE
    const where = this._buildWhereNodes(state.where);
    if (where.sql) {
      sql += ` WHERE ${where.sql}`;
      bindings.push(...where.bindings);
    }

    // GROUP BY
    if (state.group && state.group.length) {
      sql += ' GROUP BY ' + state.group.map((g) => this.escapeId(g.name || g)).join(', ');
    }

    // HAVING
    if (state.having && state.having.length) {
      const having = this._buildWhereNodes(state.having);
      if (having.sql) {
        sql += ` HAVING ${having.sql}`;
        bindings.push(...having.bindings);
      }
    }

    // ORDER BY
    if (state.order && state.order.length) {
      sql += ' ORDER BY ' + state.order
        .map((o) => `${this.escapeId(o.field)} ${o.direction === 'DESC' ? 'DESC' : 'ASC'}`)
        .join(', ');
    }

    // LIMIT / OFFSET（绑定值，不拼接数字）
    if (state.limit !== null && state.limit !== undefined) {
      sql += ' LIMIT ?';
      bindings.push(Number(state.limit));
      if (state.offset !== null && state.offset !== undefined) {
        sql += ' OFFSET ?';
        bindings.push(Number(state.offset));
      }
    } else if (state.offset !== null && state.offset !== undefined) {
      // MySQL 只允许 OFFSET 跟随 LIMIT，用极大值占位
      sql += ' LIMIT 18446744073709551615 OFFSET ?';
      bindings.push(Number(state.offset));
    }

    // LOCK
    if (state.lock) {
      const lock = LOCKS[String(state.lock).toLowerCase()];
      if (!lock) throw new InvalidQueryError(`不支持的锁类型：${state.lock}`);
      sql += lock;
    }

    // UNION
    if (state.union && state.union.length) {
      for (const item of state.union) {
        sql += ` UNION${item.all ? ' ALL' : ''} ${item.sql}`;
        bindings.push(...(item.bindings || []));
      }
    }

    return { sql, bindings };
  }

  // ---------------------------------------------------------------- INSERT
  buildInsert(state) {
    const data = state.data || {};
    const fields = state.fields && state.fields.length ? state.fields.map((f) => f.name || f) : Object.keys(data);
    if (!fields.length) throw new InvalidQueryError('insert 需要至少一个字段');

    const columns = fields.map((f) => this.escapeId(f)).join(', ');
    const placeholders = fields.map(() => this.placeholder()).join(', ');
    const bindings = fields.map((f) => data[f]);

    const sql = `INSERT INTO ${this.escapeId(state.table)} (${columns}) VALUES (${placeholders})`;
    return { sql, bindings };
  }

  buildInsertAll(state) {
    const rows = state.data || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new InvalidQueryError('insertAll 需要非空数组');
    }
    const fields = state.fields && state.fields.length ? state.fields.map((f) => f.name || f) : Object.keys(rows[0]);
    if (!fields.length) throw new InvalidQueryError('insertAll 需要至少一个字段');

    // 结构一致性校验：字段集合必须一致，避免生成错位的 VALUES
    for (const row of rows) {
      for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(row, field)) {
          throw new InvalidQueryError(`insertAll 各行列不一致，缺少字段：${field}`);
        }
      }
      if (Object.keys(row).length !== fields.length) {
        throw new InvalidQueryError('insertAll 各行列不一致，请统一字段集合');
      }
    }

    const columns = fields.map((f) => this.escapeId(f)).join(', ');
    const bindings = [];
    const values = rows
      .map((row) => `(${fields.map(() => this.placeholder()).join(', ')})`)
      .join(', ');
    for (const row of rows) {
      for (const field of fields) bindings.push(row[field]);
    }

    const sql = `INSERT INTO ${this.escapeId(state.table)} (${columns}) VALUES ${values}`;
    return { sql, bindings };
  }

  /** UPSERT：INSERT ... ON DUPLICATE KEY UPDATE */
  buildUpsert(state) {
    const { sql: insertSql, bindings } = this.buildInsert(state);
    const data = state.data || {};
    const fields = state.fields && state.fields.length ? state.fields.map((f) => f.name || f) : Object.keys(data);
    const pk = state.pk || 'id';
    const updateFields = state.updateFields || fields.filter((f) => f !== pk);
    if (!updateFields.length) throw new InvalidQueryError('upsert 没有可更新的字段');
    const sets = updateFields
      .map((f) => `${this.escapeId(f)} = VALUES(${this.escapeId(f)})`)
      .join(', ');
    return { sql: `${insertSql} ON DUPLICATE KEY UPDATE ${sets}`, bindings };
  }

  // ---------------------------------------------------------------- UPDATE
  buildUpdate(state) {
    const data = state.data || {};
    const fields = Object.keys(data);
    if (!fields.length) throw new InvalidQueryError('update 需要至少一个字段');

    const bindings = [];
    const sets = fields
      .map((field) => {
        const value = data[field];
        // setInc/setDec 的运算标记：生成 `f` = `f` + ?
        if (value && typeof value === 'object' && value.__qeeOp === 'inc') {
          bindings.push(value.value);
          return `${this.escapeId(field)} = ${this.escapeId(field)} + ?`;
        }
        if (value && typeof value === 'object' && value.__qeeOp === 'dec') {
          bindings.push(value.value);
          return `${this.escapeId(field)} = ${this.escapeId(field)} - ?`;
        }
        bindings.push(value);
        return `${this.escapeId(field)} = ?`;
      })
      .join(', ');

    let sql = `UPDATE ${this.escapeId(state.table)}`;
    if (state.alias) sql += ` AS ${this.escapeId(state.alias)}`;
    sql += ` SET ${sets}`;

    const where = this._buildWhereNodes(state.where);
    if (where.sql) {
      sql += ` WHERE ${where.sql}`;
      bindings.push(...where.bindings);
    }

    if (state.order && state.order.length) {
      sql += ' ORDER BY ' + state.order
        .map((o) => `${this.escapeId(o.field)} ${o.direction === 'DESC' ? 'DESC' : 'ASC'}`)
        .join(', ');
    }
    if (state.limit !== null && state.limit !== undefined) {
      sql += ' LIMIT ?';
      bindings.push(Number(state.limit));
    }

    return { sql, bindings };
  }

  // ---------------------------------------------------------------- DELETE
  buildDelete(state) {
    const bindings = [];
    let sql = `DELETE FROM ${this.escapeId(state.table)}`;

    const where = this._buildWhereNodes(state.where);
    if (where.sql) {
      sql += ` WHERE ${where.sql}`;
      bindings.push(...where.bindings);
    }

    if (state.order && state.order.length) {
      sql += ' ORDER BY ' + state.order
        .map((o) => `${this.escapeId(o.field)} ${o.direction === 'DESC' ? 'DESC' : 'ASC'}`)
        .join(', ');
    }
    if (state.limit !== null && state.limit !== undefined) {
      sql += ' LIMIT ?';
      bindings.push(Number(state.limit));
    }

    return { sql, bindings };
  }

  // ---------------------------------------------------------------- 聚合 / EXISTS
  buildAggregate(state, fn, field = '*') {
    const func = String(fn || 'COUNT').toUpperCase();
    if (!['COUNT', 'SUM', 'MAX', 'MIN', 'AVG'].includes(func)) {
      throw new InvalidQueryError(`不支持的聚合函数：${fn}`);
    }
    const column = field === '*' ? '*' : this.escapeId(field);
    const distinct = state.distinct && func === 'COUNT' ? 'DISTINCT ' : '';
    const bindings = [];

    let sql = `SELECT ${func}(${distinct}${column}) AS ${this.escapeId('qee_agg')}`;
    sql += this._from(state);

    if (state.join && state.join.length) {
      sql += ' ' + state.join.map((join) => this._buildJoin(join)).join(' ');
    }

    const where = this._buildWhereNodes(state.where);
    if (where.sql) {
      sql += ` WHERE ${where.sql}`;
      bindings.push(...where.bindings);
    }

    if (state.group && state.group.length) {
      sql += ' GROUP BY ' + state.group.map((g) => this.escapeId(g.name || g)).join(', ');
    }

    const having = this._buildWhereNodes(state.having);
    if (having.sql) {
      sql += ` HAVING ${having.sql}`;
      bindings.push(...having.bindings);
    }

    return { sql, bindings };
  }

  /**
   * EXISTS 探针：SELECT 1 ... LIMIT 1
   * （文档扩展方法，供 Query.exists() 使用）
   */
  buildExists(state) {
    const bindings = [];
    let sql = `SELECT 1 AS ${this.escapeId('qee_exists')}`;
    sql += this._from(state);

    if (state.join && state.join.length) {
      sql += ' ' + state.join.map((join) => this._buildJoin(join)).join(' ');
    }

    const where = this._buildWhereNodes(state.where);
    if (where.sql) {
      sql += ` WHERE ${where.sql}`;
      bindings.push(...where.bindings);
    }
    sql += ' LIMIT 1';
    return { sql, bindings };
  }

  // ---------------------------------------------------------------- 内部：WHERE AST
  /**
   * AST 数组 → WHERE 子句（不含 WHERE 关键字）
   * @param {object[]} nodes
   * @returns {{sql: string, bindings: any[]}}
   */
  _buildWhereNodes(nodes) {
    if (!nodes || nodes.length === 0) return { sql: '', bindings: [] };
    const parts = [];
    const bindings = [];

    nodes.forEach((node, index) => {
      if (index > 0) parts.push(String(node.boolean || 'AND').toUpperCase());
      const built = this._buildWhereNode(node);
      parts.push(built.sql);
      bindings.push(...built.bindings);
    });

    return { sql: parts.join(' '), bindings };
  }

  /** 单个 AST 节点 */
  _buildWhereNode(node) {
    if (!node || typeof node !== 'object') {
      throw new InvalidQueryError('where AST 节点必须是对象');
    }

    switch (node.type) {
      case 'basic':
        return this._buildBasic(node);
      case 'in':
      case 'notin':
        return this._buildIn(node);
      case 'null':
        return { sql: `${this.escapeId(node.field)} IS NULL`, bindings: [] };
      case 'notnull':
        return { sql: `${this.escapeId(node.field)} IS NOT NULL`, bindings: [] };
      case 'between':
      case 'notbetween': {
        const keyword = node.type === 'between' ? 'BETWEEN' : 'NOT BETWEEN';
        return {
          sql: `${this.escapeId(node.field)} ${keyword} ? AND ?`,
          bindings: [node.min, node.max],
        };
      }
      case 'raw':
        if (typeof node.sql !== 'string' || !node.sql.trim()) {
          throw new InvalidQueryError('whereRaw 的 SQL 不能为空');
        }
        return { sql: node.sql, bindings: (node.bindings || []).slice() };
      case 'nested': {
        const inner = this._buildWhereNodes(node.children);
        return { sql: `(${inner.sql})`, bindings: inner.bindings };
      }
      case 'column':
        // 字段对字段比较，如 JOIN 条件
        return {
          sql: `${this.escapeId(node.field)} ${this._normalizeOp(node.op)} ${this.escapeId(node.other)}`,
          bindings: [],
        };
      default:
        throw new InvalidQueryError(`未知的 where 节点类型：${node.type}`);
    }
  }

  _buildBasic(node) {
    const op = this._normalizeOp(node.op);
    const value = node.value;

    // null 语义自动改写
    if (value === null || value === undefined) {
      if (op === '=' || op === 'IS') return { sql: `${this.escapeId(node.field)} IS NULL`, bindings: [] };
      if (op === '!=' || op === '<>' || op === 'IS NOT') {
        return { sql: `${this.escapeId(node.field)} IS NOT NULL`, bindings: [] };
      }
    }

    return {
      sql: `${this.escapeId(node.field)} ${op} ${this.placeholder()}`,
      bindings: [value],
    };
  }

  _buildIn(node) {
    const values = node.values || [];
    const negative = node.type === 'notin' || String(node.op).toUpperCase() === 'NOT IN';
    if (values.length === 0) {
      // IN () 非法；空集合按语义折叠为恒假 / 恒真
      return { sql: negative ? '1 = 1' : '1 = 0', bindings: [] };
    }
    const placeholders = values.map(() => this.placeholder()).join(', ');
    return {
      sql: `${this.escapeId(node.field)} ${negative ? 'NOT IN' : 'IN'} (${placeholders})`,
      bindings: values.slice(),
    };
  }

  _normalizeOp(op) {
    if (op === undefined || op === null || op === '') return '=';
    const raw = String(op).trim();
    const upper = raw.toUpperCase();
    const mapped = raw === '==' ? '=' : upper;
    if (!COMPARATORS.has(mapped)) {
      throw new InvalidQueryError(`不支持的比较运算符：${op}（如需自定义请用 whereRaw）`);
    }
    return mapped;
  }

  // ---------------------------------------------------------------- 内部：FROM / JOIN / FIELDS
  _from(state) {
    if (!state.table) throw new InvalidQueryError('查询缺少 table，请先调用 table()/Model 指定表名');
    let sql = ` FROM ${this.escapeId(state.table)}`;
    if (state.alias) sql += ` AS ${this.escapeId(state.alias)}`;
    return sql;
  }

  _buildFieldList(fields) {
    if (!fields || fields.length === 0) return '*';
    return fields
      .map((field) => {
        if (typeof field === 'string') return this.escapeId(field);
        if (field.raw) {
          return field.alias ? `${field.expr} AS ${this.escapeId(field.alias)}` : field.expr;
        }
        if (field.name === '*') return '*';
        return this.escapeId(field.alias ? `${field.name} as ${field.alias}` : field.name);
      })
      .join(', ');
  }

  _buildJoin(join) {
    const type = String(join.type || 'INNER').toUpperCase();
    if (!['INNER', 'LEFT', 'RIGHT', 'CROSS'].includes(type)) {
      throw new InvalidQueryError(`不支持的 JOIN 类型：${join.type}`);
    }

    let sql = `${type} JOIN ${this.escapeId(join.table)}`;
    if (join.alias) sql += ` AS ${this.escapeId(join.alias)}`;

    if (join.on && join.on.length) {
      const conditions = join.on.map((cond) => {
        if (cond.type === 'raw') {
          if (!cond.sql) throw new InvalidQueryError('JOIN ON 的 raw 条件不能为空');
          return cond.sql;
        }
        const left = this._inferSide(join, cond.left);
        const right = cond.rawRight
          ? cond.right
          : this._inferSide(join, cond.right);
        return `${left} ${this._normalizeOp(cond.op)} ${right}`;
      });
      sql += ` ON ${conditions.join(' AND ')}`;
    } else if (type !== 'CROSS') {
      throw new InvalidQueryError('JOIN 必须提供 ON 条件');
    }
    return sql;
  }

  /**
   * JOIN 条件的单侧标识符：
   *  - 已带表名（a.b）或已是完整表达式 → 直接转义
   *  - 裸字段名 → 用当前 join 的表/别名限定
   */
  _inferSide(join, field) {
    if (typeof field !== 'string' || !field.trim()) {
      throw new InvalidQueryError('JOIN ON 的字段必须是非空字符串');
    }
    const value = field.trim();
    if (value === '*' || value.includes('.') || /\s+as\s+/i.test(value)) {
      return this.escapeId(value);
    }
    const prefix = join.alias || join.table;
    return this.escapeId(`${prefix}.${value}`);
  }
}

export default MysqlBuilder;
