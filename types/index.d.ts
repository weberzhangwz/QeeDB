/**
 * QeeDB 1.0 类型声明
 * ------------------------------------------------------------------
 * 覆盖公共 API（QeeDB 门面 / Query / Model / 异常 / 扩展点）。
 * 复杂链式泛型与自定义方言的类型推断留待后续版本细化。
 */

export type Binding = unknown;
export type Bindings = Binding[];

export interface BuiltSql {
  sql: string;
  bindings: Bindings;
}

export interface WriteResult {
  affectedRows: number;
  insertId: number | string | null;
  changedRows: number;
}

export interface PaginationResult<T> {
  data: T[];
  total: number;
  per_page: number;
  current_page: number;
  last_page: number;
  has_more: boolean;
}

export interface QueryEvent {
  sql: string;
  bindings: Bindings;
  /** 执行耗时（毫秒） */
  time: number;
  /** 连接名 */
  connection: string;
  driver: string;
  type: 'read' | 'write';
  transaction: boolean;
}

export interface ConnectionConfig {
  driver?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  charset?: string;
  timezone?: string;
  connectionLimit?: number;
  waitForConnections?: boolean;
  queueLimit?: number;
  connectTimeout?: number;
  acquireTimeout?: number;
  /** 只读池配置（预留读写分离） */
  read?: Partial<ConnectionConfig>;
  [key: string]: unknown;
}

export interface QeeDBOptions {
  default?: string;
  connections?: Record<string, ConnectionConfig>;
  driver?: string;
  [key: string]: unknown;
}

/** ---------------------------------------------------------------- Query */
export declare class Query<T = Record<string, any>> {
  constructor(connection: Connection);

  // 状态
  table(table: string, alias?: string): this;
  alias(alias: string): this;
  field(...fields: Array<string | Record<string, string>>): this;
  fieldRaw(expr: string, alias?: string): this;
  distinct(value?: boolean | string[]): this;

  // where
  where(field: string, value: any): this;
  where(field: string, op: string, value: any): this;
  where(conditions: Record<string, any> | any[]): this;
  whereOr(field: string, op: string, value: any): this;
  whereOr(conditions: Record<string, any>): this;
  whereIn(field: string, values: any[], boolean?: 'AND' | 'OR'): this;
  whereNotIn(field: string, values: any[], boolean?: 'AND' | 'OR'): this;
  whereNull(field: string, boolean?: 'AND' | 'OR'): this;
  whereNotNull(field: string, boolean?: 'AND' | 'OR'): this;
  whereBetween(field: string, min: any, max: any, boolean?: 'AND' | 'OR'): this;
  whereNotBetween(field: string, min: any, max: any, boolean?: 'AND' | 'OR'): this;
  whereLike(field: string, pattern: string, boolean?: 'AND' | 'OR'): this;
  whereRaw(sql: string, bindings?: Bindings, boolean?: 'AND' | 'OR'): this;

  // join / group / having
  join(table: string, left: string, right: string): this;
  join(table: string, left: string, op: string, right: string): this;
  leftJoin(table: string, left: string, op: string, right: string): this;
  rightJoin(table: string, left: string, op: string, right: string): this;
  group(...fields: Array<string | string[]>): this;
  having(field: string, op: string, value: any): this;
  havingRaw(sql: string, bindings?: Bindings, boolean?: 'AND' | 'OR'): this;

  // order / limit
  order(field: string, direction?: 'asc' | 'desc' | 'ASC' | 'DESC'): this;
  order(conditions: Record<string, 'asc' | 'desc'> | string[]): this;
  limit(limit: number, offset?: number): this;
  offset(offset: number): this;
  page(page: number, perPage?: number): this;
  lock(mode?: 'update' | 'share'): this;

  // 关联 / 软删 / 调试
  with(...relations: Array<string | string[]>): this;
  withTrashed(): this;
  onlyTrashed(): this;
  fetchSql(value?: boolean): this;
  useWrite(value?: boolean): this;
  clone(): this;
  getState(): Record<string, any>;
  toSql(): string;

