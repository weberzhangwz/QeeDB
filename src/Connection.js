'use strict';

/**
 * Connection（设计文档 3.3）
 * ------------------------------------------------------------------
 * 组合 Adapter（协议/池/事务原语）+ Builder（方言）。
 * 职责：
 *  - 延迟连接：首次 query/execute 才 connect
 *  - 事务路由：命中 AsyncLocalStorage 事务上下文 → queryOn(trx.conn)
 *  - SQL 事件：成功执行后 emit global 'query'{sql,bindings,time,connection}
 *  - 回调式事务 + 嵌套 savepoint
 */

import * as TransactionContext from './TransactionContext.js';
import { globalBus } from './events.js';
import {
  getAdapterClass,
  getBuilderClass,
} from './registry.js';
import { ConfigError, TransactionError } from './exceptions/index.js';

let connectionSeq = 0;

class Connection {
  /**
   * @param {string} name 连接名
   * @param {object} config { driver, host, port, ... }
   */
  constructor(name, config = {}) {
    if (!config || typeof config !== 'object') {
      throw new ConfigError(`连接「${name}」配置必须是对象`);
    }
    this.name = name;
    this.config = config;
    this.id = `qee_conn_${++connectionSeq}`;
    this.driver = config.driver || 'mysql';

    const AdapterClass = getAdapterClass(this.driver);
    const BuilderClass = getBuilderClass(this.driver);

    this.adapter = new AdapterClass(config);
    this.builder = new BuilderClass();
    this._closed = false;
  }

  /** 当前连接的 Builder 实例（Query 层使用） */
  getBuilder() {
    return this.builder;
  }

  // ---------------------------------------------------------------- 执行入口
  /**
   * 读查询：命中事务上下文则走事务连接
   * @param {string} sql
   * @param {any[]} [bindings]
   */
  async query(sql, bindings = []) {
    const trx = TransactionContext.getFor(this);
    const start = now();
    let rows;
    if (trx) {
      rows = await this.adapter.queryOn(trx.conn, sql, bindings);
    } else {
      rows = await this.adapter.query(sql, bindings);
    }
    this._emitQuery(sql, bindings, start, 'read', Boolean(trx));
    return rows;
  }

  /**
   * 写执行：命中事务上下文则走事务连接
   * @param {string} sql
   * @param {any[]} [bindings]
   */
  async execute(sql, bindings = []) {
    const trx = TransactionContext.getFor(this);
    const start = now();
    let result;
    if (trx) {
      result = await this.adapter.executeOn(trx.conn, sql, bindings);
    } else {
      result = await this.adapter.execute(sql, bindings);
    }
    this._emitQuery(sql, bindings, start, 'write', Boolean(trx));
    return result;
  }

  // ---------------------------------------------------------------- 事务
  /**
   * 回调式事务（设计文档 3.6.1）
   *  - 顶层：取连接 → BEGIN → ALS.run(cb) → COMMIT / ROLLBACK
   *  - 嵌套（同连接已有事务）：SAVEPOINT → 内层回滚只 ROLLBACK TO
   * @template T
   * @param {(conn: Connection) => Promise<T>} cb
   * @returns {Promise<T>}
   */
  async transaction(cb) {
    if (typeof cb !== 'function') throw new TransactionError('transaction 需要回调函数');

    const existing = TransactionContext.getFor(this);
    if (existing) return this._savepointWrap(existing, cb);

    const conn = await this.adapter.getConnection();
    let trx;
    try {
      await this.adapter.begin(conn);
      trx = { connection: this, conn, depth: 0, savepoints: [] };
      const result = await TransactionContext.run(trx, () => cb(this));
      await this.adapter.commit(conn);
      return result;
    } catch (err) {
      try {
        await this.adapter.rollback(conn);
      } catch (rollbackErr) {
        // 回滚失败不应掩盖原始异常，附加信息后抛出
        if (err && typeof err === 'object') err.rollbackError = rollbackErr;
      }
      throw err;
    } finally {
      this.adapter.releaseConnection(conn);
    }
  }

  /**
   * 嵌套事务：SAVEPOINT / ROLLBACK TO（设计文档 3.6.2）
   * @param {object} parent 外层事务上下文
   * @param {Function} cb
   */
  async _savepointWrap(parent, cb) {
    const depth = (parent.savepoints ? parent.savepoints.length : 0) + 1;
    const name = TransactionContext.savepointName(depth);
    await this.adapter.savepoint(parent.conn, name);
    parent.savepoints.push(name);
    parent.depth = depth;

    try {
      const result = await cb(this);
      parent.savepoints.pop();
      // RELEASE 是可选优化，部分驱动/版本不支持，失败不影响正确性
      if (typeof this.adapter.releaseSavepoint === 'function') {
        try {
          await this.adapter.releaseSavepoint(parent.conn, name);
        } catch (_) {
          /* 忽略 */
        }
      }
      return result;
    } catch (err) {
      parent.savepoints.pop();
      await this.adapter.rollbackTo(parent.conn, name);
      throw err;
    }
  }

  // ---------------------------------------------------------------- 生命周期
  /** 显式关闭连接池 */
  async close() {
    if (this._closed) return;
    this._closed = true;
    await this.adapter.close();
  }

  // ---------------------------------------------------------------- 私有
  _emitQuery(sql, bindings, start, type, trx) {
    const time = now() - start;
    globalBus.emit('query', {
      sql,
      bindings,
      time,
      connection: this.name,
      driver: this.driver,
      type,
      transaction: trx,
    });
  }
}

/** 高精度计时（毫秒） */
function now() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export default Connection;
