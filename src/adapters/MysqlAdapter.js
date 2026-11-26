'use strict';

/**
 * MySQL Adapter（设计文档 3.1.2）
 * ------------------------------------------------------------------
 * 实现要点：
 *  - 依赖 mysql2/promise，惰性 require（未安装时只影响实际连库，不影响单元测试）
 *  - 建池参数透传，默认 utf8mb4
 *  - 结果归一：rows.map(r => Object.assign({}, r))，剥离 RowDataPacket 原型
 *  - 写返回 ResultSetHeader → { affectedRows, insertId, changedRows }
 *  - 事务连接 try/finally 保证 release
 *  - 错误映射到 QeeDB 统一异常
 *  - 预留读写分离：query() 走 read 池，execute()/事务走主池
 */

import Adapter from './Adapter.js';
import MysqlBuilder from '../builders/MysqlBuilder.js';
import mysqlPromise from 'mysql2/promise';
import {
  ConfigError,
  QueryError,
  DuplicateKeyError,
  ForeignKeyError,
  ConnectionError,
  ConnectionLostError,
} from '../exceptions/index.js';

/** 允许透传给 mysql2 createPool 的连接参数白名单 */
const POOL_KEYS = [
  'host',
  'port',
  'user',
  'password',
  'database',
  'charset',
  'timezone',
  'connectionLimit',
  'waitForConnections',
  'queueLimit',
  'connectTimeout',
  'acquireTimeout',
  'decimalNumbers',
  'supportBigNumbers',
  'bigNumberStrings',
  'dateStrings',
  'multipleStatements',
  'namedPlaceholders',
  'ssl',
  'socketPath',
];

/** 驱动错误码 → QeeDB 异常类 */
const ERROR_MAP = {
  ER_DUP_ENTRY: DuplicateKeyError,
  ER_NO_REFERENCED_ROW: ForeignKeyError,
  ER_NO_REFERENCED_ROW_2: ForeignKeyError,
  ER_ROW_IS_REFERENCED: ForeignKeyError,
  ER_ROW_IS_REFERENCED_2: ForeignKeyError,
  PROTOCOL_CONNECTION_LOST: ConnectionLostError,
  ECONNRESET: ConnectionLostError,
  ETIMEDOUT: ConnectionError,
  ECONNREFUSED: ConnectionError,
  ER_ACCESS_DENIED_ERROR: ConnectionError,
  ER_BAD_DB_ERROR: ConnectionError,
  ER_NO_SUCH_TABLE: QueryError,
  ER_BAD_FIELD_ERROR: QueryError,
  ER_PARSE_ERROR: QueryError,
};

class MysqlAdapter extends Adapter {
  constructor(config = {}) {
    super(config);
    this.driverName = 'mysql';
    /** @type {any} 主库池（写 + 事务） */
    this.pool = null;
    /** @type {any} 只读池（可选） */
    this.readPool = null;
  }

  // ---------------------------------------------------------------- 生命周期
  /** 幂等建池：首次调用创建主池；若配置了 read 且与主库不同，额外创建只读池 */
  async connect() {
    if (this.pool) return this.pool;

    const mysql = this._loadDriver();
    const base = this._poolConfig(this.config);
    this.pool = mysql.createPool(base);

    // 预留读写分离：read 配置存在即建只读池，否则复用主池
    if (this.config.read && typeof this.config.read === 'object' && Object.keys(this.config.read).length > 0) {
      this.readPool = mysql.createPool(this._poolConfig({ ...this.config, ...this.config.read }));
    } else {
      this.readPool = this.pool;
    }
    return this.pool;
  }

  /** 关闭所有池 */
  async close() {
    const pools = new Set([this.pool, this.readPool].filter(Boolean));
    for (const pool of pools) {
      await pool.end();
    }
    this.pool = null;
    this.readPool = null;
  }

  // ---------------------------------------------------------------- 无事务执行
  /**
   * 读：走只读池。
   * mysql2 的 query 返回 [rows, fields]；DDL 等场景 rows 不是数组，统一归一为空数组。
   */
  async query(sql, bindings = []) {
    await this.connect();
    const pool = this.readPool || this.pool;
    try {
      const [rows] = await pool.query(sql, bindings);
      return this._normalizeRows(rows);
    } catch (err) {
      throw this.normalizeError(err, sql, bindings);
    }
  }

  /** 写：走主池 */
  async execute(sql, bindings = []) {
    await this.connect();
    try {
      const [result] = await this.pool.query(sql, bindings);
      return this._normalizeResult(result);
    } catch (err) {
      throw this.normalizeError(err, sql, bindings);
    }
  }

  // ---------------------------------------------------------------- 连接与事务
  async getConnection() {
    await this.connect();
    try {
      const conn = await this.pool.getConnection();
      // 让连接上的 query 也走归一错误（包装一次，避免污染驱动原型）
      return this._wrapConn(conn);
    } catch (err) {
      throw this.normalizeError(err);
    }
  }

