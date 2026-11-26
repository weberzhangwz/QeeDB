'use strict';

/**
 * Builder 抽象基类（设计文档 3.2.1）
 * ------------------------------------------------------------------
 * 纯函数式 SQL 方言生成器：输入查询状态，输出 { sql, bindings }。
 * 约束：不得 import Adapter / Query / Model（依赖方向强制），也不做 IO。
 */

import { NotSupportedError } from '../exceptions/index.js';

class Builder {
  constructor() {
    /** 标识符引用符，MySQL 为反引号 */
    this.quote = '`';
    /** 占位符风格，MySQL 恒为 '?' */
    this.placeholderStyle = 'question';
  }

  /** 扩展点：子类可覆盖 */
  escapeId() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 escapeId()`);
  }

  /** @param {number} index 绑定值序号（从 0 开始），PG 用 $1/$2 */
  placeholder() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 placeholder()`);
  }

  buildSelect() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 buildSelect()`);
  }

  buildInsert() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 buildInsert()`);
  }

  buildInsertAll() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 buildInsertAll()`);
  }

  buildUpdate() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 buildUpdate()`);
  }

  buildDelete() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 buildDelete()`);
  }

  buildAggregate() {
    throw new NotSupportedError(`${this.constructor.name} 未实现 buildAggregate()`);
  }
}

export default Builder;
