/**
 * 实例互斥集成测试：双实例 / 陈旧锁 / 跨状态目录
 * @module test/integration/instance-lock
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, ensureDirs, type Config } from '../../src/config.js';
import { AlreadyRunningError, globalInstancesDir } from '../../src/bridge/instance-lock.js';
import { runService, type ServiceDeps } from '../../src/bridge/service.js';
import type { PreflightResult } from '../../src/bridge/preflight.js';
import { MessageItemType, MessageType, type WeixinMessage } from '../../src/weixin/types.js';
import { startFakeILink, type FakeILink } from '../helpers/fake-ilink.js';

const qoderFixture = fileURLToPath(new URL('../fixtures/fake-qodercli.mjs', import.meta.url));
const okPreflight: PreflightResult = {
  ok: true,
  node: { version: '24.0.0', major: 24, execPath: '/node', ino: 1, mtimeMs: 1 },
  qodercli: { path: '/bin/qodercli', version: '1.1.81' },
  failures: [],
};

let root = '';
let fake: FakeILink | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  if (process.platform !== 'win32') fs.chmodSync(qoderFixture, 0o755);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-lock-integration-'));
  originalHome = process.env.HOME;
  process.env.HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  process.env.QWB_CONFIG_DIR = path.join(root, 'config');
  process.env.QWB_STATE_DIR = path.join(root, 'state');
  ensureDirs();
  fake = await startFakeILink();
});

afterEach(async () => {
  delete process.env.FAKE_QODER_MODE;
  await fake?.close();
  fake = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.QWB_CONFIG_DIR;
  delete process.env.QWB_STATE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * 计算测试 HOME 下的实例注册表残留
 * @returns 残留锁文件名
 */
function registryEntries(): string[] {
  const dir = globalInstancesDir();
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/**
 * 构造文本消息
 * @param text - 正文
 * @param id - 消息 id
 * @returns 微信消息
 */
function textMessage(text: string, id: string): WeixinMessage {
  return {
    message_type: MessageType.USER,
    from_user_id: 'u',
    message_id: id,
    context_token: 'ctx',
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

/**
 * 启动服务
 * @param overrides - 配置覆盖
 * @param deps - 依赖覆盖
 * @returns 服务句柄
 */
async function startService(overrides: Partial<Config> = {}, deps: ServiceDeps = {}) {
  if (!fake) throw new Error('fake iLink 未启动');
  return runService(
    {
      ...DEFAULT_CONFIG,
      baseUrl: fake.baseUrl,
      token: 't',
      ownerUserId: 'u',
      qoderBin: qoderFixture,
      cwd: '',
      personaFile: path.join(root, 'persona.md'),
      inboxDir: path.join(root, 'inbox'),
      qoderTimeoutMs: 5_000,
      preflightVersionTimeoutMs: 2_000,
      ...overrides,
    },
    { runPreflight: async () => okPreflight, ...deps },
  );
}

/**
 * 等待条件成立
 * @param predicate - 条件
 * @param timeoutMs - 超时
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('实例互斥', () => {
  it('应该拒绝同目录的第二个实例且不影响第一个实例', async () => {
    const first = await startService();
    if (!fake) throw new Error('fake iLink 未启动');

    await expect(startService()).rejects.toBeInstanceOf(AlreadyRunningError);

    fake.enqueue(textMessage('hello', 'm1'));
    await waitFor(() => fake.sent.length >= 1);
    expect(fake.sent[0]?.text).toBe('hello');

    await first.stop();
    expect(fs.existsSync(path.join(root, 'state', 'run.lock'))).toBe(false);
  });

  it('应该接管 pid 已失效的陈旧锁', async () => {
    const lockPath = path.join(root, 'state', 'run.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999_999,
        ppid: 0,
        startedAt: '',
        cwd: '/',
        botId: '',
        stateDir: path.dirname(lockPath),
        role: 'state',
      }),
    );

    const handle = await startService();
    expect(fs.existsSync(lockPath)).toBe(true);

    await handle.stop();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('应该拒绝不同状态目录下的同一 bot', async () => {
    const first = await startService({ botId: 'bot-shared' });

    const stateDir2 = path.join(root, 'state2');
    process.env.QWB_STATE_DIR = stateDir2;
    ensureDirs();
    await expect(startService({ botId: 'bot-shared' })).rejects.toBeInstanceOf(AlreadyRunningError);

    // 第二个实例获取失败后必须把自己已拿到的状态锁释放掉
    expect(fs.existsSync(path.join(stateDir2, 'run.lock'))).toBe(false);

    await first.stop();
    expect(registryEntries()).toEqual([]);
  });

  it('应该允许不同 bot 在不同状态目录并行', async () => {
    const first = await startService({ botId: 'bot-a' });

    const stateDir2 = path.join(root, 'state2');
    process.env.QWB_STATE_DIR = stateDir2;
    ensureDirs();
    const second = await startService({ botId: 'bot-b' });

    await second.stop();
    await first.stop();
    expect(registryEntries()).toEqual([]);
  });

  it('应该让两个真实子进程竞争时只有一个拿到锁', async () => {
    const stateDir = path.join(root, 'state');
    const script = fileURLToPath(new URL('../fixtures/instance-lock-contender.mjs', import.meta.url));
    const contender = (): Promise<{ code: number | null; output: string }> =>
      new Promise((resolve) => {
        // 持锁时间远大于被拒方等待窗口，避免子进程启动偏差吃掉余量
        const child = spawn(process.execPath, [script, stateDir, '300', '5000'], {
          cwd: process.cwd(),
          env: { ...process.env },
        });
        const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk));
        child.stderr.on('data', (chunk) => (output += chunk));
        child.on('exit', (code) => {
          clearTimeout(killer);
          resolve({ code, output });
        });
      });

    const [first, second] = await Promise.all([contender(), contender()]);

    expect([first.code, second.code].sort()).toEqual([0, 1]);
    const rejected = first.code === 1 ? first : second;
    expect(rejected.output).toContain('已在运行');
    expect(fs.existsSync(path.join(stateDir, 'run.lock'))).toBe(false);
  }, 30_000);
});
