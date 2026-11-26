'use strict';

/**
 * 驱动注册表（Adapter / Builder）
 * ------------------------------------------------------------------
 * QeeDB 门面暴露 registerAdapter / registerBuilder，实际存储在这里，
 * 避免门面 ↔ Connection ↔ Adapter 之间的循环依赖。
 */

import MysqlAdapter from './adapters/MysqlAdapter.js';
import MysqlBuilder from './builders/MysqlBuilder.js';
import { ConfigError, NotSupportedError } from './exceptions/index.js';

const adapters = new Map([['mysql', MysqlAdapter]]);
const builders = new Map([['mysql', MysqlBuilder]]);

function registerAdapter(driver, AdapterClass) {
  if (typeof driver !== 'string' || !driver) throw new ConfigError('registerAdapter 需要 driver 名称');
  if (typeof AdapterClass !== 'function') throw new ConfigError('registerAdapter 需要 Adapter 类');
  adapters.set(driver, AdapterClass);
}

function registerBuilder(driver, BuilderClass) {
  if (typeof driver !== 'string' || !driver) throw new ConfigError('registerBuilder 需要 driver 名称');
  if (typeof BuilderClass !== 'function') throw new ConfigError('registerBuilder 需要 Builder 类');
  builders.set(driver, BuilderClass);
}

function getAdapterClass(driver) {
  const cls = adapters.get(driver);
  if (!cls) throw new NotSupportedError(`未注册的数据库驱动：${driver}`);
  return cls;
}

function getBuilderClass(driver) {
  const cls = builders.get(driver);
  if (!cls) throw new NotSupportedError(`未注册的 SQL 方言：${driver}`);
  return cls;
}

function hasDriver(driver) {
  return adapters.has(driver) && builders.has(driver);
}

/** 仅测试使用：重置为内置 mysql 驱动 */
function resetDrivers() {
  adapters.clear();
  builders.clear();
  adapters.set('mysql', MysqlAdapter);
  builders.set('mysql', MysqlBuilder);
}

export {
  registerAdapter,
  registerBuilder,
  getAdapterClass,
  getBuilderClass,
  hasDriver,
  resetDrivers,
};
