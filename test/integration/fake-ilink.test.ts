import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_STATE, ensureDirs, loadState, saveState, type State } from '../../src/config.js';
import { MessageItemType, MessageType, type WeixinMessage } from '../../src/weixin/types.js';
import { runService, type ServiceDeps } from '../../src/bridge/service.js';
import type { PreflightResult } from '../../src/bridge/preflight.js';
import { buildStatusLines } from '../../src/status.js';
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

describe('错误可读性集成测试', () => {
  const QUOTA_NOTICE = '模型额度已用尽：今日调用次数达到上限。可稍后重试，或发 /model 切换模型。（退出码 1）';
  const TRUNCATED_NOTICE =
    '回答被截断：模型输出达到上限，本次没有完整结果。可发 /model 换输出上限更大的模型，或把任务拆小。（退出码 1）';
  const ACK_PATTERN = /^（.+同 \d{2}:\d{2} 那条，本次为第 \d+ 次，已略）$/;

  /**
   * 读取当日全部诊断文件内容
   * @returns 诊断文件正文拼接
   */
  function readDiagnostics(): string {
    const rootDir = path.join(process.env.QWB_STATE_DIR as string, 'logs', 'diagnostics');
    if (!fs.existsSync(rootDir)) return '';
    return fs
      .readdirSync(rootDir)
      .flatMap((day) => fs.readdirSync(path.join(rootDir, day)).map((file) => fs.readFileSync(path.join(rootDir, day, file), 'utf-8')))
      .join('\n');
  }

  it('应该复现 2026-11-05 额度事故：5 次同类失败只发 1 条完整提示与 4 条 ack', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    process.env.FAKE_QODER_MODE = 'quota-110';
    const handle = await startService();
    for (let index = 0; index < 5; index += 1) fake.enqueue(textMessage('盯盘', `m${index}`));

    await waitFor(() => fake.sent.length >= 5);
    handle.stop();
    await sleep();

    expect(fake.sent).toHaveLength(5);
    expect(fake.sent[0]?.text).toBe(QUOTA_NOTICE);
    for (const message of fake.sent.slice(1)) {
      expect(message.text).toMatch(ACK_PATTERN);
      expect(message.text.length).toBeLessThanOrEqual(60);
    }
    expect(fake.sent[1]?.text).toContain('第 1 次');
    expect(fake.sent[4]?.text).toContain('第 4 次');

    const state = loadState();
    expect(state.outbox).toEqual([]);
    expect(state.quarantine).toEqual([]);
    expect(state.lastFailure).toMatchObject({ kind: 'exit', errorClass: 'model_quota', errorCode: '110', exitCode: 1 });
  });

  it('应该复现 2026-11-06 截断事故：判为失败并给出中文截断说明', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    process.env.FAKE_QODER_MODE = 'max-output-tokens';
    const handle = await startService();
    fake.enqueue(textMessage('长任务', 'm1'));

    await waitFor(() => fake.sent.length >= 1);
    handle.stop();
    await sleep();

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.text).toBe(TRUNCATED_NOTICE);
    expect(fake.sent[0]?.text).not.toMatch(/[A-Za-z]{4,}\s+[A-Za-z]{4,}/);
    expect(readDiagnostics()).toContain('# errorClass: output_limit');
    expect(readDiagnostics()).toContain('# errorCode: max_output_tokens');
    expect(loadState().lastFailure?.errorClass).toBe('output_limit');
  });

  it('应该在凭据失效时提示需在本机重新登录且不泄漏错误码', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    process.env.FAKE_QODER_MODE = 'auth-failed';
    const handle = await startService();
    fake.enqueue(textMessage('hello', 'm1'));

    await waitFor(() => fake.sent.length >= 1);
    handle.stop();
    await sleep();

    expect(fake.sent[0]?.text).toBe('Qoder 凭据已失效：需在本机重新登录 qodercli 后重试。（退出码 1）');
    expect(fake.sent[0]?.text).not.toContain('authentication_failed');
  });

  it('应该在未收录的 error_code 时沿用一期文案并记录原始错误码', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    process.env.FAKE_QODER_MODE = 'semantic-unknown';
    const handle = await startService();
    fake.enqueue(textMessage('hello', 'm1'));

    await waitFor(() => fake.sent.length >= 1);
    handle.stop();
    await sleep();

    expect(fake.sent[0]?.text).toBe('执行失败：qodercli 异常退出（退出码 1）。详见本机日志。');
    expect(fake.sent[0]?.text).not.toContain('Rate limit');
    expect(loadState().lastFailure).toMatchObject({ errorClass: 'unknown', errorCode: 'rate_limit' });
  });

  it('应该让不同类别的错误互不抑制', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    const handle = await startService();
    process.env.FAKE_QODER_MODE = 'quota-110';
    fake.enqueue(textMessage('第一条', 'm1'));
    await waitFor(() => fake.sent.length >= 1);
    process.env.FAKE_QODER_MODE = 'max-output-tokens';
    fake.enqueue(textMessage('第二条', 'm2'));

    await waitFor(() => fake.sent.length >= 2);
    handle.stop();
    await sleep();

    expect(fake.sent[0]?.text).toBe(QUOTA_NOTICE);
    expect(fake.sent[1]?.text).toBe(TRUNCATED_NOTICE);
  });

  it('应该在去重窗口过期后重新发完整提示', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    process.env.FAKE_QODER_MODE = 'quota-110';
    // 注入时钟越过窗口边界，不靠真实 sleep：处理耗时波动不会让本用例偶发失败
    let clock = 1_800_000_000_000;
    const handle = await startService({ now: () => clock });
    fake.enqueue(textMessage('第一条', 'm1'));
    await waitFor(() => fake.sent.length >= 1);
    clock += 60_000;
    fake.enqueue(textMessage('第二条', 'm2'));
    await waitFor(() => fake.sent.length >= 2);
    clock += 600_000;
    fake.enqueue(textMessage('第三条', 'm3'));

    await waitFor(() => fake.sent.length >= 3);
    handle.stop();
    await sleep();

    expect(fake.sent[0]?.text).toBe(QUOTA_NOTICE);
    expect(fake.sent[1]?.text).toMatch(ACK_PATTERN);
    expect(fake.sent[2]?.text).toBe(QUOTA_NOTICE);
  });

  it('应该在错误提示发送失败时不入队且下一次仍发完整提示', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    process.env.FAKE_QODER_MODE = 'quota-110';
    fake.failText(QUOTA_NOTICE, { ret: -2 });
    const handle = await startService();
    fake.enqueue(textMessage('第一条', 'm1'));
    await sleep(300);

    expect(fake.sent).toHaveLength(0);
    expect(loadState().outbox).toEqual([]);

    fake.clearFailure(QUOTA_NOTICE);
    fake.enqueue(textMessage('第二条', 'm2'));
    await waitFor(() => fake.sent.length >= 1);
    handle.stop();
    await sleep();

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.text).toBe(QUOTA_NOTICE);
    expect(loadState().outbox).toEqual([]);
    expect(loadState().quarantine).toEqual([]);
  });

  it('应该在续接失败时不把英文原文抛给用户', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    process.env.FAKE_QODER_MODE = 'resume-failed';
    saveState({ ...DEFAULT_STATE, sessions: { u: { sessionId: 's0', updatedAt: 0, turns: 1 } } });
    const handle = await startService();
    fake.enqueue(textMessage('hello', 'm1'));

    await waitFor(() => fake.sent.length >= 1);
    handle.stop();
    await sleep();

    // 重试次数由 test/unit/service.test.ts 的「应该在会话续接失败时用新会话重试」断言，
    // 这里只验集成链路上的可观测结果：英文原文不直达用户
    expect(fake.sent[0]?.text).not.toContain('resume not found');
    expect(fake.sent[0]?.text).toBe('执行失败：qodercli 异常退出（退出码 1）。详见本机日志。');
  });

  it('应该在 status 里分行展示最近失败与下行额度', async () => {
    if (!fake) throw new Error('fake iLink 未启动');
    process.env.FAKE_QODER_MODE = 'quota-110';
    const handle = await startService();
    fake.enqueue(textMessage('hello', 'm1'));

    await waitFor(() => fake.sent.length >= 1);
    handle.stop();
    await sleep();

    const state = loadState();
    const lines = buildStatusLines({ ...DEFAULT_CONFIG, ownerUserId: 'u', token: 't' }, state, {
      configFile: '/c/config.json',
      stateFile: '/s/state.json',
      personaInfo: '未设置',
      inbox: { bytes: 0, files: 0 },
      home: '/home/u',
    });
    const quotaIndex = lines.findIndex((line) => line.startsWith('下行额度：'));
    const failureIndex = lines.findIndex((line) => line.startsWith('最近失败：'));

    expect(failureIndex).toBe(quotaIndex + 1);
    expect(lines[failureIndex]).toContain('模型额度已用尽');
    expect(lines[failureIndex]).toContain('error_code=110');
    expect(lines[quotaIndex]).toBe('下行额度：正常');
  });
});
