'use strict';

/**
 * 事务上下文（设计文档 3.6 / ADR-03）
 * ------------------------------------------------------------------
 * 基于 AsyncLocalStorage：
 *  - 无全局变量污染，天然并发隔离；
 *  - 事务内任意层级的 Query/Model 无需显式传 conn；
 *  - 每次 run 派生一份新的 Map，嵌套事务不会影响外层。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/** 事务对象结构：{ connection, conn, depth, savepoints: [] } */

/**
 * 在当前异步上下文开启事务作用域
 * @param {object} trx 事务对象
 * @param {Function} cb 业务回调
 */
function run(trx, cb) {
  const parent = als.getStore() || new Map();
  const store = new Map(parent);
  // 以连接 id 为键，支持同进程多连接共存
  store.set(trx.connection.id, trx);
  // 栈用于 get()（最内层事务）
  const stack = (parent.get('__stack') || []).slice();
  stack.push(trx);
  store.set('__stack', stack);
  return als.run(store, () => Promise.resolve().then(cb));
}

/**
 * 取指定连接上的事务上下文
 * @param {object} connection
 * @returns {object|undefined}
 */
function getFor(connection) {
  const store = als.getStore();
  if (!store || !connection) return undefined;
  return store.get(connection.id);
}

/**
 * 取当前最内层事务（不区分连接，谨慎使用；优先 getFor）
 */
function get() {
  const store = als.getStore();
  if (!store) return undefined;
  const stack = store.get('__stack');
  return stack && stack.length ? stack[stack.length - 1] : undefined;
}

/** 当前是否处于事务中 */
function inTransaction(connection) {
  return Boolean(getFor(connection));
}

/** 生成保存点名（内部约束 [A-Za-z0-9_]） */
function savepointName(depth) {
  return `qee_sp_${depth}`;
}

export { run, getFor, get, inTransaction, savepointName };
