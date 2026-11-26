'use strict';

/**
 * Event concern（设计文档 3.7）
 * ------------------------------------------------------------------
 * 模型事件：beforeInsert/afterInsert/beforeUpdate/afterUpdate/
 *          beforeSave/afterSave/beforeDelete/afterDelete/beforeSelect/afterFind
 *
 * - 每个 Model 子类一份事件总线（WeakMap，互不干扰）
 * - 子类 static on(event, fn) 注册；static boot() 首次使用执行一次
 * - 事件处理同步调用；payload 为模型实例（查询类事件为查询上下文）
 */

import { EventBus } from '../events.js';

/** @type {WeakMap<Function, EventBus>} */
const buses = new WeakMap();
/** @type {WeakSet<Function>} */
const booted = new WeakSet();

function busFor(Model) {
  let bus = buses.get(Model);
  if (!bus) {
    bus = new EventBus();
    buses.set(Model, bus);
  }
  return bus;
}

/** 注册事件 */
function on(Model, event, handler) {
  busFor(Model).on(event, handler);
  return Model;
}

/** 移除事件 */
function off(Model, event, handler) {
  busFor(Model).off(event, handler);
  return Model;
}

/** 触发事件（payload 任意） */
function emit(Model, event, payload) {
  return busFor(Model).emit(event, payload);
}

/** 首次使用时执行一次 boot() */
function ensureBooted(Model) {
  if (booted.has(Model)) return;
  booted.add(Model);
  if (typeof Model.boot === 'function') Model.boot.call(Model);
}

/** 仅测试使用：清除注册与 boot 状态 */
function resetEvents(Model) {
  buses.delete(Model);
  booted.delete(Model);
}

/** 列出监听器数量（调试） */
function listenerCount(Model, event) {
  return busFor(Model).listenerCount(event);
}

export { on, off, emit, ensureBooted, resetEvents, listenerCount };
