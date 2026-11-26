'use strict';

/**
 * ConnectionManager（设计文档 3.3）
 * ------------------------------------------------------------------
 * 按名管理连接单例；支持两种配置形态：
 *   1) 多连接：{ default: 'mysql', connections: { mysql: {...}, log: {...} } }
 *   2) 单连接：{ driver: 'mysql', host, ... }
 */

import Connection from './Connection.js';
import { ConfigError } from './exceptions/index.js';

class ConnectionManager {
  constructor() {
    /** @type {Map<string, Connection>} */
    this.connections = new Map();
    /** @type {Map<string, object>} */
    this.configs = new Map();
    this.defaultName = 'default';
    this.configured = false;
  }

  /**
   * 应用配置（QeeDB.configure）
   * @param {object} options
   */
  configure(options = {}) {
    if (!options || typeof options !== 'object') {
      throw new ConfigError('configure 参数必须是对象');
    }

    // 关闭旧连接，避免配置切换后连接泄漏
    for (const conn of this.connections.values()) {
      conn.close().catch(() => {});
    }
    this.connections.clear();
    this.configs.clear();

    if (options.connections && typeof options.connections === 'object') {
      const names = Object.keys(options.connections);
      if (names.length === 0) throw new ConfigError('configure.connections 至少需要一个连接');
      for (const name of names) {
        const config = options.connections[name];
        if (!config || typeof config !== 'object') {
          throw new ConfigError(`连接「${name}」配置必须是对象`);
        }
        this.configs.set(name, { driver: 'mysql', ...config });
      }
      this.defaultName = options.default || names[0];
      if (!this.configs.has(this.defaultName)) {
        throw new ConfigError(`default 指向的连接不存在：${this.defaultName}`);
      }
    } else {
      // 单连接简写
      const driver = options.driver || 'mysql';
      this.configs.set('default', { ...options, driver });
      this.defaultName = 'default';
    }

    this.configured = true;
  }

  /**
   * 获取连接单例（延迟创建，首次查询才真正建池）
   * @param {string} [name]
   * @returns {Connection}
   */
  get(name) {
    const key = name || this.defaultName;
    if (this.connections.has(key)) return this.connections.get(key);

    const config = this.configs.get(key);
    if (!config) {
      if (!this.configured) {
        throw new ConfigError('尚未配置数据库连接，请先调用 QeeDB.configure({...})');
      }
      throw new ConfigError(`未找到连接配置：${key}`);
    }

    const conn = new Connection(key, config);
    this.connections.set(key, conn);
    return conn;
  }

  /** 关闭指定连接或全部连接 */
  async close(name) {
    if (name) {
      const conn = this.connections.get(name);
      if (conn) {
        this.connections.delete(name);
        await conn.close();
      }
      return;
    }
    const all = Array.from(this.connections.values());
    this.connections.clear();
    await Promise.all(all.map((conn) => conn.close()));
  }

  /** 仅测试使用：重置状态 */
  reset() {
    this.connections.clear();
    this.configs.clear();
    this.defaultName = 'default';
    this.configured = false;
  }
}

export default ConnectionManager;
