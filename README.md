# QeeDB

> 面向 MySQL 的 **ThinkORM 风格** Node.js ORM：`class User extends Model {}` 即可获得完整 CRUD，
> 链式查询、自动时间戳、软删除、关联与预载入、事务与嵌套 savepoint、SQL 事件一应俱全。
>
> 版本：**1.0.0**｜Node.js ≥ 18｜唯一运行时依赖 `mysql2`

- 分层解耦：**Adapter（协议/池/事务）** 与 **Builder（SQL 方言）** 分离，新增数据库不改 Query/Model
- 安全：值全部参数化；标识符白名单校验；`where('a = 1')` 直接抛错，强制 `whereRaw`
- 可观测：全局 `query` 事件、`fetchSql()`、`toSql()`、统一异常码
- 轻量：无装饰器、无自动扫描，显式继承，学习成本低

---

## 快速开始

```bash
npm install qeedb mysql2
```

```js
const QeeDB = require('qeedb');
const { Model } = QeeDB;

QeeDB.configure({
  default: 'mysql',
  connections: {
    mysql: {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '123456',
      database: 'demo',
      charset: 'utf8mb4',
      connectionLimit: 10,
    },
  },
});

class User extends Model {
  static table = 'users';
  static timestamps = true;          // 自动维护 create_time / update_time
  static softDelete = 'delete_time'; // 软删除字段
  static hidden = ['password'];      // 序列化隐藏
  static casts = { age: 'int', meta: 'json' };
}

(async () => {
  const user = await User.create({ name: 'qee', password: 'secret', age: '20' });
  console.log(user.get('id'), user.toArray()); // password 不会出现在 toArray

  const page = await User.where('status', 1).order('id', 'desc').paginate(1, 10);
  console.log(page.total, page.data.length);

  const rows = await User.with('posts').limit(5).select(); // 一次批量预载入，避免 N+1
  console.log(rows[0]._relations.posts.length);
})();
```

> 完整可运行示例见 [`examples/basic.js`](examples/basic.js)（需本地 MySQL）。

---

## 核心概念

| 组件 | 职责 | 代码位置 |
| --- | --- | --- |
| `QeeDB` | 门面：配置、取连接、无模型查询、事务、注册方言、全局事件 | `src/QeeDB.js` |
| `ConnectionManager` | 按名管理连接单例 | `src/ConnectionManager.js` |
| `Connection` | 组合 Adapter + Builder；事务路由（ALS）；SQL 事件 | `src/Connection.js` |
| `TransactionContext` | AsyncLocalStorage 封装，事务内自动命中同一连接 | `src/TransactionContext.js` |
| `Adapter` / `MysqlAdapter` | 建池、执行、事务原语、错误归一 | `src/adapters/` |
| `Builder` / `MysqlBuilder` | 纯函数 SQL 方言生成 | `src/builders/` |
| `Query` / `ModelQuery` | 链式状态机、AST 归一、水合、软删作用域 | `src/query/` |
| `Model` | 静态转发、实例状态机、事件、关联注册 | `src/model/Model.js` |
| `concerns` | Timestamp / SoftDelete / Attribute / Event | `src/concerns/` |
| `relations` | hasOne / hasMany / belongsTo / belongsToMany + with 预载入 | `src/relations/` |

依赖方向固定为：**Model → Query → Connection → Adapter**；Builder 不依赖任何上层。

---

## 查询 API

### 链式方法

```js
QeeDB.table('users')
  .field('id', 'name as username')
  .where('status', 1)
  .where({ age: ['>', 18], role: ['admin', 'owner'] })
  .whereBetween('created_at', start, end)
  .whereRaw('LENGTH(name) > ?', [3])
  .leftJoin('posts', 'users.id', '=', 'posts.user_id')
  .group('users.id')
  .havingRaw('COUNT(posts.id) > ?', [0])
  .order('users.id desc')
  .limit(10, 20)
  .lock('update')
  .with('posts', 'posts.comments');
```

