import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_STATE, ensureDirs, type Config, type State } from '../../src/config.js';
import { BridgeSendError } from '../../src/weixin/errors.js';
import { MessageItemType, MessageType, type WeixinMessage } from '../../src/weixin/types.js';
import { createBridgeRuntime, type ServiceDeps } from '../../src/bridge/service.js';
import { log } from '../../src/log.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-service-'));
  process.env.QWB_CONFIG_DIR = path.join(root, 'config');
  process.env.QWB_STATE_DIR = path.join(root, 'state');
  ensureDirs();
});

afterEach(() => {
  delete process.env.QWB_CONFIG_DIR;
  delete process.env.QWB_STATE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * 构造配置
 * @param overrides - 覆盖项
 * @returns 配置
 */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    baseUrl: 'https://example.test',
    token: 'token',
    ownerUserId: 'u',
    cwd: '',
    qoderBin: 'qodercli',
    qoderModel: '',
    memoryEnabled: false,
    personaFile: path.join(root, 'persona.md'),
    inboxDir: path.join(root, 'inbox'),
    maxRepliesPerTurn: 9,
    ...overrides,
  };
}

/**
 * 构造状态
 * @returns 状态
 */
function makeState(): State {
  return {
    ...DEFAULT_STATE,
    sessions: {},
    outbox: [],
    quarantine: [],
    quota: { streak: 0, lastAt: 0 },
    seenMessageIds: [],
    models: {},
    contextTokens: {},
  };
}

/**
 * 构造文本消息
 * @param text - 正文
 * @param id - 消息 id
 * @param from - 发送者
 * @returns 微信消息
 */
