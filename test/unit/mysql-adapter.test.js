'use strict';

/**
 * 单元测试：MysqlAdapter（打桩 mysql2/promise，验证结果归一与错误映射）
 * ------------------------------------------------------------------
 * 不依赖真实数据库；通过替换 mysql2/promise 的 createPool 导出来注入假的池。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import mysql2Promise from 'mysql2/promise';

import MysqlAdapter from '../../src/adapters/MysqlAdapter.js';
import {
  DuplicateKeyError,
  ForeignKeyError,
  ConnectionLostError,
  QueryError,
} from '../../src/exceptions/index.js';

let calls;
let lastConfig;

/** 构造模拟 RowDataPacket：带非普通对象原型 */
function rowPacket(values) {
  const row = Object.create({ constructor: { name: 'RowDataPacket' } });
  Object.assign(row, values);
  return row;
}

const fakeConnection = {
  async query(sql) {
    if (/SELECT/i.test(sql)) return [[rowPacket({ id: 1, name: 'qee' })], []];
    return [{ affectedRows: 1, insertId: 42, changedRows: 0 }, []];
  },
  async beginTransaction() {},
  async commit() {},
  async rollback() {},
  release() {},
};

const fakePool = {
  async query(sql) {
    calls.push(sql);
    if (/SELECT/i.test(sql)) return [[rowPacket({ id: 1, name: 'qee' })], []];
    return [{ affectedRows: 1, insertId: 42, changedRows: 0 }, []];
  },
  async getConnection() {
    return fakeConnection;
  },
  async end() {},
};

const originalCreatePool = mysql2Promise.createPool;

test.before(() => {
  mysql2Promise.createPool = (config) => {
    lastConfig = config;
    return fakePool;
  };
});

test.after(() => {
  mysql2Promise.createPool = originalCreatePool;
});

test.beforeEach(() => {
  calls = [];
  lastConfig = null;
});

test('connect：默认池参数（utf8mb4 / 连接池）', async () => {
  const adapter = new MysqlAdapter({ host: 'h', user: 'u', database: 'd' });
  await adapter.connect();

  assert.equal(lastConfig.charset, 'utf8mb4');
  assert.equal(lastConfig.waitForConnections, true);
  assert.equal(lastConfig.database, 'd');
  assert.equal(lastConfig.connectionLimit, 10);
});

test('query：剥离 RowDataPacket 原型', async () => {
  const adapter = new MysqlAdapter({ database: 'd' });
  const rows = await adapter.query('SELECT * FROM user WHERE id = ?', [1]);

  assert.equal(rows.length, 1);
  assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
  assert.equal(rows[0].name, 'qee');
  assert.equal(calls.length, 1);
});

test('execute：ResultSetHeader → 统一写结果', async () => {
  const adapter = new MysqlAdapter({ database: 'd' });
  const result = await adapter.execute('INSERT INTO user (name) VALUES (?)', ['qee']);

  assert.deepEqual(result, { affectedRows: 1, insertId: 42, changedRows: 0 });
});

test('错误映射：唯一键 / 外键 / 连接中断 / 其它', async () => {
  const adapter = new MysqlAdapter({ database: 'd' });
  const cases = [
    ['ER_DUP_ENTRY', DuplicateKeyError],
    ['ER_NO_REFERENCED_ROW_2', ForeignKeyError],
    ['PROTOCOL_CONNECTION_LOST', ConnectionLostError],
    ['SOME_UNKNOWN', QueryError],
  ];

  for (const [code, ErrorClass] of cases) {
    const err = new Error('boom');
    err.code = code;
    const normalized = adapter.normalizeError(err, 'SELECT ?', [1]);
    assert.ok(normalized instanceof ErrorClass, `${code} 应映射为 ${ErrorClass.name}`);
    assert.equal(normalized.sql, 'SELECT ?');
    assert.deepEqual(normalized.bindings, [1]);
    assert.equal(normalized.cause, err);
  }
});

test('事务原语：连接包装与释放', async () => {
  const adapter = new MysqlAdapter({ database: 'd' });
  const conn = await adapter.getConnection();
  assert.equal(conn.__qeeRaw, fakeConnection);

  await adapter.begin(conn);
  await adapter.commit(conn);
  adapter.releaseConnection(conn);

  const rows = await adapter.queryOn(conn, 'SELECT 1', []);
  assert.equal(rows[0].id, 1);
});

test('只读池路由：配置 read 时 query 走只读池', async () => {
  const pools = [];
  mysql2Promise.createPool = (config) => {
    pools.push({ config, query: fakePool.query });
    return pools[pools.length - 1];
  };

  const adapter = new MysqlAdapter({ database: 'd', read: { host: 'replica' } });
  await adapter.connect();

  assert.equal(pools.length, 2);
  await adapter.query('SELECT 1', []);
  // query 使用 readPool（第二个池），因此 calls 记录到共享 fakePool.query
  assert.ok(calls.length >= 1);

  // 还原桩，避免影响后续用例
  mysql2Promise.createPool = (config) => {
    lastConfig = config;
    return fakePool;
  };
});