支持的 where 写法：

```js
where('id', 1)                          // =
where('age', '>', 18)                   // 显式运算符
where({ status: 1, name: 'qee' })       // 多条件 AND
where({ age: ['>', 18] })               // 运算符数组
where({ age: { '>=': 18, '<=': 30 } })  // 多运算符
where({ deleted_at: null })             // IS NULL
where({ role: ['admin', 'owner'] })     // IN
where([['a', '=', 1], ['b', 2]])        // 条件数组
where('a = 1')                          // ❌ 抛 InvalidQueryError（请用 whereRaw）
```

### 执行方法

| 类别 | 方法 | 返回 |
| --- | --- | --- |
| 读 | `select(...fields)` / `all()` | `T[]` |
| 读 | `first()` / `find(id)` | `T \| null` |
| 读 | `findOrFail(id)` | `T`（不存在抛 `ModelNotFoundException`） |
| 读 | `value(field)` / `column(field)` | 单个值 / 值数组（不水合） |
| 聚合 | `count` / `sum` / `max` / `min` / `avg` / `exists` | 标量 / 布尔 |
| 写 | `insert` / `insertGetId` / `insertAll` | `{ affectedRows, insertId, changedRows }` |
| 写 | `update` / `setInc` / `setDec` / `delete` | 同上 |
| 分页 | `paginate(page, perPage)` | `{ data, total, per_page, current_page, last_page, has_more }` |
| 批处理 | `chunk(size, cb)` / `cursor(size)` | 分块回调 / 异步迭代器 |
| 调试 | `fetchSql()` / `toSql()` / `getState()` / `clone()` | SQL 结构 / 可读 SQL / 状态快照 / 副本 |

```js
// 只构造不执行（调试 / 审计）
const built = await User.where('id', 1).fetchSql().select();
// → { sql: 'SELECT * FROM `users` WHERE `id` = ?', bindings: [1] }

// 可读 SQL（绑定值内联，仅用于日志）
User.where({ id: 1, name: 'qee' }).toSql();
// → "SELECT * FROM `users` WHERE `id` = 1 AND `name` = 'qee'"
```

---

## 模型

### 静态配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `table` | 类名下划线复数 | `UserProfile` → `user_profiles` |
| `pk` | `'id'` | 主键字段 |
| `connection` | `'default'` | 连接名 |
| `timestamps` | `false` | 自动维护时间戳 |
| `createTime` / `updateTime` | `create_time` / `update_time` | 时间字段名 |
| `timestampType` | `'datetime'` | `'datetime'` 或 `'int'`（Unix 秒） |
| `softDelete` | `false` | `'delete_time'` 或 `true` |
| `softDeleteDefault` | `null` | 未删除判定值；设为 `0` 时删除标记写 Unix 秒 |
| `hidden` / `visible` | `[]` | 序列化控制 |
| `appends` | `[]` | 序列化追加属性（getter / 关联） |
| `casts` | `{}` | `int`/`float`/`bool`/`string`/`json`/`date`/`array` |
| `getters` / `setters` | `{}` | 访问器 / 修改器 |

```js
class Order extends Model {
  static table = 'orders';
  static timestamps = true;
  static timestampType = 'int';        // 兼容 int(10) 时间戳表
  static softDelete = 'delete_time';
  static casts = { amount: 'float', extra: 'json' };
  static getters = {
    amount(value) { return Number(value).toFixed(2); },
  };
}
```

### 静态方法

```js
await User.find(1);
await User.where('status', 1).select();
await User.create({ name: 'qee' });
await User.createMany([{ name: 'a' }, { name: 'b' }]);
await User.update({ status: 0 });
await User.destroy([1, 2, 3]);
await User.paginate(2, 15);
await User.transaction(async () => { /* ... */ });
User.on('beforeInsert', (user) => user.set('name', user.get('name').trim()));
```

### 实例方法

