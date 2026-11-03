import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STATE, type OutboxItem, type QuarantineItem, type State } from '../../src/config.js';
import {
  flushOutbox,
  pruneOutbox,
  pushOutbox,
  quarantineItem,
  type DeliveryOutcome,
  type OutboxPolicy,
} from '../../src/bridge/outbox.js';

/** 构造一条 outbox 消息 */
function makeItem(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'a',
    toUserId: 'u',
    text: 'hello',
    kind: 'reply',
    createdAt: 1,
    bytes: 5,
    failures: 0,
    transientFailures: 0,
    ...overrides,
  };
}

/** 构造策略 */
function makePolicy(overrides: Partial<OutboxPolicy> = {}): OutboxPolicy {
  return {
    maxItems: 10,
    ttlMs: 1000,
    poisonMaxAttempts: 3,
    transientMaxAttempts: 2,
    quarantineMaxItems: 5,
    quarantineTtlMs: 5000,
    now: () => 1000,
    ...overrides,
  };
}

/** 构造状态 */
function makeState(items: OutboxItem[], quarantine: QuarantineItem[] = []): State {
  return { ...DEFAULT_STATE, outbox: items, quarantine };
}

describe('flushOutbox', () => {
  it('应该在空队列时不调用发送', async () => {
    const send = vi.fn();
    const result = await flushOutbox({ items: [], budget: 5, policy: makePolicy(), send });

    expect(result).toEqual({ remaining: [], quarantined: [], sent: 0, budgetLeft: 5, stopReason: 'done' });
    expect(send).not.toHaveBeenCalled();
  });

  it('应该在发送成功时删除消息并扣减预算', async () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];
    const result = await flushOutbox({
      items,
      budget: 2,
      policy: makePolicy(),
      send: async () => ({ kind: 'sent' }),
    });

    expect(result.remaining).toEqual([]);
    expect(result.sent).toBe(2);
    expect(result.budgetLeft).toBe(0);
    expect(result.stopReason).toBe('done');
  });

  it('应该在预算不足时保留剩余消息', async () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];
    const result = await flushOutbox({
      items,
      budget: 1,
      policy: makePolicy(),
      send: async () => ({ kind: 'sent' }),
    });

    expect(result.remaining.map((item) => item.id)).toEqual(['b']);
    expect(result.stopReason).toBe('budget');
  });

  it('应该在额度耗尽时不计数并保留全部消息', async () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];
    const result = await flushOutbox({
      items,
      budget: 5,
      policy: makePolicy(),
      send: async () => ({ kind: 'quota' }),
    });

    expect(result.remaining.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.sent).toBe(0);
    expect(result.stopReason).toBe('quota');
    expect(items[0]?.failures).toBe(0);
    expect(items[0]?.transientFailures).toBe(0);
  });

  it('应该在会话过期时保留全部消息', async () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];
    const result = await flushOutbox({
      items,
      budget: 5,
      policy: makePolicy(),
      send: async () => ({ kind: 'session_expired' }),
    });

    expect(result.remaining.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.stopReason).toBe('session_expired');
    expect(items[0]?.failures).toBe(0);
  });

  it('应该在瞬时失败未达阈值时停止本轮', async () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];
    const result = await flushOutbox({
      items,
      budget: 5,
      policy: makePolicy({ transientMaxAttempts: 2 }),
      send: async () => ({ kind: 'transient', reason: 'net' }),
    });

    expect(result.remaining.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.stopReason).toBe('transient');
    expect(items[0]?.transientFailures).toBe(1);
    expect(items[0]?.lastErrorKind).toBe('transient');
  });

  it('应该在瞬时失败达到阈值时隔离并继续', async () => {
    const items = [makeItem({ id: 'a', transientFailures: 1 }), makeItem({ id: 'b' })];
    const outcomes: DeliveryOutcome[] = [{ kind: 'transient', reason: 'net' }, { kind: 'sent' }];
    const result = await flushOutbox({
      items,
      budget: 5,
      policy: makePolicy({ transientMaxAttempts: 2 }),
      send: async () => outcomes.shift() ?? { kind: 'sent' },
    });

    expect(result.quarantined.map((item) => item.id)).toEqual(['a']);
    expect(result.remaining).toEqual([]);
    expect(result.sent).toBe(1);
  });

  it('应该在永久失败未达阈值时跳过并继续', async () => {
    const items = [makeItem({ id: 'bad' }), makeItem({ id: 'good' })];
    const outcomes: DeliveryOutcome[] = [{ kind: 'permanent', reason: '400' }, { kind: 'sent' }];
    const result = await flushOutbox({
      items,
      budget: 5,
      policy: makePolicy({ poisonMaxAttempts: 3 }),
      send: async () => outcomes.shift() ?? { kind: 'sent' },
    });

    expect(result.remaining.map((item) => item.id)).toEqual(['bad']);
    expect(items[0]?.failures).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.stopReason).toBe('done');
  });

  it('应该在永久失败达到阈值时隔离并继续', async () => {
    const items = [makeItem({ id: 'bad', failures: 2 }), makeItem({ id: 'good' })];
    const outcomes: DeliveryOutcome[] = [{ kind: 'permanent', reason: '400' }, { kind: 'sent' }];
    const result = await flushOutbox({
      items,
      budget: 5,
      policy: makePolicy({ poisonMaxAttempts: 3 }),
      send: async () => outcomes.shift() ?? { kind: 'sent' },
    });

    expect(result.quarantined.map((item) => item.id)).toEqual(['bad']);
    expect(result.remaining).toEqual([]);
    expect(result.sent).toBe(1);
  });

  it('应该在发送函数抛异常时按未知失败处理', async () => {
    const items = [makeItem({ id: 'bad' })];
    const result = await flushOutbox({
      items,
      budget: 1,
      policy: makePolicy({ poisonMaxAttempts: 2 }),
      send: async () => {
        throw new Error('boom');
      },
    });

    expect(items[0]?.failures).toBe(1);
    expect(items[0]?.lastErrorKind).toBe('unknown');
    expect(result.remaining.map((item) => item.id)).toEqual(['bad']);
  });

  it('应该把未知失败按永久失败处理', async () => {
    const items = [makeItem({ id: 'bad' })];
    const result = await flushOutbox({
      items,
      budget: 5,
      policy: makePolicy({ poisonMaxAttempts: 1 }),
      send: async () => ({ kind: 'unknown', reason: 'code 9' }),
    });

    expect(result.quarantined.map((item) => item.id)).toEqual(['bad']);
    expect(items[0]?.lastErrorKind).toBe('unknown');
  });

  it('应该在混合结果下保持剩余消息的原始顺序', async () => {
    const items = [makeItem({ id: 'bad' }), makeItem({ id: 'good' }), makeItem({ id: 'quota' })];
    const outcomes: DeliveryOutcome[] = [
      { kind: 'permanent', reason: '400' },
      { kind: 'sent' },
      { kind: 'quota' },
    ];
    const result = await flushOutbox({
      items,
      budget: 5,
      policy: makePolicy(),
      send: async () => outcomes.shift() ?? { kind: 'sent' },
    });

    expect(result.remaining.map((item) => item.id)).toEqual(['bad', 'quota']);
    expect(result.sent).toBe(1);
    expect(result.stopReason).toBe('quota');
  });
});

