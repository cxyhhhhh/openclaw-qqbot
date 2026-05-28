import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['cjs'],
  outDir: 'dist',
  dts: true,
  splitting: false,
  clean: true,
  external: [
    'openclaw',
    'openclaw/plugin-sdk',
  ],
  // 确保这些依赖被 bundle 进产物（运行时 node_modules 中不一定存在）
  noExternal: [
    '@tencent-connect/qqbot-nodejs',
    'ws',
  ],
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: 'node18',
  sourcemap: true,
});