  // 执行：读
  select(...fields: string[]): Promise<T[]>;
  all(): Promise<T[]>;
  first(...fields: string[]): Promise<T | null>;
  find(id: any): Promise<T | null>;
  findOrFail(id: any): Promise<T>;
  value<V = any>(field: string): Promise<V | null>;
  column<V = any>(field: string): Promise<V[]>;

  // 执行：聚合
  count(field?: string, distinct?: boolean): Promise<number>;
  sum(field: string): Promise<number | string | null>;
  max(field: string): Promise<number | string | null>;
  min(field: string): Promise<number | string | null>;
  avg(field: string): Promise<number | string | null>;
  exists(): Promise<boolean>;

  // 执行：写
  insert(data: Record<string, any>): Promise<WriteResult>;
  insertGetId(data: Record<string, any>): Promise<number | string | null>;
  insertAll(rows: Array<Record<string, any>>): Promise<WriteResult>;
  update(data: Record<string, any>): Promise<WriteResult>;
  setInc(field: string, amount?: number): Promise<WriteResult>;
  setDec(field: string, amount?: number): Promise<WriteResult>;
  delete(): Promise<WriteResult>;

  // 分页 / 批处理
  paginate(page?: number, perPage?: number): Promise<PaginationResult<T>>;
  chunk(size: number, callback: (rows: T[], page: number) => unknown | false | Promise<unknown | false>): Promise<this>;
  cursor(size?: number): AsyncGenerator<T, void, unknown>;
}

export declare class ModelQuery<T = Record<string, any>> extends Query<T> {
  constructor(ModelClass: typeof Model, connection: Connection);
  forceDelete(): Promise<WriteResult>;
}

/** ---------------------------------------------------------------- Model */
export declare class Model {
  constructor(data?: Record<string, any>, exists?: boolean);

  // 静态配置（子类通过 static 字段覆盖）
  static table: string;
  static pk: string;
  static connection: string;
  static timestamps: boolean;
  static createTime: string;
  static updateTime: string;
  static timestampType: 'datetime' | 'int';
  static softDelete: false | true | string;
  static softDeleteDefault: any;
  static hidden: string[];
  static visible: string[];
  static appends: string[];
  static casts: Record<string, 'int' | 'float' | 'bool' | 'string' | 'json' | 'date' | 'array'>;
  static getters: Record<string, (value: any, instance: any) => any>;
  static setters: Record<string, (value: any, instance: any) => any>;

  // 静态：连接与查询
  static getConnection(): Connection;
  static getTable(): string;
  static getSoftDeleteField(): string | false;
  static query(): ModelQuery<Model>;

  // 静态：读
  static find<T extends Model>(this: new (...args: any[]) => T, id: any): Promise<T | null>;
  static findOrFail<T extends Model>(this: new (...args: any[]) => T, id: any): Promise<T>;
  static select<T extends Model>(this: new (...args: any[]) => T, ...fields: string[]): Promise<T[]>;
  static all<T extends Model>(this: new (...args: any[]) => T): Promise<T[]>;
  static first<T extends Model>(this: new (...args: any[]) => T, ...fields: string[]): Promise<T | null>;
  static value(field: string): Promise<any>;
  static column(field: string): Promise<any[]>;
  static count(field?: string, distinct?: boolean): Promise<number>;
  static sum(field: string): Promise<any>;
  static max(field: string): Promise<any>;
  static min(field: string): Promise<any>;
  static avg(field: string): Promise<any>;
  static exists(): Promise<boolean>;

  // 静态：写
  static create<T extends Model>(this: new (...args: any[]) => T, data?: Record<string, any>): Promise<T>;
  static createMany<T extends Model>(this: new (...args: any[]) => T, rows?: Array<Record<string, any>>): Promise<T[]>;
  static insert(data: Record<string, any>): Promise<WriteResult>;
  static insertAll(rows: Array<Record<string, any>>): Promise<WriteResult>;
  static insertGetId(data: Record<string, any>): Promise<number | string | null>;
  static update(data: Record<string, any>): Promise<WriteResult>;
  static delete(): Promise<WriteResult>;
  static destroy(ids: any | any[]): Promise<WriteResult>;