function textMessage(text: string, id = `m-${Math.random()}`, from = 'u'): WeixinMessage {
  return {
    message_type: MessageType.USER,
    from_user_id: from,
    message_id: id,
    context_token: 'ctx',
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

/**
 * 构造运行时与假依赖
 * @param overrides - 覆盖配置
 * @param deps - 覆盖依赖
 * @returns 运行时、状态与 spies
 */
function makeRuntime(overrides: Partial<Config> = {}, deps: ServiceDeps = {}) {
  const state = makeState();
  const sent: string[] = [];
  const sendText = vi.fn(async (params: { text: string }) => {
    sent.push(params.text);
    return { ret: 0, message_id: `m${sent.length}` };
  });
  const runQoder = vi.fn(async (input: { onStart?: (cancel: () => void) => void }) => {
    input.onStart?.(() => undefined);
    return {
      ok: true,
      text: 'reply',
      sessionId: 's1',
      modelUsed: 'model-x',
      exitCode: 0,
      durationMs: 1,
    };
  });
  const getTypingTicket = vi.fn(async () => '');
  const sendTyping = vi.fn(async () => undefined);
  const takePending = vi.fn(() => []);
  const loadPersona = vi.fn(() => '');
  const listModels = vi.fn(() => [{ label: 'Auto', id: 'Auto', custom: false }]);
  const downloadItemMedia = vi.fn(async () => null);

  const runtime = createBridgeRuntime(makeConfig(overrides), state, {
    sendText,
    runQoder,
    getTypingTicket,
    sendTyping,
    takePending,
    loadPersona,
    listModels,
    downloadItemMedia,
    ...deps,
  });

  return {
    runtime,
    state,
    sent,
    sendText,
    runQoder,
    takePending,
    listModels,
    downloadItemMedia,
    getTypingTicket,
    sendTyping,
  };
}

/**
 * 造一条 outbox 消息
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

describe('processTask 正常链路', () => {
  it('应该执行任务并回传结果', async () => {
    const { runtime, state, sent, runQoder } = makeRuntime();

    await runtime.processTask('u', 'hello', 'ctx', [], 'task-1');

    expect(sent).toEqual(['reply']);
    expect(runQoder).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'hello', taskId: 'task-1', errorMaxChars: 300 }),
    );
    expect(state.sessions.u?.sessionId).toBe('s1');
    expect(state.outbox).toEqual([]);
  });

  it('应该先补发 outbox 再发送本轮结果', async () => {
    const { runtime, state, sent } = makeRuntime();
    state.outbox.push(outboxItem('old'));

    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent).toEqual(['old', 'reply']);
    expect(state.outbox).toEqual([]);
  });

  it('应该在额度耗尽时保留 outbox 并把本轮结果入队', async () => {
    const { runtime, state, sendText } = makeRuntime();
    state.outbox.push(outboxItem('old'));
    sendText.mockRejectedValueOnce(new BridgeSendError('quota', 'quota', { ret: -2 }));

    await runtime.processTask('u', 'hello', 'ctx');

    expect(state.outbox.map((item) => item.text)).toEqual(['old', 'reply']);
    expect(state.quota.streak).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('应该在永久失败三次后隔离并继续后续消息', async () => {
    const { runtime, state, sent, sendText } = makeRuntime();
    state.outbox.push(outboxItem('bad'));
    sendText.mockImplementation(async (params: { text: string }) => {
      if (params.text === 'bad') throw new BridgeSendError('bad', 'permanent');
      sent.push(params.text);
      return { ret: 0, message_id: 'm' };
    });

    await runtime.processTask('u', 'hello', 'ctx', [], 't1');
    await runtime.processTask('u', 'hello', 'ctx', [], 't2');
    await runtime.processTask('u', 'hello', 'ctx', [], 't3');

    expect(state.outbox).toEqual([]);
    expect(state.quarantine).toHaveLength(1);
    expect(state.quarantine[0]?.preview).toContain('bad');
    expect(sent.filter((text) => text === 'reply')).toHaveLength(3);
  });

  it('应该在会话过期时通知外部停止', async () => {
    const onSessionExpired = vi.fn();
    const { runtime, state, sendText } = makeRuntime({}, { onSessionExpired });
    state.outbox.push(outboxItem('old'));
    sendText.mockRejectedValueOnce(new BridgeSendError('expired', 'session_expired'));

    await runtime.processTask('u', 'hello', 'ctx');

    expect(onSessionExpired).toHaveBeenCalled();
    expect(state.outbox.map((item) => item.text)).toEqual(['old', 'reply']);
  });

  it('应该在 qoder 失败时只发一条短提示', async () => {
    const { runtime, sent, runQoder } = makeRuntime();
    runQoder.mockResolvedValueOnce({
      ok: false,
      text: '',
      error: '执行失败：boom',
      errorKind: 'is_error',
      exitCode: 1,
      durationMs: 1,
    });

    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent).toEqual(['执行失败：boom']);
  });

  it('应该在 qoder 缺少 error 时生成兜底提示', async () => {
    const { runtime, sent, runQoder } = makeRuntime();
    runQoder.mockResolvedValueOnce({
      ok: false,
      text: '',
      errorKind: 'exit',
      exitCode: 2,
      durationMs: 1,
    });

    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent[0]).toContain('异常退出');
  });

  it('应该在会话续接失败时用新会话重试', async () => {
    const { runtime, state, sent, runQoder } = makeRuntime();
    state.sessions.u = { sessionId: 's0', updatedAt: 0, turns: 1 };
    runQoder
      .mockResolvedValueOnce({
        ok: false,
        text: '',
        error: '执行失败：qodercli 异常退出（退出码 1）。详见本机日志。',
        errorDetail: 'session not found',
        errorKind: 'exit',
        durationMs: 1,
      })
      .mockResolvedValueOnce({ ok: true, text: 'reply', sessionId: 's1', durationMs: 1 });

    await runtime.processTask('u', 'hello', 'ctx');

    expect(runQoder).toHaveBeenCalledTimes(2);
    expect(sent).toEqual(['reply']);
  });

  it('应该对续接降级日志里的内部原文脱敏', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { runtime, state, runQoder } = makeRuntime();
    state.sessions.u = { sessionId: 's0', updatedAt: 0, turns: 1 };
    runQoder
      .mockResolvedValueOnce({
        ok: false,
        text: '',
        errorDetail: 'session resume not found for Authorization: Bearer abcdefghijklmnop',
        errorKind: 'exit',
        exitCode: 1,
        durationMs: 1,
      })
      .mockResolvedValueOnce({ ok: true, text: 'reply', sessionId: 's1', durationMs: 1 });

    await runtime.processTask('u', 'hello', 'ctx');

    const call = warn.mock.calls.find(([message]) => message === '续接会话失败，改为新建会话重试');
    expect(call).toBeTruthy();
    expect(String(call?.[1]?.errorDetail)).not.toContain('abcdefghijklmnop');
    expect(String(call?.[1]?.errorDetail)).toContain('[REDACTED]');
    warn.mockRestore();
  });

  it('应该在续接重试成功后不记录最近失败', async () => {    const { runtime, state, runQoder } = makeRuntime();
    state.sessions.u = { sessionId: 's0', updatedAt: 0, turns: 1 };
    runQoder
      .mockResolvedValueOnce({
        ok: false,
        text: '',
        errorDetail: 'resume not found',
        errorClass: 'unknown',
        errorKind: 'exit',
        exitCode: 1,
        durationMs: 1,
      })
      .mockResolvedValueOnce({ ok: true, text: 'reply', sessionId: 's1', durationMs: 1 });

    await runtime.processTask('u', 'hello', 'ctx');

    expect(state.lastFailure).toBeNull();
  });

  it('应该在 /stop 后暂停任务并回复确认', async () => {
    const { runtime, sent, runQoder } = makeRuntime();
    runQoder.mockImplementationOnce(
      (input: { onStart?: (cancel: () => void) => void }) =>
        new Promise((resolve) => {
          input.onStart?.(() => resolve({ ok: false, text: '', errorKind: 'exit', durationMs: 1 }));
        }),
    );

    const task = runtime.processTask('u', 'hello', 'ctx');
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.handleInbound(textMessage('/stop', 'stop-1'));
    await task;

    expect(sent).toContain('任务已停止。');
  });
});

describe('错误提示语义与去重', () => {
  /**
   * 构造一次语义失败结果
   * @param overrides - 覆盖字段
   * @returns runQoder 的返回值
   */
  function semanticFailure(overrides: Record<string, unknown> = {}) {
    return {
      ok: false,
      text: '',
      errorKind: 'exit' as const,
      errorClass: 'model_quota' as const,
      errorCode: '110',
      error: '模型额度已用尽：今日调用次数达到上限。可稍后重试，或发 /model 切换模型。（退出码 1）',
      errorDetail: "You've reached your daily usage limit for Chat.",
      exitCode: 1,
      durationMs: 1,
      ...overrides,
    };
  }

  it('应该下发语义中文提示并记录最近失败', async () => {
    const { runtime, state, sent, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(semanticFailure());

    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent).toEqual([
      '模型额度已用尽：今日调用次数达到上限。可稍后重试，或发 /model 切换模型。（退出码 1）',
    ]);
    expect(state.lastFailure).toMatchObject({
      kind: 'exit',
      errorClass: 'model_quota',
      errorCode: '110',
      exitCode: 1,
    });
    expect(state.lastFailure?.taskId).toBeTruthy();
  });

  it('应该在窗口内对同类错误只发一条完整提示其余发 ack', async () => {
    const { runtime, state, sent, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(semanticFailure());

    for (let index = 0; index < 5; index += 1) {
      await runtime.processTask('u', `hello-${index}`, 'ctx');
    }

    expect(sent).toHaveLength(5);
    expect(sent[0]).toContain('模型额度已用尽：今日调用次数达到上限');
    for (const ack of sent.slice(1)) {
      expect(ack).toMatch(/^（模型额度已用尽同 \d{2}:\d{2} 那条，本次为第 \d+ 次，已略）$/);
      expect(ack.length).toBeLessThanOrEqual(60);
    }
    expect(sent[1]).toContain('第 1 次');
    expect(sent[4]).toContain('第 4 次');
    expect(state.outbox).toHaveLength(0);
    expect(state.quarantine).toHaveLength(0);
  });

  it('应该让不同类别互不抑制', async () => {
    const { runtime, sent, runQoder } = makeRuntime();
    runQoder
      .mockResolvedValueOnce(semanticFailure())
      .mockResolvedValueOnce(
        semanticFailure({
          errorClass: 'output_limit',
          errorCode: 'max_output_tokens',
          error: '回答被截断：模型输出达到上限，本次没有完整结果。可发 /model 换输出上限更大的模型，或把任务拆小。（退出码 1）',
        }),
      );

    await runtime.processTask('u', 'hello', 'ctx');
    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent[0]).toContain('模型额度已用尽');
    expect(sent[1]).toContain('回答被截断');
  });

  it('应该在窗口过期后重新发完整提示并把计数归零', async () => {
    let clock = 1_000_000;
    const { runtime, sent, runQoder } = makeRuntime({}, { now: () => clock });
    runQoder.mockResolvedValue(semanticFailure());

    await runtime.processTask('u', 'hello', 'ctx');
    clock += 60_000;
    await runtime.processTask('u', 'hello', 'ctx');
    clock += 600_000;
    await runtime.processTask('u', 'hello', 'ctx');
    clock += 60_000;
    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent[0]).toContain('模型额度已用尽：今日');
    expect(sent[1]).toContain('第 1 次');
    expect(sent[2]).toContain('模型额度已用尽：今日');
    expect(sent[3]).toContain('第 1 次');
  });

  it('应该在错误提示发送失败时不入队且不推进去重窗口', async () => {
    const { runtime, state, sent, sendText, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(semanticFailure());
    sendText.mockRejectedValueOnce(new BridgeSendError('下行额度受限', 'quota', { ret: -2 }));

    await runtime.processTask('u', 'hello', 'ctx');
    await runtime.processTask('u', 'hello', 'ctx');

    expect(state.outbox).toHaveLength(0);
    expect(state.quarantine).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('模型额度已用尽：今日');
  });

  it('应该对未识别的语义错误写告警日志', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { runtime, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(
      semanticFailure({
        errorClass: 'unknown',
        errorCode: 'rate_limit',
        error: '执行失败：qodercli 异常退出（退出码 1）。详见本机日志。',
        errorDetail: 'Rate limit exceeded, please slow down.',
      }),
    );

    await runtime.processTask('u', 'hello', 'ctx');

    const call = warn.mock.calls.find(([message]) => message === '未识别的 qodercli 语义错误');
    expect(call?.[1]).toMatchObject({ errorCode: 'rate_limit', taskId: expect.any(String) });
    expect(String(call?.[1]?.errorSummary)).toContain('Rate limit exceeded');
    warn.mockRestore();
  });

  it('应该对未识别的语义错误脱敏后再写日志', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { runtime, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(
      semanticFailure({
        errorClass: 'unknown',
        errorCode: 'server_error',
        errorDetail: 'Authorization: Bearer abcdefghijklmnop failed',
      }),
    );

    await runtime.processTask('u', 'hello', 'ctx');

    const call = warn.mock.calls.find(([message]) => message === '未识别的 qodercli 语义错误');
    expect(call).toBeTruthy();
    expect(String(call?.[1]?.errorSummary)).toContain('[REDACTED]');
    expect(String(call?.[1]?.errorSummary)).not.toContain('abcdefghijklmnop');
    warn.mockRestore();
  });

  it('应该在错误被抑制时写抑制日志', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const { runtime, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(semanticFailure());

    await runtime.processTask('u', 'hello', 'ctx');
    await runtime.processTask('u', 'hello', 'ctx');

    const call = info.mock.calls.find(([message]) => message === '错误提示被去重窗口抑制');
    expect(call?.[1]).toMatchObject({ category: 'suppressed', errorClass: 'model_quota', suppressed: 1 });
    info.mockRestore();
  });

  it('应该让 unknown 类不参与去重，每次都发完整提示', async () => {
    const { runtime, sent, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(
      semanticFailure({
        errorClass: 'unknown',
        errorCode: undefined,
        error: '执行失败：任务超过 600 秒被终止。详见本机日志。',
        errorDetail: undefined,
        errorKind: 'timeout',
      }),
    );

    await runtime.processTask('u', 'hello', 'ctx');
    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe('执行失败：任务超过 600 秒被终止。详见本机日志。');
    expect(sent[1]).toBe('执行失败：任务超过 600 秒被终止。详见本机日志。');
  });

  it('应该让同属 unknown 的不同根因互不抑制', async () => {
    const { runtime, sent, runQoder } = makeRuntime();
    runQoder
      .mockResolvedValueOnce(
        semanticFailure({
          errorClass: 'unknown',
          errorCode: undefined,
          error: '执行失败：无法启动 qodercli。请检查 QWB_QODER_BIN，详见本机日志。',
          errorDetail: undefined,
          errorKind: 'spawn',
        }),
      )
      .mockResolvedValueOnce(
        semanticFailure({
          errorClass: 'unknown',
          errorCode: 'rate_limit',
          error: '执行失败：qodercli 异常退出（退出码 1）。详见本机日志。',
          errorDetail: 'Rate limit exceeded',
        }),
      );

    await runtime.processTask('u', 'hello', 'ctx');
    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent[0]).toContain('无法启动 qodercli');
    expect(sent[1]).toBe('执行失败：qodercli 异常退出（退出码 1）。详见本机日志。');
  });

  it('应该在 unknown 被抑制时不写抑制日志', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const { runtime, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(semanticFailure({ errorClass: 'unknown', errorCode: 'rate_limit' }));

    await runtime.processTask('u', 'hello', 'ctx');
    await runtime.processTask('u', 'hello', 'ctx');

    expect(info.mock.calls.filter(([message]) => message === '错误提示被去重窗口抑制')).toHaveLength(0);
    info.mockRestore();
  });

  it('应该在错误提示未送达时写出告警内容', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { runtime, sendText, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(semanticFailure());
    sendText.mockRejectedValueOnce(new BridgeSendError('下行额度受限', 'quota', { ret: -2 }));

    await runtime.processTask('u', 'hello', 'ctx');

    const call = warn.mock.calls.find(([message]) => message === '错误提示未送达，不推进去重窗口');
    expect(call?.[1]).toMatchObject({ userId: 'u', errorClass: 'model_quota', outcome: 'skipped', suppressed: 0 });
    expect(call?.[1]?.taskId).toBeTruthy();
    warn.mockRestore();
  });

  it('应该在会话过期导致 ack 未送达时不入队', async () => {
    const { runtime, state, sent, sendText, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(semanticFailure());

    await runtime.processTask('u', 'hello', 'ctx');
    expect(sent).toHaveLength(1);

    sendText.mockRejectedValueOnce(new BridgeSendError('微信会话过期', 'session_expired', { ret: -14 }));
    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent).toHaveLength(1);
    expect(state.outbox).toHaveLength(0);
    expect(state.quarantine).toHaveLength(0);
  });

  it('应该在 ack 未送达时不推进抑制计数', async () => {
    const { runtime, sent, sendText, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(semanticFailure());

    await runtime.processTask('u', 'hello', 'ctx');
    sendText.mockRejectedValueOnce(new BridgeSendError('下行额度受限', 'quota', { ret: -2 }));
    await runtime.processTask('u', 'hello', 'ctx');
    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('第 1 次');
  });

  it('应该在任务成功时保留上一次失败记录', async () => {
    const { runtime, state, runQoder } = makeRuntime();
    runQoder.mockResolvedValueOnce(semanticFailure());
    await runtime.processTask('u', 'hello', 'ctx');
    const recorded = state.lastFailure;
    expect(recorded?.errorClass).toBe('model_quota');

    runQoder.mockResolvedValueOnce({ ok: true, text: 'done', sessionId: 's1', durationMs: 1 });
    await runtime.processTask('u', 'hello', 'ctx');

    expect(state.lastFailure).toEqual(recorded);
  });

  it('应该在任务结束的日志里带上语义类别与诊断路径', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const { runtime, runQoder } = makeRuntime();
    runQoder.mockResolvedValue(semanticFailure({ diagnosticPath: '/tmp/diag/1-task.log' }));

    await runtime.processTask('u', 'hello', 'ctx');

    const call = info.mock.calls.find(([message]) => message === '任务结束');
    expect(call?.[1]).toMatchObject({
      ok: false,
      errorKind: 'exit',
      errorClass: 'model_quota',
      errorCode: '110',
      diagnosticPath: '/tmp/diag/1-task.log',
    });
    info.mockRestore();
  });
});

