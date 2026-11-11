/**
 * 跨进程抢锁竞争者：用 Vite SSR 加载 TS 源码，避免依赖构建产物
 * 用法：node test/fixtures/instance-lock-contender.mjs <stateDir> [waitMs] [holdMs]
 */
import { createServer } from 'vite';

const stateDir = process.argv[2];
if (!stateDir) {
  console.error('缺少 stateDir');
  process.exit(2);
}
const waitMs = Number(process.argv[3] ?? 300);
const holdMs = Number(process.argv[4] ?? 800);

const server = await createServer({
  root: process.cwd(),
  logLevel: 'silent',
  server: { middlewareMode: true },
  appType: 'custom',
});

let handle;
try {
  const mod = await server.ssrLoadModule('/src/bridge/instance-lock.ts');
  handle = await mod.acquireInstanceLock({ stateDir, botId: '', waitMs });
} catch (err) {
  await server.close();
  if (err?.name === 'AlreadyRunningError') {
    console.error(`REJECTED pid=${err.owner?.pid} message=${err.message}`);
    process.exit(1);
  }
  console.error(`ERROR ${err?.stack ?? err}`);
  process.exit(2);
}

console.log(`ACQUIRED pid=${process.pid}`);
await new Promise((resolve) => setTimeout(resolve, holdMs));
handle.release();
await server.close();
process.exit(0);
