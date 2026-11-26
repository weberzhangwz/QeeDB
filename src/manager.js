'use strict';

/**
 * 全局单例 ConnectionManager
 * ------------------------------------------------------------------
 * 单独抽出，避免 Model 与 QeeDB 门面之间形成循环依赖：
 *   QeeDB 门面 ── configure/close ──▶ manager
 *   Model ─────── getConnection ─────▶ manager
 */

import ConnectionManager from './ConnectionManager.js';

export default new ConnectionManager();