describe('内置命令', () => {
  it('应该回复 help 与 reset', async () => {
    const { runtime, state, sent } = makeRuntime();
    state.sessions.u = { sessionId: 's1', updatedAt: 0, turns: 1 };

    await runtime.processTask('u', '/help', 'ctx');
    await runtime.processTask('u', '/reset', 'ctx');

    expect(sent[0]).toContain('可用命令');
    expect(sent[1]).toContain('会话已重置');
    expect(state.sessions.u).toBeUndefined();
  });

  it('应该回复 status 并展示队列信息', async () => {
    const { runtime, state, sent, sendText } = makeRuntime();
    state.outbox.push(outboxItem('old'));
    state.quota.streak = 2;
    sendText.mockImplementation(async (params: { text: string }) => {
      if (params.text === 'old') throw new BridgeSendError('bad', 'permanent');
      sent.push(params.text);
      return { ret: 0, message_id: 'm' };
    });

    await runtime.processTask('u', '/status', 'ctx');

    const status = sent.find((text) => text.includes('待补发'));
    expect(status).toContain('待补发：1 条');
    expect(status).toContain('隔离区：0 条');
    expect(status).toContain('连续 2 个窗口耗尽');
  });

  it('应该列出与切换模型', async () => {
    const { runtime, state, sent } = makeRuntime();

    await runtime.processTask('u', '/model', 'ctx');
    await runtime.processTask('u', '/model 1', 'ctx');
    await runtime.processTask('u', '/model default', 'ctx');
    await runtime.processTask('u', '/model nope', 'ctx');

    expect(sent[0]).toContain('当前模型');
    expect(sent[1]).toContain('已切换模型');
    expect(sent[2]).toContain('已恢复默认模型');
    expect(sent[3]).toContain('未找到模型');
    expect(state.models.u).toBeUndefined();
  });

  it('应该提示未知命令', async () => {
    const { runtime, sent } = makeRuntime();
    await runtime.processTask('u', '/foo', 'ctx');
    expect(sent[0]).toContain('未知命令');
  });
});