  // 静态：链式转发（返回 ModelQuery，可继续链式）
  static where(...args: any[]): ModelQuery;
  static whereOr(...args: any[]): ModelQuery;
  static whereIn(field: string, values: any[], boolean?: 'AND' | 'OR'): ModelQuery;
  static whereNotIn(field: string, values: any[], boolean?: 'AND' | 'OR'): ModelQuery;
  static whereNull(field: string, boolean?: 'AND' | 'OR'): ModelQuery;
  static whereNotNull(field: string, boolean?: 'AND' | 'OR'): ModelQuery;
  static whereBetween(field: string, min: any, max: any, boolean?: 'AND' | 'OR'): ModelQuery;
  static whereLike(field: string, pattern: string): ModelQuery;
  static whereRaw(sql: string, bindings?: Bindings): ModelQuery;
  static order(field: string | Record<string, any>, direction?: string): ModelQuery;
  static field(...fields: string[]): ModelQuery;
  static limit(limit: number, offset?: number): ModelQuery;
  static offset(offset: number): ModelQuery;
  static page(page: number, perPage?: number): ModelQuery;
  static join(...args: any[]): ModelQuery;
  static leftJoin(...args: any[]): ModelQuery;
  static group(...fields: string[]): ModelQuery;
  static having(...args: any[]): ModelQuery;
  static alias(alias: string): ModelQuery;
  static distinct(value?: boolean): ModelQuery;
  static lock(mode?: string): ModelQuery;
  static with(...relations: Array<string | string[]>): ModelQuery;
  static withTrashed(): ModelQuery;
  static onlyTrashed(): ModelQuery;
  static fetchSql(value?: boolean): ModelQuery;

  // 静态：分页 / 事务 / 事件
  static paginate(page?: number, perPage?: number): Promise<PaginationResult<any>>;
  static chunk(size: number, callback: (rows: any[], page: number) => unknown | false | Promise<unknown | false>): Promise<ModelQuery>;
  static cursor(size?: number): AsyncGenerator<any, void, unknown>;
  static transaction<T = any>(cb: (connection: Connection) => Promise<T> | T): Promise<T>;
  static on(event: string, handler: (payload: any) => void): typeof Model;
  static off(event: string, handler: (payload: any) => void): typeof Model;
  static boot(): void;

  // 静态：关联定义
  static hasOne(Target: typeof Model, foreignKey?: string, localKey?: string, name?: string): Relation;
  static hasMany(Target: typeof Model, foreignKey?: string, localKey?: string, name?: string): Relation;
  static belongsTo(Target: typeof Model, foreignKey?: string, ownerKey?: string, name?: string): Relation;
  static belongsToMany(
    Target: typeof Model,
    pivot: string,
    foreignPivotKey: string,
    relatedPivotKey: string,
    name?: string,
  ): Relation;

  // 实例
  get(key?: string): any;
  getRaw(key?: string): any;
  getData(): Record<string, any>;
  set(key: string | Record<string, any>, value?: any): this;
  has(key: string): boolean;
  isExists(): boolean;
  getPivot(): Record<string, any> | null;
  hidden(...fields: string[]): this;
  visible(...fields: string[]): this;
  append(...fields: string[]): this;
  toArray(): Record<string, any>;
  toJSON(): Record<string, any>;
  save(): Promise<this>;
  delete(options?: { force?: boolean }): Promise<WriteResult>;
  update(data?: Record<string, any>): Promise<this>;
  restore(): Promise<this>;
  refresh(): Promise<this>;
  load(...relations: Array<string | string[]>): Promise<this>;
  setInc(field: string, amount?: number): Promise<this>;
  setDec(field: string, amount?: number): Promise<this>;
  trashed(): boolean;
}

/** ---------------------------------------------------------------- 关联 */
export declare class Relation {
  name: string;
  parentModel: typeof Model;
  targetModel: typeof Model;
  eagerLoad(instances: Model[]): Promise<Model[]>;
}