```js
const user = new User({ name: 'qee' });
await user.save();            // 首次插入，回填主键，维护时间戳
user.set('name', 'next');
await user.save();            // 脏检查，无变化不写库
await user.update({ age: 21 });
await user.delete();          // 软删除模型改写为 UPDATE
await user.restore();
await user.refresh();
await user.load('posts');
user.toArray();               // 应用 casts/getter/hidden/visible/appends
```

保存时序（与设计文档 3.5.4 一致）：

```
插入：beforeSave → beforeInsert → 注入 createTime/updateTime
     → INSERT → 回填 pk → _exists=true → afterInsert → afterSave
更新：脏检查 → 无变化直接返回
     → beforeSave → beforeUpdate → 注入 updateTime
     → UPDATE(WHERE pk) → 同步 _origin → afterUpdate → afterSave
```

---

## 关联

```js
class User extends Model {
  static table = 'users';
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

User.hasMany(Post, 'user_id', 'id', 'posts');
User.belongsToMany(Tag, 'user_tag', 'user_id', 'tag_id', 'tags');
Post.belongsTo(User, 'user_id', 'id', 'user');
Post.hasMany(Comment, 'post_id', 'id', 'comments');

const users = await User.with('posts.comments').select(); // 3 次查询，无 N+1
users[0]._relations.posts[0]._relations.comments;         // 已回填
```

| 类型 | 签名 | 查询语义 |
| --- | --- | --- |
| `hasOne` | `hasOne(Target, fk, localKey?, name?)` | 父主键 → 目标外键，取一条 |
| `hasMany` | `hasMany(Target, fk, localKey?, name?)` | 父主键 → 目标外键，取多条 |
| `belongsTo` | `belongsTo(Target, fk, ownerKey?, name?)` | 父外键 → 目标主键 |
| `belongsToMany` | `belongsToMany(Target, pivot, fk, rk, name?)` | 中间表批量 IN，附 `_pivot` |

嵌套 `with` 逐段批量预载入；关联名未注册时会在查询阶段直接抛出带可用关联列表的错误。

---

## 事务

```js
// 顶层事务：BEGIN → ALS.run(cb) → COMMIT / ROLLBACK → release
await User.transaction(async () => {
  await User.create({ name: 'outer' });

  // 同连接嵌套：自动 SAVEPOINT qee_sp_n，内层失败只回滚到保存点
  await User.transaction(async () => {
    await User.create({ name: 'inner' });
    throw new Error('inner failed'); // 只撤销内层
  });
});
```

事务上下文基于 `AsyncLocalStorage`：事务内任意 `Query` / `Model` 调用自动命中事务连接，无需手动传参，并发请求之间天然隔离。

---

## 事件与日志

```js
// 模型事件：beforeInsert/afterInsert/beforeUpdate/afterUpdate/
//          beforeSave/afterSave/beforeDelete/afterDelete/beforeSelect/afterFind
User.on('afterInsert', (user) => console.log('created', user.get('id')));

// 全局 SQL 事件
QeeDB.on('query', ({ sql, bindings, time, connection, type, transaction }) => {
  if (time > 100) console.warn(`[slow ${time}ms]`, sql, bindings);
});
```

---

## 错误体系

```
QeeDBError
├─ ConfigError
├─ ConnectionError
│  └─ ConnectionLostError
├─ QueryError
│  ├─ DuplicateKeyError        (ER_DUP_ENTRY)
│  ├─ ForeignKeyError          (ER_NO_REFERENCED_ROW_2 等)
│  └─ InvalidQueryError        (非法标识符 / where 字符串条件)
├─ ModelError
│  └─ ModelNotFoundException
├─ TransactionError
└─ NotSupportedError
```

Adapter 的 `normalizeError` 会保留 `sql`、`bindings`、驱动原始 `code` / `errno` / `cause`。

---

## 扩展数据库

设计文档要求「新增数据库零改 Query/Model 层」，接入只需两步：