describe('handleInbound', () => {
  it('应该按 allowFrom 放行额外发送者', async () => {
    const { runtime, runQoder } = makeRuntime({ allowFrom: ['x'] });
    await runtime.handleInbound(textMessage('hello', 'm-allow', 'x'));
    await runtime.waitForIdle();

    expect(runQoder).toHaveBeenCalled();
  });

  it('应该忽略未授权发送者', async () => {
    const { runtime, sent, runQoder } = makeRuntime();
    await runtime.handleInbound(textMessage('hello', 'm1', 'other'));
    await runtime.waitForIdle();

    expect(runQoder).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('应该支持 allowFirstSender', async () => {
    const { runtime, runQoder } = makeRuntime({ ownerUserId: '', allowFirstSender: true });
    expect(runtime.getConfig().allowFirstSender).toBe(true);
    await runtime.handleInbound(textMessage('hello', 'm1', 'first'));
    await runtime.waitForIdle();

    expect(runtime.getConfig().ownerUserId).toBe('first');
    expect(runQoder).toHaveBeenCalled();
  });

  it('应该按 message_id 去重', async () => {
    const { runtime, runQoder } = makeRuntime();
    await runtime.handleInbound(textMessage('hello', 'same'));
    await runtime.waitForIdle();
    await runtime.handleInbound(textMessage('hello', 'same'));
    await runtime.waitForIdle();

    expect(runQoder).toHaveBeenCalledTimes(1);
  });

  it('应该在无转写语音时直接提示', async () => {
    const { runtime, sent, runQoder } = makeRuntime();
    const msg: WeixinMessage = {
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'voice-1',
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.VOICE, voice_item: { playtime: 1000 } }],
    };

    await runtime.handleInbound(msg);
    await runtime.waitForIdle();

    expect(runQoder).not.toHaveBeenCalled();
    expect(sent[0]).toContain('没有转写');
  });

  it('应该把图片作为附件交给 qoder', async () => {
    const { runtime, runQoder, downloadItemMedia } = makeRuntime();
    downloadItemMedia.mockResolvedValueOnce({
      name: 'a.png',
      kind: 'image',
      path: '/tmp/a.png',
      bytes: 10,
    });
    const msg: WeixinMessage = {
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'img-1',
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.IMAGE, image_item: { url: 'https://img' } }],
    };

    await runtime.handleInbound(msg);
    await runtime.waitForIdle();

    expect(runQoder).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: ['/tmp/a.png'], prompt: expect.stringContaining('附件') }),
    );
  });

  it('应该为视频、文件与图片生成失败描述', async () => {
    const { runtime, runQoder, downloadItemMedia } = makeRuntime();
    downloadItemMedia.mockResolvedValueOnce(null);
    await runtime.handleInbound({
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'video-1',
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.VIDEO, video_item: { playtime: 1 } }],
    });
    await runtime.waitForIdle();

    downloadItemMedia.mockResolvedValueOnce(null);
    await runtime.handleInbound({
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'file-1',
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.FILE, file_item: { file_name: 'a.txt' } }],
    });
    await runtime.waitForIdle();

    downloadItemMedia.mockResolvedValueOnce(null);
    await runtime.handleInbound({
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'image-1',
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.IMAGE, image_item: { url: 'https://img' } }],
    });
    await runtime.waitForIdle();

    expect(runQoder).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('视频') }));
    expect(runQoder).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('文件「a.txt」') }));
    expect(runQoder).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('图片') }));
  });

  it('应该使用带转写的语音文本执行任务', async () => {
    const { runtime, runQoder } = makeRuntime();
    await runtime.handleInbound({
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'voice-text',
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.VOICE, voice_item: { text: '语音内容' } }],
    });
    await runtime.waitForIdle();

    expect(runQoder).toHaveBeenCalledWith(expect.objectContaining({ prompt: '语音内容' }));
  });

  it('应该在附件下载失败时继续执行', async () => {
    const { runtime, runQoder, downloadItemMedia } = makeRuntime();
    downloadItemMedia.mockRejectedValueOnce(new Error('download failed'));
    const msg: WeixinMessage = {
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'img-2',
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.IMAGE, image_item: { url: 'https://img' } }],
    };

    await runtime.handleInbound(msg);
    await runtime.waitForIdle();

    expect(runQoder).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('无法读取') }));
  });

  it('应该在没有运行任务时回复 stop', async () => {
    const { runtime, sent } = makeRuntime();
    await runtime.handleInbound(textMessage('/stop', 'stop-2'));
    expect(sent).toContain('当前没有正在执行的任务。');
  });

  it('应该忽略未知消息项', async () => {
    const { runtime, runQoder } = makeRuntime();
    await runtime.handleInbound({
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'tool-1',
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.TOOL_CALL_START }],
    });
    await runtime.waitForIdle();
    expect(runQoder).not.toHaveBeenCalled();
  });

  it('应该忽略缺少内容的消息', async () => {
    const { runtime, runQoder } = makeRuntime();
    await runtime.handleInbound({
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'empty-1',
      context_token: 'ctx',
      item_list: [],
    });
    await runtime.waitForIdle();
    expect(runQoder).not.toHaveBeenCalled();
  });
});

