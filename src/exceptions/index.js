'use strict';

/**
 * QeeDB 统一异常体系
 * ------------------------------------------------------------------
 * 设计文档 3.10：所有异常继承自 QeeDBError，Adapter 层 normalizeError
 * 负责把驱动错误映射到这里的类型，并携带 sql / bindings / code。
 *
 * 约定：
 *  - `code` 用于程序判定（稳定字符串），不要依赖 message 文本做判断；
 *  - `cause` 保留原始驱动错误，便于排查；
 *  - 抛出时尽量带上 sql 与 bindings，但不包含敏感数据之外的额外信息。
 */

class QeeDBError extends Error {
  /**
   * @param {string} message 错误信息
   * @param {{code?: string, sql?: string, bindings?: any[], cause?: Error}} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || this.constructor.code || 'QEEDB_ERROR';
    this.sql = options.sql;
    this.bindings = options.bindings;
    if (options.cause) this.cause = options.cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }
}

/** 配置错误：缺少连接配置、未知驱动、非法参数等 */
class ConfigError extends QeeDBError {}
ConfigError.code = 'QEEDB_CONFIG_ERROR';

/** 连接错误：连库失败、获取连接超时等 */
class ConnectionError extends QeeDBError {}
ConnectionError.code = 'QEEDB_CONNECTION_ERROR';

/** 连接中断：驱动报 PROTOCOL_CONNECTION_LOST 等 */
class ConnectionLostError extends ConnectionError {}
ConnectionLostError.code = 'QEEDB_CONNECTION_LOST';

/** 查询错误：SQL 执行失败或语句构造失败 */
class QueryError extends QeeDBError {}
QueryError.code = 'QEEDB_QUERY_ERROR';

/** 唯一键冲突 */
class DuplicateKeyError extends QueryError {}
DuplicateKeyError.code = 'QEEDB_DUPLICATE_KEY';

/** 外键约束失败 */
class ForeignKeyError extends QueryError {}
ForeignKeyError.code = 'QEEDB_FOREIGN_KEY';

/** 非法查询：如 where('a = 1') 传字符串条件、非法标识符 */
class InvalidQueryError extends QueryError {}
InvalidQueryError.code = 'QEEDB_INVALID_QUERY';

/** 模型错误 */
class ModelError extends QeeDBError {}
ModelError.code = 'QEEDB_MODEL_ERROR';

/** 模型记录不存在（findOrFail） */
class ModelNotFoundException extends ModelError {}
ModelNotFoundException.code = 'QEEDB_MODEL_NOT_FOUND';

/** 事务错误 */
class TransactionError extends QeeDBError {}
TransactionError.code = 'QEEDB_TRANSACTION_ERROR';

/** 未实现能力：未注册的方言、尚未支持的方法 */
class NotSupportedError extends QeeDBError {}
NotSupportedError.code = 'QEEDB_NOT_SUPPORTED';

export {
  QeeDBError,
  ConfigError,
  ConnectionError,
  ConnectionLostError,
  QueryError,
  DuplicateKeyError,
  ForeignKeyError,
  InvalidQueryError,
  ModelError,
  ModelNotFoundException,
  TransactionError,
  NotSupportedError,
};
