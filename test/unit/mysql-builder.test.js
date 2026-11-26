'use strict';

/**
 * 单元测试：MysqlBuilder SQL 生成（快照式断言）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import MysqlBuilder from '../../src/builders/MysqlBuilder.js';
import { InvalidQueryError } from '../../src/exceptions/index.js';

const builder = new MysqlBuilder();

/** 状态工厂：与 Query.createState 对齐的最小集合 */
function state(overrides = {}) {
  return {
    table: 'user',
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
    ...overrides,
  };
}

test('SELECT 最小语句', () => {
  const { sql, bindings } = builder.buildSelect(state());
  assert.equal(sql, 'SELECT * FROM `user`');
  assert.deepEqual(bindings, []);
});

test('SELECT 字段 + 别名 + DISTINCT', () => {
  const { sql } = builder.buildSelect(
    state({
      fields: [{ name: 'id' }, { name: 'name', alias: 'username' }],
      distinct: true,
    }),
  );
  assert.equal(sql, 'SELECT DISTINCT `id`, `name` AS `username` FROM `user`');
});

test('WHERE basic / in / null', () => {
  const { sql, bindings } = builder.buildSelect(
    state({
      where: [
        { type: 'basic', boolean: 'AND', field: 'status', op: '=', value: 1 },
        { type: 'basic', boolean: 'OR', field: 'age', op: '>', value: 18 },
        { type: 'in', boolean: 'AND', field: 'id', values: [1, 2, 3] },
        { type: 'null', boolean: 'AND', field: 'delete_time' },
      ],
    }),
  );
  assert.equal(
    sql,
    'SELECT * FROM `user` WHERE `status` = ? OR `age` > ? AND `id` IN (?, ?, ?) AND `delete_time` IS NULL',
  );
  assert.deepEqual(bindings, [1, 18, 1, 2, 3]);
});

test('WHERE 空 IN / 空 NOT IN 折叠', () => {
  const inSql = builder.buildSelect(
    state({ where: [{ type: 'in', field: 'id', values: [] }] }),
  );
  assert.match(inSql.sql, /WHERE 1 = 0/);

  const notInSql = builder.buildSelect(
    state({ where: [{ type: 'notin', field: 'id', values: [] }] }),
  );
  assert.match(notInSql.sql, /WHERE 1 = 1/);
});

test('WHERE between / nested / raw', () => {
  const { sql, bindings } = builder.buildSelect(
    state({
      where: [
        { type: 'between', boolean: 'AND', field: 'age', min: 18, max: 30 },
        {
          type: 'nested',
          boolean: 'AND',
          children: [
            { type: 'basic', boolean: 'AND', field: 'a', op: '=', value: 1 },
            { type: 'basic', boolean: 'OR', field: 'b', op: '=', value: 2 },
          ],
        },
        { type: 'raw', boolean: 'AND', sql: 'name = ?', bindings: ['qee'] },
      ],
    }),
  );
  assert.equal(
    sql,
    'SELECT * FROM `user` WHERE `age` BETWEEN ? AND ? AND (`a` = ? OR `b` = ?) AND name = ?',
  );
  assert.deepEqual(bindings, [18, 30, 1, 2, 'qee']);
});

test('ORDER / LIMIT / OFFSET 使用绑定值', () => {
  const { sql, bindings } = builder.buildSelect(
    state({ order: [{ field: 'id', direction: 'DESC' }], limit: 10, offset: 20 }),
  );
  assert.equal(sql, 'SELECT * FROM `user` ORDER BY `id` DESC LIMIT ? OFFSET ?');
  assert.deepEqual(bindings, [10, 20]);
});

test('GROUP BY / HAVING', () => {
  const { sql, bindings } = builder.buildSelect(
    state({
      fields: [{ name: 'status' }],
      group: [{ name: 'status' }],
      having: [{ type: 'basic', boolean: 'AND', field: 'status', op: '=', value: 1 }],
    }),
  );
  assert.equal(sql, 'SELECT `status` FROM `user` GROUP BY `status` HAVING `status` = ?');
  assert.deepEqual(bindings, [1]);
});

