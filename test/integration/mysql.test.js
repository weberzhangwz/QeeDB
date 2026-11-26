'use strict';

/**
 * 集成测试：真实 MySQL（默认跳过）
 * ------------------------------------------------------------------
 * 运行方式：
 *   QEEDB_TEST_MYSQL=1 MYSQL_HOST=127.0.0.1 MYSQL_USER=root \
 *   MYSQL_PASSWORD=123456 MYSQL_DATABASE=qeedb_test npm run test:integration
 *
 * 也可用 Docker：
 *   docker run -d --name qeedb-mysql -e MYSQL_ROOT_PASSWORD=123456 \
 *     -e MYSQL_DATABASE=qeedb_test -p 3306:3306 mysql:8.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import QeeDB from '../../src/index.js';
import { Model } from '../../src/index.js';

const enabled = process.env.QEEDB_TEST_MYSQL === '1';

const MYSQL = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '123456',
  database: process.env.MYSQL_DATABASE || 'qeedb_test',
  connectionLimit: 5,
};

// ---------------------------------------------------------------- 模型定义
class User extends Model {
  static table = 'it_users';
  static timestamps = true;
  static softDelete = 'delete_time';
  static hidden = ['password'];
  static casts = { age: 'int', meta: 'json' };
}
class Post extends Model {
  static table = 'it_posts';
  static timestamps = true;
}
class Comment extends Model {
  static table = 'it_comments';
}
class Tag extends Model {
  static table = 'it_tags';
}

User.hasMany(Post, 'user_id', 'id', 'posts');
Post.belongsTo(User, 'user_id', 'id', 'user');
Post.hasMany(Comment, 'post_id', 'id', 'comments');
User.belongsToMany(Tag, 'it_user_tag', 'user_id', 'tag_id', 'tags');

// ---------------------------------------------------------------- DDL
const DDL = [
  `DROP TABLE IF EXISTS it_user_tag`,
  `DROP TABLE IF EXISTS it_comments`,
  `DROP TABLE IF EXISTS it_posts`,
  `DROP TABLE IF EXISTS it_tags`,
  `DROP TABLE IF EXISTS it_users`,
  `CREATE TABLE it_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    password VARCHAR(64) NULL,
    age INT NULL,
    meta JSON NULL,
    status TINYINT NOT NULL DEFAULT 0,
    create_time DATETIME NULL,
    update_time DATETIME NULL,
    delete_time DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE it_posts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(128) NOT NULL,
    create_time DATETIME NULL,
    update_time DATETIME NULL,
    KEY idx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE it_comments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    post_id INT NOT NULL,
    body VARCHAR(255) NOT NULL,
    KEY idx_post (post_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE it_tags (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE it_user_tag (
    user_id INT NOT NULL,
    tag_id INT NOT NULL,
    PRIMARY KEY (user_id, tag_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

test('MySQL 集成：CRUD / 事务 / 软删 / 关联预载入', { skip: !enabled }, async (t) => {
  QeeDB.configure({ default: 'mysql', connections: { mysql: MYSQL } });
  const conn = QeeDB.connection('mysql');

  // 建表
  for (const sql of DDL) await conn.query(sql);

  try {
    // ---------------------------------------------------------- 插入 / 查询
    const alice = await User.create({
      name: 'alice',
      password: 'secret',
      age: 20,
      meta: { from: 'test' },
      status: 1,
    });
    assert.equal(alice.get('id'), 1);
    assert.ok(alice.get('create_time') instanceof Date);

    const found = await User.find(1);
    assert.equal(found.get('name'), 'alice');
    assert.equal(found.get('age'), 20);
    assert.deepEqual(found.get('meta'), { from: 'test' });

    // ---------------------------------------------------------- 更新
    found.set('name', 'alice2');
    await found.save();
    const reread = await User.find(1);
    assert.equal(reread.get('name'), 'alice2');

    // ---------------------------------------------------------- 批量插入 + 聚合
    await Post.createMany([
      { user_id: 1, title: 'p1' },
      { user_id: 1, title: 'p2' },
      { user_id: 1, title: 'p3' },
    ]);
    assert.equal(await Post.where('user_id', 1).count(), 3);

    // ---------------------------------------------------------- 关联预载入
    const users = await User.with('posts').select();
    assert.equal(users[0]._relations.posts.length, 3);

    await Comment.createMany([
      { post_id: 1, body: 'c1' },
      { post_id: 1, body: 'c2' },
    ]);
    const nested = await User.with('posts.comments').select();
    assert.equal(nested[0]._relations.posts[0]._relations.comments.length, 2);

    // ---------------------------------------------------------- 多对多
    const tag = await Tag.create({ name: 'hot' });
    await conn.execute('INSERT INTO it_user_tag (user_id, tag_id) VALUES (?, ?)', [1, tag.get('id')]);
    const withTags = await User.with('tags').select();
    assert.equal(withTags[0]._relations.tags[0].get('name'), 'hot');

    // ---------------------------------------------------------- 事务回滚
    await assert.rejects(
      () =>
        User.transaction(async () => {
          await User.create({ name: 'rollback-me' });
          throw new Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(await User.where('name', 'rollback-me').count(), 0);

    // ---------------------------------------------------------- 嵌套事务（savepoint）
    await User.transaction(async () => {
      await User.create({ name: 'outer' });
      await assert.rejects(
        () =>
          User.transaction(async () => {
            await User.create({ name: 'inner' });
            throw new Error('inner');
          }),
        /inner/,
      );
    });
    assert.equal(await User.where('name', 'outer').count(), 1);
    assert.equal(await User.where('name', 'inner').count(), 0);

    // ---------------------------------------------------------- 软删除 / 恢复
    const victim = await User.create({ name: 'soft' });
    await victim.delete();
    assert.equal(await User.where('name', 'soft').count(), 0);
    assert.equal(await User.withTrashed().where('name', 'soft').count(), 1);

    await victim.restore();
    assert.equal(await User.where('name', 'soft').count(), 1);

    // ---------------------------------------------------------- 分页
    const page = await User.paginate(1, 2);
    assert.equal(page.per_page, 2);
    assert.ok(page.total >= 3);
    assert.equal(page.data.length, 2);
  } finally {
    for (const sql of DDL.slice(0, 5)) await conn.query(sql);
    await QeeDB.close();
  }
});
