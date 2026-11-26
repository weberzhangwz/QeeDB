# Changelog

所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本（SemVer）。

## [1.0.0] - 2026-11-22

首个正式版本，覆盖设计文档 MS1–MS6 核心能力。

### Added

- **门面**：`QeeDB.configure / connection / table / transaction / registerAdapter / registerBuilder / on / close`
- **Adapter**：抽象契约 + `MysqlAdapter`（连接池、只读池路由骨架、query/execute、事务原语、错误归一）
- **Builder**：抽象契约 + `MysqlBuilder`（SELECT/INSERT/INSERT ALL/UPSERT/UPDATE/DELETE/聚合/EXISTS，WHERE AST 全类型）
- **Connection**：延迟连接、事务路由（AsyncLocalStorage）、SQL `query` 事件
- **TransactionContext**：并发隔离、嵌套事务 savepoint
- **Query**：链式状态机、where 多形态归一、join/group/having/order/limit/lock、`fetchSql/toSql/clone`
- **Query 执行**：find/first/select/all/value/column、count/sum/max/min/avg/exists、insert/insertGetId/insertAll（500 分批）、update/setInc/setDec/delete、paginate/chunk/cursor
- **Model**：静态配置解析、静态链式转发、实例水合、save 时序、脏检查、refresh、toArray/toJSON
- **concerns**：Timestamp（datetime/int）、SoftDelete（作用域/恢复/force）、Attribute（casts/getter/setter/hidden/visible/appends）、Event（模型事件 + boot）
- **relations**：hasOne / hasMany / belongsTo / belongsToMany（pivot）、`with` 嵌套预载入
- **异常体系**：12 类异常，Adapter 错误映射到统一类型并保留 sql/bindings/code
- **类型声明**：`types/index.d.ts` 覆盖公共 API
- **测试**：66 个单元用例（Builder 快照、Query、Model、Adapter 桩）+ MySQL 集成测试脚手架；c8 行覆盖 83.42%（门槛 80%）
- **文档**：README、architecture、extending、progress；示例 `examples/basic.js`；CI 工作流

### Known limitations

- `union()` 链式方法未提供（状态位与 Builder 片段能力已预留）
- `cursor()` 基于分页实现，非流式 ResultSet
- 读写分离仅配置解析与只读池路由，无延迟复制一致性策略
- `belongsToMany` 暂无 attach/detach/sync 辅助方法
