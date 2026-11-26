'use strict';

/**
 * 测试环境装配：注册 fake 驱动并配置为默认连接
 */

import QeeDB from '../../src/index.js';
import FakeAdapter from './FakeAdapter.js';
import MysqlBuilder from '../../src/builders/MysqlBuilder.js';

/**
 * @returns {FakeAdapter} 可直接操控的适配器实例
 */
function setupFake() {
  QeeDB.registerAdapter('fake', FakeAdapter);
  QeeDB.registerBuilder('fake', MysqlBuilder);
  QeeDB.configure({ driver: 'fake' });
  return QeeDB.connection().adapter;
}

export { setupFake, QeeDB };