describe('pushOutbox', () => {
  it('应该在超限时丢弃最旧消息', () => {
    const state = makeState([makeItem({ id: 'a', createdAt: 1 }), makeItem({ id: 'b', createdAt: 2 })]);
    const { dropped } = pushOutbox(state, makeItem({ id: 'c', createdAt: 3 }), makePolicy({ maxItems: 2 }));

    expect(dropped.map((item) => item.id)).toEqual(['a']);
    expect(state.outbox.map((item) => item.id)).toEqual(['b', 'c']);
  });
});

describe('pruneOutbox', () => {
  it('应该删除过期消息并保留新消息', () => {
    const state = makeState([
      makeItem({ id: 'old', createdAt: 0 }),
      makeItem({ id: 'new', createdAt: 900 }),
    ]);
    const result = pruneOutbox(state, makePolicy({ ttlMs: 1000, now: () => 1500 }));

    expect(result.expired.map((item) => item.id)).toEqual(['old']);
    expect(state.outbox.map((item) => item.id)).toEqual(['new']);
  });

  it('应该在超限时按最旧优先丢弃', () => {
    const state = makeState([
      makeItem({ id: 'a', createdAt: 1 }),
      makeItem({ id: 'b', createdAt: 2 }),
      makeItem({ id: 'c', createdAt: 3 }),
    ]);
    const result = pruneOutbox(state, makePolicy({ maxItems: 2, now: () => 10 }));

    expect(result.dropped.map((item) => item.id)).toEqual(['a']);
    expect(state.outbox.map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('应该清理过期与超限的隔离消息', () => {
    const quarantine: QuarantineItem[] = [
      {
        ...makeItem({ id: 'q1', createdAt: 0 }),
        quarantinedAt: 0,
        reason: 'permanent',
        preview: 'q1',
      },
      {
        ...makeItem({ id: 'q2', createdAt: 600 }),
        quarantinedAt: 600,
        reason: 'permanent',
        preview: 'q2',
      },
      {
        ...makeItem({ id: 'q3', createdAt: 700 }),
        quarantinedAt: 700,
        reason: 'permanent',
        preview: 'q3',
      },
    ];
    const state = makeState([], quarantine);
    const result = pruneOutbox(
      state,
      makePolicy({ quarantineTtlMs: 1000, quarantineMaxItems: 1, now: () => 1500 }),
    );

    expect(result.quarantineExpired.map((item) => item.id)).toEqual(['q1']);
    expect(result.quarantineDropped.map((item) => item.id)).toEqual(['q2']);
    expect(state.quarantine.map((item) => item.id)).toEqual(['q3']);
  });
});

describe('quarantineItem', () => {
  it('应该把消息移入隔离区并生成脱敏预览', () => {
    const item = makeItem({ id: 'bad', text: 'secret-token-abcdefghijklmnopqrstuvwxyz' });
    const state = makeState([item]);
    const policy = makePolicy({ redact: (text) => text.replace('secret-token', '[redacted]') });

    const quarantined = quarantineItem(state, item, 'permanent', policy);

    expect(state.outbox).toEqual([]);
    expect(state.quarantine).toHaveLength(1);
    expect(quarantined.preview.startsWith('[redacted]')).toBe(true);
    expect(quarantined.reason).toBe('permanent');
    expect(quarantined.preview.length).toBeLessThanOrEqual(120);
  });

  it('应该在隔离区超限时丢弃最旧项', () => {
    const state = makeState(
      [makeItem({ id: 'new' })],
      [
        {
          ...makeItem({ id: 'old' }),
          quarantinedAt: 1,
          reason: 'permanent',
          preview: 'old',
        },
      ],
    );

    quarantineItem(state, state.outbox[0] as OutboxItem, 'permanent', makePolicy({ quarantineMaxItems: 1 }));

    expect(state.quarantine.map((item) => item.id)).toEqual(['new']);
  });
});
