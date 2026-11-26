'use strict';

/**
 * 轻量事件总线
 * ------------------------------------------------------------------
 * - 全局总线：QeeDB.on('query', ...)，用于 SQL 日志 / 慢查询监控
 * - 模型总线：每个 Model 子类一份，见 Model.on()
 *
 * 事件处理为同步调用（避免在 SQL 关键路径引入额外微任务）；
 * 如需异步副作用，请在 handler 内部自行调度。
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this.handlers = new Map();
  }

  /**
   * 注册监听
   * @param {string} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (typeof handler !== 'function') throw new TypeError('事件处理器必须是函数');
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  /** 只触发一次 */
  once(event, handler) {
    const wrapper = (payload) => {
      this.off(event, wrapper);
      handler(payload);
    };
    wrapper.__origin = handler;
    return this.on(event, wrapper);
  }

  /** 移除监听：不传 handler 时清空该事件 */
  off(event, handler) {
    if (!handler) {
      this.handlers.delete(event);
      return this;
    }
    const list = this.handlers.get(event);
    if (!list) return this;
    const next = list.filter((fn) => fn !== handler && fn.__origin !== handler);
    if (next.length) this.handlers.set(event, next);
    else this.handlers.delete(event);
    return this;
  }

  /**
   * 触发事件
   * @param {string} event
   * @param {any} payload
   * @returns {boolean} 是否有监听器
   */
  emit(event, payload) {
    const list = this.handlers.get(event);
    if (!list || list.length === 0) return false;
    for (const handler of list.slice()) {
      handler(payload);
    }
    return true;
  }

  listenerCount(event) {
    return (this.handlers.get(event) || []).length;
  }
}

/** 全局总线（SQL 事件等） */
const globalBus = new EventBus();

export { EventBus, globalBus };