```js
// 1) 实现 Adapter（连接协议 + 执行 + 事务）
class PgAdapter extends Adapter { /* pool.query → { rows, rowCount } */ }

// 2) 实现 Builder（方言）
class PgBuilder extends Builder {
  escapeId(name) { /* "public"."users" */ }
  placeholder(index) { return `$${index + 1}`; }
  buildInsert(state) { /* RETURNING id */ }
}

QeeDB.registerAdapter('pg', PgAdapter);
QeeDB.registerBuilder('pg', PgBuilder);
// 连接配置 driver: 'pg' 即生效
```

完整示例（含 `RETURNING id`、`$n` 占位符、`ON CONFLICT` 思路）见 [`docs/extending.md`](docs/extending.md)。

---

## 项目结构

```
qeedb/
├── src/
│   ├── index.js                # 统一出口（门面 + 类 + 异常）
│   ├── QeeDB.js                # 门面
│   ├── Connection.js           # 连接 + 事务路由 + SQL 事件
│   ├── ConnectionManager.js
│   ├── TransactionContext.js   # AsyncLocalStorage
│   ├── registry.js             # Adapter/Builder 注册表
│   ├── manager.js              # 全局 manager 单例
│   ├── events.js               # 轻量事件总线
│   ├── adapters/               # Adapter 基类 + MysqlAdapter
│   ├── builders/               # Builder 基类 + MysqlBuilder
│   ├── query/                  # Query + ModelQuery
│   ├── model/Model.js          # Model 基类
│   ├── concerns/               # Timestamp / SoftDelete / Attribute / Event
│   ├── relations/              # 四种关联 + eager 预载入
│   ├── exceptions/             # 统一异常体系
│   └── utils/                  # identifier 校验 / 通用工具
├── test/
│   ├── unit/                   # Builder 快照、Query、Model、Adapter（66 用例）
│   ├── integration/            # 真实 MySQL 集成（默认跳过）
│   └── helpers/                # FakeAdapter + 测试装配
├── types/index.d.ts            # 公共 API 类型声明
├── docs/                       # 架构、扩展、进度说明
├── examples/basic.js
├── README.md
└── CHANGELOG.md
```

---

## 测试

```bash
npm run test:unit        # 单元测试（无需数据库）
npm test                 # 单元 + 集成（集成默认 skip）

# 真实 MySQL 集成：
docker run -d --name qeedb-mysql \
  -e MYSQL_ROOT_PASSWORD=123456 -e MYSQL_DATABASE=qeedb_test \
  -p 3306:3306 mysql:8.0

QEEDB_TEST_MYSQL=1 MYSQL_PASSWORD=123456 npm run test:integration
npm run typecheck        # 校验 types/index.d.ts
npm run coverage         # c8 覆盖率（行覆盖门槛 80%）
```

单元测试覆盖：

- Builder：SELECT / WHERE AST / JOIN / GROUP / HAVING / LIMIT / INSERT / INSERT ALL / UPSERT / UPDATE（含自增）/ DELETE / 聚合 / EXISTS / 非法运算符
- 标识符：点号、别名、通配符、非法注入拒绝、缓存
- Query：链式归一、fetchSql、insertAll 分批、setInc、paginate、chunk、value/column、clone 隔离
- Model：配置解析、创建/更新时序、脏检查、软删除与恢复、事件、四种关联与嵌套 with、事务与 savepoint
- MysqlAdapter：池参数、结果原型剥离、错误映射、只读池路由（mysql2 以桩替换）

---

## 1.0 边界（与设计文档一致）

- 不做 Migration / Schema Builder（由独立包提供）
- 不做分库分表；`read` 配置已解析并路由只读查询，但不做延迟复制同步
- `cursor()` 当前基于分页实现（非流式 ResultSet），后续版本替换为流式读取
- `union` 状态位已预留，链式方法留待 1.1
- 类型声明覆盖公共 API，复杂链式泛型推断后续增强

---

## License

MIT

> （注：部分内容由豆包 AI 生成）