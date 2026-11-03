import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE, type State } from '../../src/config.js';
import { BridgeSendError } from '../../src/weixin/errors.js';
import { OutboundSession, type OutboundSend } from '../../src/bridge/outbound.js';
import type { OutboxPolicy } from '../../src/bridge/outbox.js';

const policy: OutboxPolicy = {
  maxItems: 10,
  ttlMs: 1_000_000,
  poisonMaxAttempts: 3,
  transientMaxAttempts: 10,
  quarantineMaxItems: 10,
  quarantineTtlMs: 1_000_000,
  now: () => 1_000,
};

/**
 * 构造会话与状态
 * @param send - 发送函数
 * @param overrides - 覆盖选项
 * @returns 状态与会话
 */
function makeSession(
  send: OutboundSend,
  overrides: { budget?: number; state?: State; maxChars?: number } = {},
): { state: State; session: OutboundSession } {
  const state = overrides.state ?? { ...DEFAULT_STATE, outbox: [] };
  const session = new OutboundSession({
    state,
    toUserId: 'u',
    policy,
    maxChars: overrides.maxChars ?? 5,
    budget: overrides.budget ?? 5,
    send,
    now: () => 1_000,
  });
  return { state, session };
}

describe('sendSingle', () => {
  it('应该在成功时扣减预算并记录发送数', async () => {
    const send = vi.fn(async () => ({ messageId: 'm1' }));
    const { state, session } = makeSession(send);

    await expect(session.sendSingle('hello', { kind: 'reply', queueOnFailure: true })).resolves.toBe('sent');
    expect(session.budget).toBe(4);
    expect(session.sentCount).toBe(1);
    expect(state.outbox).toEqual([]);
  });

  it('应该在预算耗尽时直接入队且不调用发送', async () => {
    const send = vi.fn();
    const { state, session } = makeSession(send, { budget: 0 });

    await expect(session.sendSingle('hello', { kind: 'reply', queueOnFailure: true })).resolves.toBe('queued');
    expect(send).not.toHaveBeenCalled();
    expect(state.outbox).toHaveLength(1);
  });

  it('应该在额度耗尽时停止发送并保留消息', async () => {
    const send = vi.fn(async () => {
      throw new BridgeSendError('quota', 'quota', { ret: -2 });
    });
    const { state, session } = makeSession(send);

    await expect(session.sendSingle('hello', { kind: 'reply', queueOnFailure: true })).resolves.toBe('queued');
    expect(session.quotaExhausted).toBe(true);
    expect(state.outbox[0]).toMatchObject({ failures: 0, transientFailures: 0, lastErrorKind: 'quota' });

    await expect(session.sendSingle('world', { kind: 'reply', queueOnFailure: true })).resolves.toBe('queued');
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.outbox).toHaveLength(2);
  });

  it('应该在会话过期时标记 sessionExpired', async () => {
    const send = vi.fn(async () => {
      throw new BridgeSendError('expired', 'session_expired');
    });
    const { state, session } = makeSession(send);

    await expect(session.sendSingle('hello', { kind: 'reply', queueOnFailure: true })).resolves.toBe('queued');
    expect(session.sessionExpired).toBe(true);
    expect(state.outbox[0]?.failures).toBe(0);
  });

  it('应该在瞬时失败时记录 transientFailures', async () => {
    const send = vi.fn(async () => {
      throw new BridgeSendError('net', 'transient');
    });
    const { state, session } = makeSession(send);

    await session.sendSingle('hello', { kind: 'reply', queueOnFailure: true });
    expect(state.outbox[0]).toMatchObject({ failures: 0, transientFailures: 1, lastErrorKind: 'transient' });
  });

  it('应该在永久 / 未知失败时记录 failures', async () => {
    const permanent = vi.fn(async () => {
      throw new BridgeSendError('bad', 'permanent');
    });
    const unknown = vi.fn(async () => {
      throw new BridgeSendError('weird', 'unknown');
    });
    const first = makeSession(permanent);
    const second = makeSession(unknown);

    await first.session.sendSingle('hello', { kind: 'reply', queueOnFailure: true });
    await second.session.sendSingle('hello', { kind: 'reply', queueOnFailure: true });

    expect(first.state.outbox[0]).toMatchObject({ failures: 1, lastErrorKind: 'permanent' });
    expect(second.state.outbox[0]).toMatchObject({ failures: 1, lastErrorKind: 'unknown' });
  });

  it('应该在 queueOnFailure=false 时只记录不入队', async () => {
    const send = vi.fn(async () => {
      throw new BridgeSendError('quota', 'quota');
    });
    const { state, session } = makeSession(send);

    await expect(session.sendSingle('hello', { kind: 'error', queueOnFailure: false })).resolves.toBe('skipped');
    expect(state.outbox).toEqual([]);
  });

  it('应该在空文本时跳过', async () => {
    const send = vi.fn();
    const { session } = makeSession(send);
    await expect(session.sendSingle('   ', { kind: 'reply', queueOnFailure: true })).resolves.toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('sendChunked', () => {
  it('应该在分片全部成功时返回发送数', async () => {
    const send = vi.fn(async () => ({ messageId: 'm' }));
    const { state, session } = makeSession(send, { maxChars: 5 });

    const result = await session.sendChunked('abcdefghij', { kind: 'reply' });

    expect(result).toEqual({ sent: 2, queued: 0 });
    expect(state.outbox).toEqual([]);
    expect(session.budget).toBe(3);
  });

  it('应该在预算不足时把剩余分片按顺序入队', async () => {
    const send = vi.fn(async () => ({ messageId: 'm' }));
    const { state, session } = makeSession(send, { maxChars: 3, budget: 1 });

    const result = await session.sendChunked('abcdef', { kind: 'reply' });

    expect(result).toEqual({ sent: 1, queued: 1 });
    expect(state.outbox.map((item) => item.text)).toEqual(['def']);
  });

  it('应该在分片永久失败时保留当前与后续分片', async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new BridgeSendError('bad', 'permanent');
      return { messageId: 'm' };
    });
    const { state, session } = makeSession(send, { maxChars: 3 });

    const result = await session.sendChunked('abcdef', { kind: 'reply' });

    expect(result).toEqual({ sent: 1, queued: 1 });
    expect(state.outbox[0]).toMatchObject({ text: 'def', failures: 1, lastErrorKind: 'permanent' });
  });

  it('应该在额度耗尽时保留全部分片且不计数', async () => {
    const send = vi.fn(async () => {
      throw new BridgeSendError('quota', 'quota');
    });
    const { state, session } = makeSession(send, { maxChars: 3 });

    const result = await session.sendChunked('abcdef', { kind: 'reply' });

    expect(result).toEqual({ sent: 0, queued: 2 });
    expect(state.outbox).toHaveLength(2);
    expect(state.outbox.every((item) => item.failures === 0 && item.transientFailures === 0)).toBe(true);
    expect(session.quotaExhausted).toBe(true);
  });

  it('应该在空文本时不分片', async () => {
    const send = vi.fn();
    const { session } = makeSession(send);
    await expect(session.sendChunked('   ', { kind: 'reply' })).resolves.toEqual({ sent: 0, queued: 0 });
  });
});

describe('enqueue', () => {
  it('应该在超出上限时丢弃最旧消息', () => {
    const state: State = { ...DEFAULT_STATE, outbox: [] };
    const session = new OutboundSession({
      state,
      toUserId: 'u',
      policy: { ...policy, maxItems: 1 },
      maxChars: 5,
      budget: 1,
      send: async () => ({}),
      now: () => 1_000,
    });

    session.enqueue('first', { kind: 'reply' });
    const dropped = session.enqueue('second', { kind: 'reply' });

    expect(dropped.map((item) => item.text)).toEqual(['first']);
    expect(state.outbox.map((item) => item.text)).toEqual(['second']);
  });
});
