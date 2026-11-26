import { build } from 'esbuild';

/**
 * 双格式构建：ESM + CJS
 * ------------------------------------------------------------------
 * - dist/index.js    ESM（import 'qeedb'）
 * - dist/index.cjs   CJS（require('qeedb')）
 *
 * 通过 bundle 把内部模块打成单文件，规避 dual package hazard
 * （同一模块被 ESM / CJS 各加载一份，导致 instanceof / 单例不一致）。
 * mysql2 保持外部依赖，由运行时 node_modules 提供。
 */

const shared = {
  entryPoints: ['src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['mysql2'],
  logLevel: 'info',
  sourcemap: false,
};

async function main() {
  await build({
    ...shared,
    format: 'esm',
    outfile: 'dist/index.js',
  });

  await build({
    ...shared,
    format: 'cjs',
    outfile: 'dist/index.cjs',
    footer: {
      // 保持原 CJS 语义：require('qeedb') 直接得到门面实例，而非 { default: 门面 }
      js: 'module.exports = module.exports.default;',
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
