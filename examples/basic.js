'use strict';

/**
 * QeeDB 快速上手示例
 * ------------------------------------------------------------------
 * 运行前准备：
 *   CREATE DATABASE IF NOT EXISTS qeedb_demo DEFAULT CHARSET utf8mb4;
 *
 * 运行：
 *   MYSQL_HOST=127.0.0.1 MYSQL_USER=root MYSQL_PASSWORD=123456 \
 *   MYSQL_DATABASE=qeedb_demo node examples/basic.js
 */

import QeeDB from '../src/index.js';
const { Model } = QeeDB;

// ---------------------------------------------------------------- 配置
QeeDB.configure({
  default: 'mysql',
  connections: {
    mysql: {
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '123456',
      database: process.env.MYSQL_DATABASE || 'qeedb_demo',
      charset: 'utf8mb4',
      connectionLimit: 5,
    },
  },
});

// SQL 日志：打印慢查询
QeeDB.on('query', ({ sql, bindings, time }) => {
  if (time > 50) console.warn(`[slow ${time.toFixed(1)}ms] ${sql}`, bindings);
});

// ---------------------------------------------------------------- 模型
class User extends Model {
  static table = 'demo_users';
  static timestamps = true;
  static softDelete = 'delete_time';
  static hidden = ['password'];
  static casts = { age: 'int', profile: 'json' };
}

class Post extends Model {
  static table = 'demo_posts';
  static timestamps = true;
}

User.hasMany(Post, 'user_id', 'id', 'posts');
Post.belongsTo(User, 'user_id', 'id', 'user');

// ---------------------------------------------------------------- 演示
async function main() {
  const conn = QeeDB.connection();

  // 建表（仅示例，生产请使用独立 Migration 包）
  await conn.query('DROP TABLE IF EXISTS demo_posts');
  await conn.query('DROP TABLE IF EXISTS demo_users');
  await conn.query(`
    CREATE TABLE demo_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      password VARCHAR(64) NULL,
      age INT NULL,
      profile JSON NULL,
      status TINYINT NOT NULL DEFAULT 1,
      create_time DATETIME NULL,
      update_time DATETIME NULL,
      delete_time DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await conn.query(`
    CREATE TABLE demo_posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      title VARCHAR(128) NOT NULL,
      create_time DATETIME NULL,
      update_time DATETIME NULL,
      KEY idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 1. 创建（自动时间戳 + 主键回填 + JSON 序列化）
  const alice = await User.create({
    name: 'Alice',
    password: 'secret',
    age: '28',
    profile: { city: 'Suzhou', tags: ['orm', 'node'] },
  });
  console.log('created:', alice.get('id'), alice.toArray());

  // 2. 批量创建
  await User.createMany([
    { name: 'Bob', age: '31' },
    { name: 'Cindy', age: '25' },
  ]);
  await Post.createMany([
    { user_id: alice.get('id'), title: 'QeeDB 入门' },
    { user_id: alice.get('id'), title: 'ThinkORM 风格实践' },
  ]);

  // 3. 链式查询 + 分页
  const page = await User.where('age', '>=', 25).order('id', 'asc').paginate(1, 10);
  console.log('total:', page.total, 'names:', page.data.map((u) => u.get('name')));

  // 4. 关联预载入（一次批量 IN，无 N+1）
  const users = await User.with('posts').select();
  for (const user of users) {
    console.log(user.get('name'), 'posts:', user._relations.posts.map((p) => p.get('title')));
  }

  // 5. 更新与脏检查
  alice.set('age', 29);
  await alice.save();
  console.log('updated age:', (await User.find(alice.get('id'))).get('age'));

  // 6. 软删除与恢复
  const bob = await User.where('name', 'Bob').first();
  await bob.delete();
  console.log('after soft delete count:', await User.where('name', 'Bob').count());
  console.log('with trashed count:', await User.withTrashed().where('name', 'Bob').count());
  await bob.restore();

  // 7. 事务（嵌套 savepoint）
  await User.transaction(async () => {
    await User.create({ name: 'TxOuter' });
    try {
      await User.transaction(async () => {
        await User.create({ name: 'TxInner' });
        throw new Error('inner rollback');
      });
    } catch (err) {
      console.log('inner rolled back:', err.message);
    }
  });
  console.log('TxOuter exists:', await User.where('name', 'TxOuter').count());
  console.log('TxInner exists:', await User.where('name', 'TxInner').count());

  // 8. 调试 SQL
  console.log('fetchSql:', await User.where('status', 1).limit(3).fetchSql().select());
  console.log('toSql:', User.where({ name: 'Alice' }).toSql());
}

main()
  .then(() => QeeDB.close())
  .then(() => console.log('done'))
  .catch(async (err) => {
    console.error('example failed:', err);
    await QeeDB.close().catch(() => {});
    process.exitCode = 1;
  });
