'use strict';

/**
 * QeeDB 统一出口
 * ------------------------------------------------------------------
 * 双形态使用：
 *   const QeeDB = require('qeedb');
 *   // 或
 *   const { QeeDB, Model } = require('qeedb');
 *
 * 版本 1.0.0：MySQL 完整实现；注册机制预留 PostgreSQL / SQLite。
 */

import { QeeDBFacade } from './QeeDB.js';
import Model from './model/Model.js';
import Query from './query/Query.js';
import ModelQuery from './query/ModelQuery.js';
import Connection from './Connection.js';
import ConnectionManager from './ConnectionManager.js';
import Adapter from './adapters/Adapter.js';
import MysqlAdapter from './adapters/MysqlAdapter.js';
import Builder from './builders/Builder.js';
import MysqlBuilder from './builders/MysqlBuilder.js';
import * as TransactionContext from './TransactionContext.js';
import * as exceptions from './exceptions/index.js';
import * as identifierUtils from './utils/identifier.js';

/** 门面单例 */
const QeeDB = new QeeDBFacade();

// 挂载所有公共类型，支持解构导入与扩展开发
Object.assign(QeeDB, {
  QeeDB,
  Model,
  Query,
  ModelQuery,
  Connection,
  ConnectionManager,
  Adapter,
  MysqlAdapter,
  Builder,
  MysqlBuilder,
  TransactionContext,
  exceptions,
  utils: { escapeId: identifierUtils.escapeId },
  // 扁平导出异常类，便于 `const { DuplicateKeyError } = require('qeedb')`
  ...exceptions,
});

// CommonJS ↔ ESM 互操作
QeeDB.default = QeeDB;

export {
  Model,
  Query,
  ModelQuery,
  Connection,
  ConnectionManager,
  Adapter,
  MysqlAdapter,
  Builder,
  MysqlBuilder,
  TransactionContext,
  exceptions,
};

// 扁平导出异常类，支持 `import { DuplicateKeyError } from 'qeedb'`
export * from './exceptions/index.js';

export default QeeDB;
