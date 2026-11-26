'use strict';

/**
 * 单元测试：Model 层（配置、水合、save 时序、软删除、事件、关联、事务）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupFake, QeeDB } from '../helpers/setup.js';
import { Model } from '../../src/index.js';
import { ModelNotFoundException } from '../../src/exceptions/index.js';

let adapter;
test.beforeEach(() => {
  adapter = setupFake();
});

// ---------------------------------------------------------------- 测试模型
class User extends Model {
  static table = 'users';
  static timestamps = true;
  static softDelete = 'delete_time';
  static hidden = ['password'];
  static casts = { age: 'int', meta: 'json' };
}

class Post extends Model {
  static table = 'posts';
}

class Comment extends Model {
  static table = 'comments';
}

class Tag extends Model {
  static table = 'tags';
}

class Article extends Model {}

class EventUser extends Model {
  static table = 'event_users';
}

class GetterUser extends Model {
  static table = 'getter_users';
  static getters = {
    name(value) {
      return String(value).toUpperCase();
    },
  };
}

User.hasMany(Post, 'user_id', 'id', 'posts');
User.belongsToMany(Tag, 'user_tag', 'user_id', 'tag_id', 'tags');
Post.belongsTo(User, 'user_id', 'id', 'user');
Post.hasMany(Comment, 'post_id', 'id', 'comments');

// ---------------------------------------------------------------- 配置与命名
test('默认表名：类名下划线复数', () => {
  assert.equal(Article.getTable(), 'articles');
});

test('子类 static 配置覆盖基类默认值', () => {
  assert.equal(User.getTable(), 'users');
  assert.equal(User.timestamps, true);
  assert.equal(User.getSoftDeleteField(), 'delete_time');
});

// ---------------------------------------------------------------- 创建 / 水合 / 序列化
test('create：写入时间戳、casts、主键回填、hidden 序列化', async () => {
  const user = await User.create({
    name: 'qee',
    password: 'secret',
    age: '20',
    meta: { level: 3 },
  });

  const write = adapter.lastWrite;
  assert.match(write.sql, /^INSERT INTO `users`/);
  assert.match(write.sql, /`create_time`/);
  assert.match(write.sql, /`update_time`/);
  assert.match(write.sql, /`meta`/);
  // JSON 字段在写库前已序列化
  assert.ok(write.bindings.some((value) => typeof value === 'string' && value.startsWith('{')));
  assert.equal(user.get('age'), 20);
  assert.deepEqual(user.get('meta'), { level: 3 });

  assert.equal(user.get('id'), 1);
  assert.equal(user.isExists(), true);
  assert.ok(user.get('create_time') instanceof Date);

  const array = user.toArray();
  assert.equal(array.password, undefined);
  assert.equal(array.name, 'qee');
  assert.equal(array.age, 20);
});

test('save：无脏数据不产生更新', async () => {
  const user = await User.create({ name: 'qee' });
  const writesBefore = adapter.writes.length;

  user.set('name', 'qee');
  await user.save();

  assert.equal(adapter.writes.length, writesBefore);
});

test('save：脏字段生成 UPDATE 并同步 origin', async () => {
  const user = await User.create({ name: 'qee' });
  user.set('name', 'next');
  await user.save();

  assert.equal(
    adapter.lastWrite.sql,
    'UPDATE `users` SET `name` = ?, `update_time` = ? WHERE `id` = ? AND `delete_time` IS NULL',
  );
  assert.equal(user.get('name'), 'next');

  // 再次 save 不应重复写
  const count = adapter.writes.length;
  await user.save();
  assert.equal(adapter.writes.length, count);
});

test('getter 参与读路径与序列化', () => {
  const user = new GetterUser({ name: 'qee' }, true);
  assert.equal(user.get('name'), 'QEE');
  assert.equal(user.toArray().name, 'QEE');
});

// ---------------------------------------------------------------- 查询
test('find / where / first / findOrFail', async () => {
  adapter.queueRows([{ id: 1, name: 'qee' }]);
  const user = await User.find(1);
  assert.ok(user instanceof User);
  assert.equal(user.get('name'), 'qee');
  assert.match(adapter.lastRead.sql, /^SELECT \* FROM `users` WHERE `id` = \?/);

  adapter.queueRows([]);
  await assert.rejects(() => User.findOrFail(404), ModelNotFoundException);

  adapter.queueRows([{ id: 2, name: 'a' }, { id: 3, name: 'b' }]);
  const rows = await User.where('status', 1).select();
  assert.equal(rows.length, 2);
  assert.ok(rows[0] instanceof User);
});

test('软删除：查询自动注入 delete_time IS NULL', async () => {
  adapter.queueRows([]);
  await User.where('status', 1).select();

  assert.match(adapter.lastRead.sql, /`delete_time` IS NULL/);
});

test('withTrashed / onlyTrashed 改变作用域', async () => {
  adapter.queueRows([]);
  await User.withTrashed().where('status', 1).select();
  assert.doesNotMatch(adapter.lastRead.sql, /delete_time/);

  adapter.queueRows([]);
  await User.onlyTrashed().select();
  assert.match(adapter.lastRead.sql, /`delete_time` IS NOT NULL/);
});

test('实例 delete：软删除改写 UPDATE；restore 恢复', async () => {
  const user = await User.create({ name: 'qee' });
  await user.delete();

  assert.match(adapter.lastWrite.sql, /^UPDATE `users` SET `delete_time` = \?/);
  assert.equal(user.trashed(), true);

  await user.restore();
  assert.match(adapter.lastWrite.sql, /^UPDATE `users` SET `delete_time` = \?/);
  assert.equal(user.trashed(), false);
});

test('物理删除 force', async () => {
  const user = await User.create({ name: 'qee' });
  await user.delete({ force: true });

  assert.match(adapter.lastWrite.sql, /^DELETE FROM `users`/);
  assert.equal(user.isExists(), false);
});

// ---------------------------------------------------------------- 事件
test('模型事件：beforeInsert 可改写实例数据', async () => {
  EventUser.on('beforeInsert', (instance) => {
    instance.set('name', 'from-event');
  });

  const user = await EventUser.create({ name: 'raw' });
  assert.equal(user.get('name'), 'from-event');
  assert.match(adapter.lastWrite.bindings.join(','), /from-event/);
});

// ---------------------------------------------------------------- 关联
test('with 预载入 hasMany 一次批量查询消除 N+1', async () => {
  adapter.queueRows([
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
  ]);
  adapter.queueRows([
    { id: 11, user_id: 1, title: 'p1' },
    { id: 12, user_id: 1, title: 'p2' },
  ]);

  const users = await User.with('posts').select();

  assert.equal(adapter.reads.length, 2);
  assert.match(adapter.lastRead.sql, /SELECT \* FROM `posts`/);
  assert.match(adapter.lastRead.sql, /`user_id` IN \(\?, \?\)/);
  assert.equal(users[0]._relations.posts.length, 2);
  assert.equal(users[1]._relations.posts.length, 0);
  assert.ok(users[0]._relations.posts[0] instanceof Post);
});

test('with 预载入 belongsTo', async () => {
  adapter.queueRows([
    { id: 1, user_id: 2, title: 'p1' },
  ]);
  adapter.queueRows([{ id: 2, name: 'owner' }]);

  const posts = await Post.with('user').select();
  assert.equal(posts[0]._relations.user.get('name'), 'owner');
});

test('with 嵌套路径 posts.comments', async () => {
  adapter.queueRows([{ id: 1, name: 'a' }]);
  adapter.queueRows([{ id: 11, user_id: 1, title: 'p1' }]);
  adapter.queueRows([
    { id: 21, post_id: 11, body: 'c1' },
    { id: 22, post_id: 11, body: 'c2' },
  ]);

  const users = await User.with('posts.comments').select();
  const posts = users[0]._relations.posts;
  assert.equal(posts.length, 1);
  assert.equal(posts[0]._relations.comments.length, 2);
  assert.equal(adapter.reads.length, 3);
});

test('with 预载入 belongsToMany 附带 pivot', async () => {
  adapter.queueRows([{ id: 1, name: 'a' }]);
  adapter.queueRows([{ user_id: 1, tag_id: 9 }]);
  adapter.queueRows([{ id: 9, name: 'hot' }]);

  const users = await User.with('tags').select();
  const tags = users[0]._relations.tags;
  assert.equal(tags.length, 1);
  assert.equal(tags[0].get('name'), 'hot');
  assert.deepEqual(tags[0].getPivot(), { user_id: 1, tag_id: 9 });
});

test('未定义关联给出明确错误', async () => {
  await assert.rejects(() => User.with('not_exists').select(), /未定义的关联/);
});

// ---------------------------------------------------------------- 事务
test('回调事务：begin/commit/release 且查询走事务连接', async () => {
  await User.transaction(async () => {
    await User.create({ name: 'tx' });
  });

  assert.deepEqual(
    adapter.txEvents.filter((e) => ['begin', 'commit', 'release'].includes(e)),
    ['begin', 'commit', 'release'],
  );
  assert.equal(adapter.writes[0].trx, true);
});

test('回调事务：异常回滚', async () => {
  await assert.rejects(
    () =>
      User.transaction(async () => {
        await User.create({ name: 'tx' });
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.ok(adapter.txEvents.includes('rollback'));
});

test('嵌套事务使用 SAVEPOINT，内层失败只回滚到保存点', async () => {
  await User.transaction(async () => {
    await User.create({ name: 'outer' });
    await assert.rejects(
      () =>
        User.transaction(async () => {
          await User.create({ name: 'inner' });
          throw new Error('inner-boom');
        }),
      /inner-boom/,
    );
  });

  assert.ok(adapter.txEvents.some((e) => e.startsWith('savepoint:qee_sp_1')));
  assert.ok(adapter.txEvents.some((e) => e.startsWith('rollbackTo:qee_sp_1')));
  assert.equal(adapter.txEvents.filter((e) => e === 'commit').length, 1);
});

// ---------------------------------------------------------------- 其它
test('QeeDB.table 与 Model 共用连接配置', () => {
  const connFromModel = User.getConnection();
  const connFromFacade = QeeDB.connection();
  assert.equal(connFromModel, connFromFacade);
  assert.equal(connFromModel.adapter, adapter);
});
