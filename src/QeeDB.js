'use strict';

/**
 * QeeDB 门面（设计文档 2.2 / 5）
 * ------------------------------------------------------------------
 * 对外唯一入口：
 *   QeeDB.configure({...})        配置连接
 *   QeeDB.connection(name?)       取连接
 *   QeeDB.table(name, alias?)     无模型查询
 *   QeeDB.transaction(cb)         默认连接事务
 *   QeeDB.registerAdapter/Builder 注册方言
 *   QeeDB.on('query', handler)    全局 SQL 事件
 *   QeeDB.close(name?)            关闭连接
 */

import manager from './manager.js';
import Query from './query/Query.js';
import { globalBus } from './events.js';
import * as registry from './registry.js';

class QeeDBFacade {
  constructor() {
    this.manager = manager;
    this.version = '1.0.0';
  }

  /**
   * 配置数据库连接
   * @param {object} options
   */
  configure(options) {
    manager.configure(options);
    return this;
  }

  /**
   * 取连接单例
   * @param {string} [name]
   */
  connection(name) {
    return manager.get(name);
  }

  /**
   * 无模型链式查询
   * @param {string} table
   * @param {string} [alias]
   * @returns {Query}
   */
  table(table, alias) {
    const query = new Query(manager.get());
    query.table(table, alias);
    return query;
  }

  /**
   * 默认连接上的事务
   * @param {Function} cb
   */
  transaction(cb) {
    return manager.get().transaction(cb);
  }

  /** 注册 Adapter（新数据库协议） */
  registerAdapter(driver, AdapterClass) {
    registry.registerAdapter(driver, AdapterClass);
    return this;
  }

  /** 注册 Builder（新 SQL 方言） */
  registerBuilder(driver, BuilderClass) {
    registry.registerBuilder(driver, BuilderClass);
    return this;
  }

  /**
   * 全局事件：目前提供 'query'（SQL 日志 / 慢查询）
   * @param {string} event
   * @param {Function} handler
   */
  on(event, handler) {
    globalBus.on(event, handler);
    return this;
  }

  off(event, handler) {
    globalBus.off(event, handler);
    return this;
  }

  /** 关闭连接（不传则全部关闭） */
  close(name) {
    return manager.close(name);
  }
}

export { QeeDBFacade };
