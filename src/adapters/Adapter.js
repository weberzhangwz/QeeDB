'use strict';

/**
 * Adapter 抽象基类（设计文档 3.1.1）
 * ------------------------------------------------------------------
 * 职责：连接协议与执行器 —— 建池、执行 SQL、事务原语、错误归一。
 * 约束：Adapter **不得** import Query/Model 层，只能向下依赖数据库驱动。
 *
 * 新增数据库时继承本类，实现以下全部方法，再用 QeeDB.registerAdapter 注册。
 */

import { NotSupportedError } from '../exceptions/index.js';

class Adapter {
  /**
   * @param {object} config 连接配置（host/port/user/password/database...）
   */
  constructor(config = {}) {
    this.config = config;
    this.pool = null;
  }

  // ---------------------------------------------------------------- 生命周期
  /** 幂等建池 */
  async connect() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 connect()`);
  }

  /** 关闭池，释放资源 */
  async close() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 close()`);
  }

  // ---------------------------------------------------------------- 无事务执行
  /**
   * 读查询（走只读池，若配置）
   * @param {string} sql
   * @param {any[]} bindings
   * @returns {Promise<object[]>} 普通对象数组
   */
  async query(sql, bindings) {
    throw new NotSupportedError(`${this.constructor.name} 未实现 query()`);
  }

  /**
   * 写执行
   * @param {string} sql
   * @param {any[]} bindings
   * @returns {Promise<{affectedRows:number, insertId:number|string|null, changedRows:number}>}
   */
  async execute(sql, bindings) {
    throw new NotSupportedError(`${this.constructor.name} 未实现 execute()`);
  }

  // ---------------------------------------------------------------- 连接与事务
  async getConnection() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 getConnection()`);
  }

  releaseConnection() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 releaseConnection()`);
  }

  async queryOn(conn, sql, bindings) {
    throw new NotSupportedError(`${this.constructor.name} 未实现 queryOn()`);
  }

  async executeOn(conn, sql, bindings) {
    throw new NotSupportedError(`${this.constructor.name} 未实现 executeOn()`);
  }

  async begin() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 begin()`);
  }

  async commit() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 commit()`);
  }

  async rollback() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 rollback()`);
  }

  async savepoint() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 savepoint()`);
  }

  async rollbackTo() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 rollbackTo()`);
  }

  // ---------------------------------------------------------------- 元信息
  /** 该驱动默认的 Builder 类（由 registry 读取） */
  getBuilderClass() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 getBuilderClass()`);
  }

  /** 'mysql' | 'pg' | 'sqlite' */
  getDriverName() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 getDriverName()`);
  }

  /**
   * 驱动错误 → QeeDB 统一异常
   * @param {Error} err
   * @returns {Error}
   */
  normalizeError(err) {
    return err;
  }
}

export default Adapter;
