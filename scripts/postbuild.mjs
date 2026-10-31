/**
 * 构建后处理：仅在非 Windows 平台给 CLI 加可执行位
 * Windows 由 npm 生成 .cmd shim，不需要 chmod
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  try {
    fs.chmodSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 0o755);
  } catch (err) {
    console.warn(`设置可执行位失败（不影响运行）：${String(err)}`);
  }
}
console.log('postbuild ok');