  /**
   * 释放连接。
   * 传入被 _wrapConn 包装过的对象时，取出原始连接再释放。
   */
  releaseConnection(conn) {
    if (!conn) return;
    const raw = conn.__qeeRaw || conn;
    if (typeof raw.release === 'function') raw.release();
  }

  async queryOn(conn, sql, bindings = []) {
    try {
      const [rows] = await this._raw(conn).query(sql, bindings);
      return this._normalizeRows(rows);
    } catch (err) {
      throw this.normalizeError(err, sql, bindings);
    }
  }

  async executeOn(conn, sql, bindings = []) {
    try {
      const [result] = await this._raw(conn).query(sql, bindings);
      return this._normalizeResult(result);
    } catch (err) {
      throw this.normalizeError(err, sql, bindings);
    }
  }

  async begin(conn) {
    await this._raw(conn).beginTransaction();
  }

  async commit(conn) {
    await this._raw(conn).commit();
  }

  async rollback(conn) {
    await this._raw(conn).rollback();
  }

  /** 保存点：name 为内部生成的标识，仅允许 [A-Za-z0-9_] */
  async savepoint(conn, name) {
    this._assertSavepointName(name);
    await this._raw(conn).query(`SAVEPOINT \`${name}\``);
  }

  async rollbackTo(conn, name) {
    this._assertSavepointName(name);
    await this._raw(conn).query(`ROLLBACK TO SAVEPOINT \`${name}\``);
  }

  /** 释放保存点（可选，MySQL 提交时自动释放） */
  async releaseSavepoint(conn, name) {
    this._assertSavepointName(name);
    await this._raw(conn).query(`RELEASE SAVEPOINT \`${name}\``);
  }

  // ---------------------------------------------------------------- 元信息
  getBuilderClass() {
    return MysqlBuilder;
  }

  getDriverName() {
    return this.driverName;
  }

  /**
   * 驱动错误归一（设计文档 3.1.2 错误映射表）
   * @param {Error & {code?: string, errno?: number}} err
   * @param {string} [sql]
   * @param {any[]} [bindings]
   */
  normalizeError(err, sql, bindings) {
    if (err && err.__qeeNormalized) return err;
    const ErrorClass = ERROR_MAP[err && err.code] || QueryError;
    const message = err && err.message ? err.message : String(err);
    const out = new ErrorClass(message, {
      code: (err && err.code) || 'QEEDB_QUERY_ERROR',
      sql,
      bindings,
      cause: err,
    });
    // 保留 MySQL 原始错误号，便于排查
    if (err && err.errno !== undefined) out.errno = err.errno;
    out.sqlState = err && err.sqlState;
    out.__qeeNormalized = true;
    return out;
  }

  // ---------------------------------------------------------------- 私有方法
  _loadDriver() {
    if (this._mysql) return this._mysql;
    try {
      // eslint-disable-next-line global-require
      this._mysql = mysqlPromise;
    } catch (err) {
      throw new ConfigError('使用 MysqlAdapter 需要安装 mysql2（npm i mysql2@^3）', {
        cause: err,
      });
    }
    return this._mysql;
  }

  /** 从 QeeDB 配置中提取 mysql2 认识的池参数 */
  _poolConfig(config) {
    const out = {
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
    };
    for (const key of POOL_KEYS) {
      if (config[key] !== undefined) out[key] = config[key];
    }
    if (!out.database && config.dbName) out.database = config.dbName;
    return out;
  }

  /** 剥离 RowDataPacket 原型，返回普通对象（ADR-05） */
  _normalizeRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => Object.assign({}, row));
  }

  /** ResultSetHeader → 统一写结果 */
  _normalizeResult(result) {
    if (!result || typeof result !== 'object') {
      return { affectedRows: 0, insertId: null, changedRows: 0 };
    }
    return {
      affectedRows: result.affectedRows || 0,
      insertId: result.insertId !== undefined ? result.insertId : null,
      changedRows: result.changedRows || 0,
    };
  }

  /** 取原始 mysql2 连接 */
  _raw(conn) {
    return (conn && conn.__qeeRaw) || conn;
  }

  /**
   * 包装连接：
   *  - 统一 release 入口
   *  - 给 query 补一层错误归一（事务内 queryOn 也会用到 __qeeRaw，不重复包装）
   */
  _wrapConn(conn) {
    if (conn.__qeeRaw) return conn;
    const adapter = this;
    const wrapper = {
      __qeeRaw: conn,
      release() {
        conn.release();
      },
    };
    return wrapper;
  }

  _assertSavepointName(name) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      throw new QueryError(`非法保存点名称：${name}`);
    }
  }
}

export default MysqlAdapter;
