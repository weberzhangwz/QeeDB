'use strict';

/**
 * 测试用 FakeAdapter
 * ------------------------------------------------------------------
 * 实现 Adapter 全契约但不连库：
 *  - 读：按 responses 队列返回预置行
 *  - 写：记录 SQL，返回可预期的 ResultSetHeader
 *  - 事务：记录 begin/commit/rollback/savepoint，供 ALS 用例断言
 */

import Adapter from '../../src/adapters/Adapter.js';
import MysqlBuilder from '../../src/builders/MysqlBuilder.js';

class FakeAdapter extends Adapter {
  constructor(config = {}) {
    super(config);
    /** @type {{sql:string, bindings:any[], trx:boolean}[]} */
    this.reads = [];
    /** @type {{sql:string, bindings:any[], trx:boolean}[]} */
    this.writes = [];
    /** @type {object[][]} 预置读结果队列 */
    this.responses = [];
    this.txEvents = [];
    this.nextId = 1;
    this.connected = false;
    this.closed = false;
    this.conn = { fake: true, released: false };
  }

  async connect() {
    this.connected = true;
    return this;
  }

  async close() {
    this.closed = true;
  }

  async query(sql, bindings = []) {
    this.reads.push({ sql, bindings, trx: false });
    return this._next();
  }

  async execute(sql, bindings = []) {
    this.writes.push({ sql, bindings, trx: false });
    return this._result();
  }

  async getConnection() {
    this.txEvents.push('getConnection');
    return this.conn;
  }

  releaseConnection(conn) {
    if (conn) conn.released = true;
    this.txEvents.push('release');
  }

  async queryOn(conn, sql, bindings = []) {
    this.ensureConn(conn);
    this.reads.push({ sql, bindings, trx: true });
    return this._next();
  }

  async executeOn(conn, sql, bindings = []) {
    this.ensureConn(conn);
    this.writes.push({ sql, bindings, trx: true });
    return this._result();
  }

  async begin() {
    this.txEvents.push('begin');
  }

  async commit() {
    this.txEvents.push('commit');
  }

  async rollback() {
    this.txEvents.push('rollback');
  }

  async savepoint(conn, name) {
    this.txEvents.push(`savepoint:${name}`);
  }

  async rollbackTo(conn, name) {
    this.txEvents.push(`rollbackTo:${name}`);
  }

  async releaseSavepoint(conn, name) {
    this.txEvents.push(`release:${name}`);
  }

  getBuilderClass() {
    return MysqlBuilder;
  }

  getDriverName() {
    return 'fake';
  }

  normalizeError(err) {
    return err;
  }

  // ---------------------------------------------------------------- 测试工具
  /** 预置一次读取结果（多行） */
  queueRows(rows) {
    this.responses.push(rows);
    return this;
  }

  /** 便捷方法：批量追加多次读取结果 */
  queue(...batch) {
    this.responses.push(...batch);
    return this;
  }

  /** 最近一次读 SQL */
  get lastRead() {
    return this.reads[this.reads.length - 1];
  }

  /** 最近一次写 SQL */
  get lastWrite() {
    return this.writes[this.writes.length - 1];
  }

  reset() {
    this.reads = [];
    this.writes = [];
    this.responses = [];
    this.txEvents = [];
    this.nextId = 1;
    this.conn = { fake: true, released: false };
  }

  _next() {
    if (this.responses.length === 0) return [];
    return this.responses.shift();
  }

  _result() {
    return { affectedRows: 1, insertId: this.nextId++, changedRows: 1 };
  }

  ensureConn(conn) {
    if (!conn || !conn.fake) throw new Error('FakeAdapter: queryOn 收到非事务连接');
  }
}

export default FakeAdapter;