/** ---------------------------------------------------------------- 连接 */
export declare class Connection {
  constructor(name: string, config: ConnectionConfig);
  readonly name: string;
  readonly id: string;
  readonly driver: string;
  readonly adapter: Adapter;
  readonly builder: Builder;
  query<T = Record<string, any>>(sql: string, bindings?: Bindings): Promise<T[]>;
  execute(sql: string, bindings?: Bindings): Promise<WriteResult>;
  transaction<T = any>(cb: (connection: Connection) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
}

export declare class ConnectionManager {
  configure(options: QeeDBOptions): void;
  get(name?: string): Connection;
  close(name?: string): Promise<void>;
}

/** ---------------------------------------------------------------- 扩展点 */
export declare class Adapter {
  constructor(config?: ConnectionConfig);
  config: ConnectionConfig;
  pool: unknown;
  connect(): Promise<unknown>;
  close(): Promise<void>;
  query(sql: string, bindings?: Bindings): Promise<Record<string, any>[]>;
  execute(sql: string, bindings?: Bindings): Promise<WriteResult>;
  getConnection(): Promise<unknown>;
  releaseConnection(conn?: unknown): void;
  queryOn(conn: unknown, sql: string, bindings?: Bindings): Promise<Record<string, any>[]>;
  executeOn(conn: unknown, sql: string, bindings?: Bindings): Promise<WriteResult>;
  begin(conn: unknown): Promise<void>;
  commit(conn: unknown): Promise<void>;
  rollback(conn: unknown): Promise<void>;
  savepoint(conn: unknown, name: string): Promise<void>;
  rollbackTo(conn: unknown, name: string): Promise<void>;
  getBuilderClass(): typeof Builder;
  getDriverName(): string;
  normalizeError(err: Error, sql?: string, bindings?: Bindings): Error;
}

export declare class MysqlAdapter extends Adapter {}

export declare class Builder {
  escapeId(name: string): string;
  placeholder(index?: number): string;
  buildSelect(state: Record<string, any>): BuiltSql;
  buildInsert(state: Record<string, any>): BuiltSql;
  buildInsertAll(state: Record<string, any>): BuiltSql;
  buildUpdate(state: Record<string, any>): BuiltSql;
  buildDelete(state: Record<string, any>): BuiltSql;
  buildAggregate(state: Record<string, any>, fn: string, field?: string): BuiltSql;
}

export declare class MysqlBuilder extends Builder {}

/** ---------------------------------------------------------------- 异常 */
export declare class QeeDBError extends Error {
  code: string;
  sql?: string;
  bindings?: Bindings;
  cause?: Error;
}
export declare class ConfigError extends QeeDBError {}
export declare class ConnectionError extends QeeDBError {}
export declare class ConnectionLostError extends ConnectionError {}
export declare class QueryError extends QeeDBError {}
export declare class DuplicateKeyError extends QueryError {}
export declare class ForeignKeyError extends QueryError {}
export declare class InvalidQueryError extends QueryError {}
export declare class ModelError extends QeeDBError {}
export declare class ModelNotFoundException extends ModelError {}
export declare class TransactionError extends QeeDBError {}
export declare class NotSupportedError extends QeeDBError {}

/** ---------------------------------------------------------------- 门面 */
export interface QeeDBFacade {
  version: string;
  configure(options: QeeDBOptions): this;
  connection(name?: string): Connection;
  table<T = Record<string, any>>(table: string, alias?: string): Query<T>;
  transaction<T = any>(cb: (connection: Connection) => Promise<T> | T): Promise<T>;
  registerAdapter(driver: string, AdapterClass: new (config?: ConnectionConfig) => Adapter): this;
  registerBuilder(driver: string, BuilderClass: new () => Builder): this;
  on(event: 'query', handler: (payload: QueryEvent) => void): this;
  off(event: 'query', handler: (payload: QueryEvent) => void): this;
  close(name?: string): Promise<void>;

  // 类型挂载（运行时同在门面上）
  QeeDB: QeeDBFacade;
  Model: typeof Model;
  Query: typeof Query;
  ModelQuery: typeof ModelQuery;
  Connection: typeof Connection;
  ConnectionManager: typeof ConnectionManager;
  Adapter: typeof Adapter;
  MysqlAdapter: typeof MysqlAdapter;
  Builder: typeof Builder;
  MysqlBuilder: typeof MysqlBuilder;
  exceptions: Record<string, typeof QeeDBError>;
  utils: { escapeId(name: string, quote?: string): string };
}

export declare const QeeDB: QeeDBFacade;
export default QeeDB;
