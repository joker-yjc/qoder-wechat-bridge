import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type OutboxItem } from '../../src/config.js';
import {
  flushOutbox,
  type DeliveryOutcome,
  type OutboxPolicy,
} from '../../src/bridge/outbox.js';

const outcomeKinds = ['sent', 'quota', 'session_expired', 'transient', 'permanent', 'unknown'] as const;

const policy: OutboxPolicy = {
  maxItems: 100,
  ttlMs: 1_000_000,
  poisonMaxAttempts: 3,
  transientMaxAttempts: 10,
  quarantineMaxItems: 100,
  quarantineTtlMs: 1_000_000,
  now: () => 1_000,
};

/**
 * 按序号构造消息
 * @param index - 序号
 * @returns outbox 消息
 */
function makeItem(index: number): OutboxItem {
  return {
    id: String(index),
    toUserId: 'u',
    text: `msg-${index}`,
    kind: 'reply',
    createdAt: index,
    bytes: 5,
    failures: 0,
    transientFailures: 0,
  };
}

describe('outbox 状态机属性', () => {
  it('应该让每条消息只落在发送、隔离或剩余之一，并保持剩余顺序', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...outcomeKinds), { maxLength: 20 }),
        fc.integer({ min: 0, max: 20 }),
        async (kinds, budget) => {
          const items = kinds.map((_, index) => makeItem(index));
          const outcomes: DeliveryOutcome[] = kinds.map((kind) => ({ kind }) as DeliveryOutcome);

          const result = await flushOutbox({
            items,
            budget,
            policy,
            send: async () => outcomes.shift() ?? { kind: 'sent' },
          });

          expect(result.remaining.length + result.quarantined.length + result.sent).toBe(items.length);
          expect(result.budgetLeft).toBe(Math.max(0, budget - result.sent));
          expect(result.quarantined.every((item) => item.lastErrorKind !== 'quota')).toBe(true);

          const inputIds = items.map((item) => item.id);
          let cursor = 0;
          for (const item of result.remaining) {
            const index = inputIds.indexOf(item.id, cursor);
            expect(index).toBeGreaterThanOrEqual(0);
            cursor = index + 1;
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
