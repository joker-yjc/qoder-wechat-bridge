import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_STATE, ensureDirs, loadState, saveState, type State } from '../../src/config.js';
import { MessageItemType, MessageType, type WeixinMessage } from '../../src/weixin/types.js';
import { runService, type ServiceDeps } from '../../src/bridge/service.js';
import type { PreflightResult } from '../../src/bridge/preflight.js';
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

beforeEach(async () => {
  if (process.platform !== 'win32') fs.chmodSync(qoderFixture, 0o755);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-integration-'));
  process.env.QWB_CONFIG_DIR = path.join(root, 'config');
  process.env.QWB_STATE_DIR = path.join(root, 'state');
  ensureDirs();
  fake = await startFakeILink();
});

afterEach(async () => {
  delete process.env.FAKE_QODER_MODE;
  await fake?.close();
  fake = undefined;
  delete process.env.QWB_CONFIG_DIR;
  delete process.env.QWB_STATE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

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
 * 构造 outbox 消息
 * @param text - 正文
 * @param createdAt - 创建时间
 * @returns outbox 消息
 */
function outboxItem(text: string, createdAt = Date.now()) {
  return {
    id: `o-${text}`,
    toUserId: 'u',
    text,
    kind: 'notice' as const,
    createdAt,
    bytes: Buffer.byteLength(text, 'utf8'),
    failures: 0,
    transientFailures: 0,
  };
}

/**
 * 启动服务
 * @param deps - 覆盖依赖
 * @returns 服务句柄
 */
async function startService(deps: ServiceDeps = {}) {
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
      maxRepliesPerTurn: 9,
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

/**
 * 等一小段时间
 * @param ms - 毫秒
 */
async function sleep(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('事故回归集成测试', () => {
  it('应该在 261KB stderr 崩溃时只发一条短提示', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    process.env.FAKE_QODER_MODE = 'stderr-261k';
    const handle = await startService();
    fake.enqueue(textMessage('cause-failure', 'm1'));

    await waitFor(() => fake.sent.length >= 1);
    handle.stop();
    await sleep();

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.text.length).toBeLessThanOrEqual(300);
    expect(fake.sent[0]?.text).not.toContain('xxxxx');
    const diagnostics = path.join(process.env.QWB_STATE_DIR as string, 'logs', 'diagnostics');
    expect(fs.existsSync(diagnostics)).toBe(true);
    expect(loadState().outbox).toEqual([]);
  });

  it('应该在永久失败三次后隔离毒丸并继续回传', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    fake.failText('bad', { status: 400 });
    process.env.FAKE_QODER_MODE = 'ok';
    const state: State = { ...DEFAULT_STATE, outbox: [outboxItem('bad')] };
    saveState(state);
    const handle = await startService();
    fake.enqueue(textMessage('hello', 'm1'));
    fake.enqueue(textMessage('hello', 'm2'));
    fake.enqueue(textMessage('hello', 'm3'));

    await waitFor(() => fake.sent.filter((item) => item.text === 'hello').length >= 3);
    handle.stop();
    await sleep();

    const after = loadState();
    expect(after.quarantine).toHaveLength(1);
    expect(after.outbox).toEqual([]);
    expect(fake.sent.filter((item) => item.text === 'hello')).toHaveLength(3);
  });

  it('应该在额度耗尽后保留消息并在下一窗口优先补发', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    fake.failText('old', { ret: -2 });
    process.env.FAKE_QODER_MODE = 'ok';
    saveState({ ...DEFAULT_STATE, outbox: [outboxItem('old')] });
    const handle = await startService();
    fake.enqueue(textMessage('one', 'm1'));

    await waitFor(() => loadState().outbox.length >= 2);
    expect(loadState().quota.streak).toBeGreaterThanOrEqual(1);
    expect(fake.sent).toEqual([]);

    fake.clearFailure('old');
    fake.enqueue(textMessage('two', 'm2'));
    await waitFor(() => fake.sent.length >= 3);
    handle.stop();
    await sleep();

    expect(fake.sent.map((item) => item.text)).toEqual(['old', 'hello', 'hello']);
  });

  it('应该在会话过期时停止循环并保留消息', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    fake.failText('old', { ret: -14 });
    process.env.FAKE_QODER_MODE = 'ok';
    saveState({ ...DEFAULT_STATE, outbox: [outboxItem('old')] });
    const handle = await startService();
    fake.enqueue(textMessage('one', 'm1'));

    await waitFor(() => loadState().outbox.length >= 2);
    handle.stop();
    await sleep();

    expect(loadState().outbox.map((item) => item.text)).toEqual(['old', 'hello']);
    expect(fake.sent).toEqual([]);
  });

  it('应该在启动时清理过期 outbox 并保留隔离区', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    saveState({
      ...DEFAULT_STATE,
      outbox: [outboxItem('expired', Date.now() - 2 * 24 * 60 * 60_000)],
      quarantine: [
        {
          ...outboxItem('quarantined'),
          quarantinedAt: Date.now(),
          reason: 'permanent',
          preview: 'quarantined',
        },
      ],
    });
    const handle = await startService();
    await sleep();
    handle.stop();
    await sleep();

    const state = loadState();
    expect(state.outbox).toEqual([]);
    expect(state.quarantine).toHaveLength(1);
  });

  it('应该在预检失败时发送一条短告警', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    saveState({ ...DEFAULT_STATE, contextTokens: { u: 'ctx' } });
    const handle = await startService({
      runPreflight: async () => ({
        ok: false,
        node: okPreflight.node,
        qodercli: null,
        failures: [{ kind: 'qoder_missing', detail: 'missing' }],
      }),
    });

    await waitFor(() => fake.sent.length >= 1);
    handle.stop();
    await sleep();

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.text).toContain('环境异常');
    expect(fake.sent[0]?.text.length).toBeLessThanOrEqual(300);
  });
});
