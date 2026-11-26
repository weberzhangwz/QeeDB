'use strict';

/**
 * 单元测试：标识符转义与白名单校验
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeId, clearIdentifierCache } from '../../src/utils/identifier.js';
import { InvalidQueryError } from '../../src/exceptions/index.js';

test.beforeEach(() => clearIdentifierCache());

test('普通字段加反引号', () => {
  assert.equal(escapeId('name'), '`name`');
});

test('支持 a.b 形式', () => {
  assert.equal(escapeId('user.name'), '`user`.`name`');
});

test('支持 as 别名（大小写不敏感）', () => {
  assert.equal(escapeId('name as username'), '`name` AS `username`');
  assert.equal(escapeId('a.b AS c'), '`a`.`b` AS `c`');
});

test('支持通配符', () => {
  assert.equal(escapeId('*'), '*');
  assert.equal(escapeId('user.*'), '`user`.*');
});

test('非法标识符抛出 InvalidQueryError', () => {
  assert.throws(() => escapeId('name; DROP TABLE user'), InvalidQueryError);
  assert.throws(() => escapeId('a.b.c'), InvalidQueryError);
  assert.throws(() => escapeId(''), InvalidQueryError);
  assert.throws(() => escapeId('1abc'), InvalidQueryError);
});

test('转义结果命中缓存', () => {
  const first = escapeId('user.name');
  const second = escapeId('user.name');
  assert.equal(first, second);
});
