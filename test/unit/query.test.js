'use strict';

/**
 * 单元测试：Query 链式状态机 / CRUD / 聚合 / 分页（FakeAdapter）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupFake, QeeDB } from '../helpers/setup.js';
import { InvalidQueryError } from '../../src/exceptions/index.js';

let adapter;
test.beforeEach(() => {
  adapter = setupFake();
});

test('select：AST 归一 + 结果返回', async () => {
  adapter.queueRows([{ id: 1, name: 'qee' }]);
  const rows = await QeeDB.table('user').where('id', 1).select();

  assert.deepEqual(rows, [{ id: 1, name: 'qee' }]);
  assert.equal(adapter.reads.length, 1);
  assert.equal(adapter.lastRead.sql, 'SELECT * FROM `user` WHERE `id` = ?');
  assert.deepEqual(adapter.lastRead.bindings, [1]);
});

test('where 对象 / 运算符数组 / IN / 空条件', async () => {
  adapter.queueRows([]);
  await QeeDB.table('user')
    .where({ status: 1, age: ['>', 18], role: ['admin', 'owner'] })
    .select();

  assert.equal(
    adapter.lastRead.sql,
    'SELECT * FROM `user` WHERE `status` = ? AND `age` > ? AND `role` IN (?, ?)',
  );
  assert.deepEqual(adapter.lastRead.bindings, [1, 18, 'admin', 'owner']);
});

test("where('a = 1') 直接抛错（ADR-04）", () => {
  assert.throws(() => QeeDB.table('user').where('a = 1'), InvalidQueryError);
});

test('field / order / limit / offset 组合', async () => {
  adapter.queueRows([]);
  await QeeDB.table('user')
    .field('id', 'name as username')
    .order('id', 'desc')
    .limit(10, 20)
    .select();

  assert.equal(
    adapter.lastRead.sql,
    'SELECT `id`, `name` AS `username` FROM `user` ORDER BY `id` DESC LIMIT ? OFFSET ?',
  );
  assert.deepEqual(adapter.lastRead.bindings, [10, 20]);
});

test('fetchSql 只返回 SQL 不触库', async () => {
  const built = await QeeDB.table('user').where('id', 1).fetchSql().select();

  assert.deepEqual(built, {
    sql: 'SELECT * FROM `user` WHERE `id` = ?',
    bindings: [1],
  });
  assert.equal(adapter.reads.length, 0);
});

test('toSql 内联绑定值（调试）', () => {
  const sql = QeeDB.table('user').where({ id: 1, name: 'qee' }).toSql();
  assert.equal(sql, "SELECT * FROM `user` WHERE `id` = 1 AND `name` = 'qee'");
});

test('insert / update / delete 生成写 SQL', async () => {
  await QeeDB.table('user').insert({ name: 'qee', age: 1 });
  assert.equal(adapter.lastWrite.sql, 'INSERT INTO `user` (`name`, `age`) VALUES (?, ?)');

  await QeeDB.table('user').where('id', 2).update({ name: 'x' });
  assert.equal(adapter.lastWrite.sql, 'UPDATE `user` SET `name` = ? WHERE `id` = ?');

  await QeeDB.table('user').where('id', 2).delete();
  assert.equal(adapter.lastWrite.sql, 'DELETE FROM `user` WHERE `id` = ?');
});

test('insertAll 自动按 500 条分批', async () => {
  const rows = Array.from({ length: 600 }, (_, index) => ({ name: `n${index}`, age: index }));
  const result = await QeeDB.table('user').insertAll(rows);

  assert.equal(adapter.writes.length, 2);
  assert.equal(adapter.writes[0].bindings.length, 500 * 2);
  assert.equal(adapter.writes[1].bindings.length, 100 * 2);
  assert.equal(result.affectedRows, 2);
});

test('setInc / setDec 原子更新', async () => {
  await QeeDB.table('user').where('id', 1).setInc('score', 5);
  assert.equal(adapter.lastWrite.sql, 'UPDATE `user` SET `score` = `score` + ? WHERE `id` = ?');

  await QeeDB.table('user').where('id', 1).setDec('score', 2);
  assert.equal(adapter.lastWrite.sql, 'UPDATE `user` SET `score` = `score` - ? WHERE `id` = ?');
});

test('count / sum 聚合读取', async () => {
  adapter.queueRows([{ qee_agg: 7 }]);
  assert.equal(await QeeDB.table('user').where('status', 1).count(), 7);

  adapter.queueRows([{ qee_agg: '120.50' }]);
  assert.equal(await QeeDB.table('order').sum('amount'), '120.50');
});

test('exists 探针', async () => {
  adapter.queueRows([{ qee_exists: 1 }]);
  assert.equal(await QeeDB.table('user').where('id', 9).exists(), true);

  adapter.queueRows([]);
  assert.equal(await QeeDB.table('user').where('id', 9).exists(), false);
});

test('paginate：总数 + 当页数据', async () => {
  adapter.queueRows([{ qee_agg: 23 }]);
  adapter.queueRows([{ id: 11 }, { id: 12 }]);

  const page = await QeeDB.table('user').paginate(2, 10);
  assert.equal(page.total, 23);
  assert.equal(page.current_page, 2);
  assert.equal(page.last_page, 3);
  assert.equal(page.per_page, 10);
  assert.equal(page.has_more, true);
  assert.deepEqual(page.data, [{ id: 11 }, { id: 12 }]);
});

test('chunk 分块并在回调返回 false 时终止', async () => {
  adapter.queueRows([{ id: 1 }, { id: 2 }]);
  adapter.queueRows([{ id: 3 }, { id: 4 }]);

  const pages = [];
  await QeeDB.table('user').chunk(2, (rows, pageNo) => {
    pages.push(pageNo);
    if (pageNo === 2) return false;
  });

  assert.deepEqual(pages, [1, 2]);
  assert.equal(adapter.reads.length, 2);
});

test('value / column 不做水合', async () => {
  adapter.queueRows([{ name: 'qee' }]);
  assert.equal(await QeeDB.table('user').where('id', 1).value('name'), 'qee');

  adapter.queueRows([{ name: 'a' }, { name: 'b' }]);
  assert.deepEqual(await QeeDB.table('user').column('name'), ['a', 'b']);
});

test('clone 后两个查询互不影响', async () => {
  const base = QeeDB.table('user').where('status', 1);
  const withLimit = base.clone().limit(5);

  adapter.queueRows([]);
  await withLimit.select();

  const state = base.getState();
  assert.equal(state.limit, null);
  assert.equal(withLimit.getState().limit, 5);
});