describe('队列与清理分支', () => {
  it('应该按创建时间补发多个 outbox 消息', async () => {
    const { runtime, state, sent } = makeRuntime();
    state.outbox.push(outboxItem('later', Date.now()), outboxItem('earlier', Date.now() - 1000));

    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent).toEqual(['earlier', 'later', 'reply']);
  });

  it('应该记录瞬时与未知失败', async () => {
    const transient = makeRuntime();
    transient.state.outbox.push(outboxItem('transient'));
    transient.sendText.mockRejectedValueOnce(new BridgeSendError('net', 'transient'));
    await transient.runtime.processTask('u', 'hello', 'ctx');
    expect(transient.state.outbox.find((item) => item.text === 'transient')?.transientFailures).toBe(1);

    const unknown = makeRuntime();
    unknown.state.outbox.push(outboxItem('unknown'));
    unknown.sendText.mockRejectedValueOnce(new BridgeSendError('weird', 'unknown'));
    await unknown.runtime.processTask('u', 'hello', 'ctx');
    expect(unknown.state.outbox.find((item) => item.text === 'unknown')?.failures).toBe(1);
  });

  it('应该在控制消息发送失败时记录告警', async () => {
    const onSessionExpired = vi.fn();
    const { runtime, sendText } = makeRuntime({}, { onSessionExpired });
    sendText.mockRejectedValueOnce(new BridgeSendError('expired', 'session_expired'));

    await runtime.handleInbound(textMessage('/stop', 'stop-fail'));

    expect(onSessionExpired).toHaveBeenCalled();
  });

  it('应该在待发提醒超限时丢弃最旧并保持顺序', async () => {
    const { runtime, state, sent, takePending } = makeRuntime({ outboxMaxItems: 1 });
    takePending.mockReturnValue([
      { id: 'p1', toUserId: 'u', text: 'one', createdAt: Date.now() },
      { id: 'p2', toUserId: 'u', text: 'two', createdAt: Date.now() + 1 },
    ]);

    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent).toEqual(['two', 'reply']);
    expect(state.outbox).toEqual([]);
  });

  it('应该清理过期与超限消息并记录', () => {
    const now = Date.now();
    const { runtime, state } = makeRuntime({
      outboxMaxItems: 1,
      outboxTtlMs: 1000,
      quarantineMaxItems: 1,
      quarantineTtlMs: 1000,
    });
    state.outbox.push(
      outboxItem('expired', now - 5000),
      outboxItem('keep1', now),
      outboxItem('keep2', now + 1),
    );
    state.quarantine.push(
      { ...outboxItem('q1'), quarantinedAt: now - 5000, reason: 'x', preview: 'q1' },
      { ...outboxItem('q2'), quarantinedAt: now, reason: 'x', preview: 'q2' },
    );

    runtime.prune();

    expect(state.outbox.map((item) => item.text)).toEqual(['keep2']);
    expect(state.quarantine.map((item) => item.text)).toEqual(['q2']);
  });

  it('应该在存在 typing ticket 时发送并取消 typing', async () => {
    const { runtime, sendTyping } = makeRuntime({}, { getTypingTicket: vi.fn(async () => 'ticket') });

    await runtime.processTask('u', 'hello', 'ctx');

    expect(sendTyping).toHaveBeenCalledWith(expect.objectContaining({ status: 1 }));
    expect(sendTyping).toHaveBeenCalledWith(expect.objectContaining({ status: 2 }));
  });

  it('应该忽略非用户消息与缺少发送者的消息', async () => {
    const { runtime, runQoder } = makeRuntime();
    await runtime.handleInbound({ message_type: MessageType.BOT } as WeixinMessage);
    await runtime.handleInbound({ message_type: MessageType.USER } as WeixinMessage);

    expect(runQoder).not.toHaveBeenCalled();
  });

  it('应该限制已见消息 id 数量', async () => {
    const { runtime, state } = makeRuntime();
    state.seenMessageIds = Array.from({ length: 500 }, (_, index) => `old-${index}`);

    await runtime.handleInbound(textMessage('hello', 'new'));
    await runtime.waitForIdle();

    expect(state.seenMessageIds.length).toBeLessThanOrEqual(500);
    expect(state.seenMessageIds).toContain('new');
  });

  it('应该下载无转写语音并继续执行文本', async () => {
    const { runtime, runQoder, downloadItemMedia } = makeRuntime();
    downloadItemMedia.mockResolvedValueOnce({
      name: 'v.silk',
      kind: 'voice',
      path: '/tmp/v.silk',
      bytes: 1,
    });

    await runtime.handleInbound({
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'voice-mix',
      context_token: 'ctx',
      item_list: [
        { type: MessageItemType.VOICE, voice_item: { playtime: 1000 } },
        { type: MessageItemType.TEXT, text_item: { text: 'hello' } },
      ],
    });
    await runtime.waitForIdle();

    expect(runQoder).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('语音（无转写）') }),
    );
  });

  it('应该取消所有进行中的任务', async () => {
    const runQoder = vi.fn(
      (input: { onStart?: (cancel: () => void) => void }) =>
        new Promise((resolve) => {
          input.onStart?.(() => resolve({ ok: false, text: '', errorKind: 'exit', durationMs: 1 }));
        }),
    );
    const { runtime, sent } = makeRuntime({}, { runQoder });

    const task = runtime.processTask('u', 'hello', 'ctx');
    await new Promise((resolve) => setImmediate(resolve));
    runtime.cancelAllTasks();
    await task;

    expect(sent).toContain('任务已停止。');
  });

  it('应该在任务抛错时记录并继续', async () => {
    const { runtime } = makeRuntime({}, {
      runQoder: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    await runtime.handleInbound(textMessage('hello', 'err'));
    await runtime.waitForIdle();
  });
});

describe('pending 提醒', () => {
  it('应该把当前用户提醒排在任务结果之前', async () => {
    const { runtime, sent, takePending } = makeRuntime();
    takePending.mockReturnValue([{ id: 'p1', toUserId: 'u', text: '提醒', createdAt: Date.now() }]);

    await runtime.processTask('u', 'hello', 'ctx');

    expect(sent).toEqual(['提醒', 'reply']);
  });

  it('应该保留其他用户的提醒', async () => {
    const { runtime, state, takePending } = makeRuntime();
    takePending.mockReturnValue([{ id: 'p1', toUserId: 'other', text: '提醒', createdAt: Date.now() }]);

    await runtime.processTask('u', 'hello', 'ctx');

    expect(state.outbox.map((item) => item.toUserId)).toEqual(['other']);
  });
});
