#!/usr/bin/env node
/**
 * 真机双进程互斥验证：真实子进程 + 真实文件系统（先 npm run build）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-real-lock-'));
const configDir = path.join(root, 'config');
const stateDir = path.join(root, 'state');
// bot 级锁固定落在 ~/.local/state/... 下，必须把 HOME 也隔离，否则污染真实注册表目录
const home = path.join(root, 'home');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const config = {
  baseUrl: 'http://127.0.0.1:1',
  token: 'fake-token',
  botId: '',
  ownerUserId: 'u',
  cwd: '',
};
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));

const env = { ...process.env, HOME: home, QWB_CONFIG_DIR: configDir, QWB_STATE_DIR: stateDir };
const cli = path.join(process.cwd(), 'dist', 'cli.js');

function startRun(extraEnv = {}) {
  const child = spawn(process.execPath, [cli, 'run'], {
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  return { child, output: () => out, exited: new Promise((r) => child.on('exit', (code, sig) => r({ code, sig }))) };
}

const lockPath = path.join(stateDir, 'run.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, label) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(100);
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  // 1. 第一个实例正常启动并持锁
  const p1 = startRun();
  await waitFor(() => fs.existsSync(lockPath) && fs.existsSync(path.join(stateDir, 'run.json')), 20000, 'p1 启动');
  const rec1 = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  check('p1 进程持锁且 pid 一致', rec1.pid === p1.child.pid, `lock.pid=${rec1.pid} child.pid=${p1.child.pid}`);

  // 2. 第二个真实进程同目录启动 → 必须拒绝
  const t0 = Date.now();
  const p2 = startRun();
  const r2 = await p2.exited;
  const waited = Date.now() - t0;
  check('第二个真实进程被拒绝启动', r2.code === 1, `exit=${r2.code} 耗时=${waited}ms`);
  check('拒绝信息包含持有者 pid 与 stop 指引', /已在运行：pid \d+/.test(p2.output()) && /qoder-wechat stop/.test(p2.output()),
    p2.output().split('\n').filter(Boolean).slice(0, 4).join(' | '));

  // 3. 第一个实例未被影响
  check('第一个实例仍存活', p1.child.exitCode === null && p1.child.signalCode === null);

  // 4. 第二个进程不得删除第一个实例的锁
  const rec1b = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  check('锁仍归属第一个实例', rec1b.pid === p1.child.pid, `lock.pid=${rec1b.pid}`);

  // 5. SIGTERM 后锁与运行记录都应清理
  p1.child.kill('SIGTERM');
  const r1 = await p1.exited;
  await sleep(500);
  check('p1 退出后锁已释放', !fs.existsSync(lockPath), `exit=${r1.code}/${r1.sig}`);
  check('p1 退出后 run.json 已清理', !fs.existsSync(path.join(stateDir, 'run.json')));

  // 6. 陈旧锁（pid 不存在）应被接管
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, ppid: 0, startedAt: '', cwd: '/', botId: '', stateDir, role: 'state' }),
  );
  const p3 = startRun();
  await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid === p3.child.pid;
    } catch {
      return false;
    }
  }, 20000, 'p3 接管陈旧锁');
  check('陈旧锁被新进程接管', true, `lock.pid=${p3.child.pid}`);
  // 不等 preflight 结束就发 SIGTERM，覆盖"启动期收到信号"这条路径
  const runJsonAtKill = fs.existsSync(path.join(stateDir, 'run.json'));
  p3.child.kill('SIGTERM');
  await p3.exited;
  await sleep(500);
  check('启动期 SIGTERM 后锁已释放', !fs.existsSync(lockPath), `run.json 当时存在=${runJsonAtKill}`);

  // 7. 跨状态目录同一 bot → 拒绝
  const configDirA = path.join(root, 'configA');
  const configDirB = path.join(root, 'configB');
  const stateDirA = path.join(root, 'stateA');
  const stateDirB = path.join(root, 'stateB');
  for (const d of [configDirA, configDirB, stateDirA, stateDirB]) fs.mkdirSync(d, { recursive: true });
  const configWithBot = { ...config, botId: 'bot-real-shared' };
  fs.writeFileSync(path.join(configDirA, 'config.json'), JSON.stringify(configWithBot));
  fs.writeFileSync(path.join(configDirB, 'config.json'), JSON.stringify(configWithBot));
  const pA = startRun({ QWB_CONFIG_DIR: configDirA, QWB_STATE_DIR: stateDirA });
  await waitFor(() => fs.existsSync(path.join(stateDirA, 'run.json')), 20000, 'A 启动');
  const botLockDir = path.join(home, '.local', 'state', 'qoder-wechat-bridge', 'instances');
  const before = fs.existsSync(botLockDir) ? fs.readdirSync(botLockDir) : [];
  check('A 已创建 bot 级锁', before.length > 0, `instances=${before.join(',')}`);
  const pB = startRun({ QWB_CONFIG_DIR: configDirB, QWB_STATE_DIR: stateDirB });
  const rB = await pB.exited;
  check('跨状态目录同一 bot 被拒绝', rB.code === 1, `exit=${rB.code}`);
  check('B 拿到了 bot 冲突提示', /已在运行/.test(pB.output()), pB.output().split('\n').filter(Boolean)[0] ?? '');
  check('B 失败后释放自己的状态锁', !fs.existsSync(path.join(stateDirB, 'run.lock')));
  pA.child.kill('SIGTERM');
  await pA.exited;
  await sleep(500);
  const after = fs.existsSync(botLockDir) ? fs.readdirSync(botLockDir) : [];
  check('A 退出后 bot 级锁已释放', after.length === 0, `instances=${after.join(',')}`);

  fs.rmSync(root, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('脚本异常：', err.message);
  process.exit(2);
});