test('LEFT JOIN 条件', () => {
  const { sql } = builder.buildSelect(
    state({
      join: [
        {
          type: 'LEFT',
          table: 'comments',
          on: [{ left: 'posts.id', op: '=', right: 'comments.post_id' }],
        },
      ],
    }),
  );
  assert.equal(
    sql,
    'SELECT * FROM `user` LEFT JOIN `comments` ON `posts`.`id` = `comments`.`post_id`',
  );
});

test('锁语义', () => {
  const { sql } = builder.buildSelect(state({ lock: 'update' }));
  assert.equal(sql, 'SELECT * FROM `user` FOR UPDATE');

  const { sql: share } = builder.buildSelect(state({ lock: 'share' }));
  assert.equal(share, 'SELECT * FROM `user` FOR SHARE');
});

test('INSERT 单行', () => {
  const { sql, bindings } = builder.buildInsert(state({ data: { name: 'qee', age: 1 } }));
  assert.equal(sql, 'INSERT INTO `user` (`name`, `age`) VALUES (?, ?)');
  assert.deepEqual(bindings, ['qee', 1]);
});

test('INSERT ALL 多行', () => {
  const { sql, bindings } = builder.buildInsertAll(
    state({ data: [{ name: 'a', age: 1 }, { name: 'b', age: 2 }] }),
  );
  assert.equal(sql, 'INSERT INTO `user` (`name`, `age`) VALUES (?, ?), (?, ?)');
  assert.deepEqual(bindings, ['a', 1, 'b', 2]);
});

test('INSERT ALL 行列不一致时抛错', () => {
  assert.throws(
    () => builder.buildInsertAll(state({ data: [{ a: 1 }, { b: 2 }] })),
    InvalidQueryError,
  );
});

test('UPSERT 生成 ON DUPLICATE KEY UPDATE', () => {
  const { sql } = builder.buildUpsert(
    state({ data: { id: 1, name: 'qee' }, pk: 'id' }),
  );
  assert.equal(
    sql,
    'INSERT INTO `user` (`id`, `name`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)',
  );
});

test('UPDATE 普通字段与自增字段', () => {
  const { sql, bindings } = builder.buildUpdate(
    state({
      where: [{ type: 'basic', boolean: 'AND', field: 'id', op: '=', value: 7 }],
      data: { name: 'x', count: { __qeeOp: 'inc', value: 2 } },
    }),
  );
  assert.equal(sql, 'UPDATE `user` SET `name` = ?, `count` = `count` + ? WHERE `id` = ?');
  assert.deepEqual(bindings, ['x', 2, 7]);
});

test('DELETE', () => {
  const { sql, bindings } = builder.buildDelete(
    state({ where: [{ type: 'basic', boolean: 'AND', field: 'id', op: '=', value: 3 }] }),
  );
  assert.equal(sql, 'DELETE FROM `user` WHERE `id` = ?');
  assert.deepEqual(bindings, [3]);
});

test('聚合 COUNT / SUM', () => {
  const count = builder.buildAggregate(
    state({ where: [{ type: 'basic', boolean: 'AND', field: 'status', op: '=', value: 1 }] }),
    'COUNT',
    '*',
  );
  assert.equal(count.sql, 'SELECT COUNT(*) AS `qee_agg` FROM `user` WHERE `status` = ?');

  const sum = builder.buildAggregate(state(), 'SUM', 'amount');
  assert.equal(sum.sql, 'SELECT SUM(`amount`) AS `qee_agg` FROM `user`');

  assert.throws(() => builder.buildAggregate(state(), 'DROP', '*'), InvalidQueryError);
});

test('EXISTS 探针', () => {
  const { sql } = builder.buildExists(
    state({ where: [{ type: 'basic', boolean: 'AND', field: 'id', op: '=', value: 1 }] }),
  );
  assert.equal(sql, 'SELECT 1 AS `qee_exists` FROM `user` WHERE `id` = ? LIMIT 1');
});

test('非法运算符抛错，禁止拼接', () => {
  assert.throws(
    () =>
      builder.buildSelect(
        state({ where: [{ type: 'basic', field: 'id', op: '= 1 OR 1', value: 1 }] }),
      ),
    InvalidQueryError,
  );
});
