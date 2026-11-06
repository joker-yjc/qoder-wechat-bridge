import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ErrorDedupStore } from '../../src/bridge/error-dedup.js';
import type { QoderErrorClass } from '../../src/bridge/error-class.js';

const WINDOW_MS = 600_000;
const CLASSES: QoderErrorClass[] = ['model_quota', 'output_limit', 'auth', 'unknown'];
const USERS = ['user-a', 'user-b'];

/** 一次失败事件 */
interface FailureEvent {
  userId: string;
  errorClass: QoderErrorClass;
  /** 相对上一事件的时间增量，非负，保证时间单调 */
  gapMs: number;
  /** 下行是否真正送达 */
  delivered: boolean;
}

/** 事件序列生成器 */
const eventsArb = fc.array(
  fc.record({
    userId: fc.constantFrom(...USERS),
    errorClass: fc.constantFrom(...CLASSES),
    gapMs: fc.integer({ min: 0, max: WINDOW_MS * 2 }),
    delivered: fc.boolean(),
  }),
  { minLength: 1, maxLength: 60 },
);

/** 密集事件序列生成器：键空间小、间隔远小于窗口，保证 ack 场景高频出现 */
const denseEventsArb = fc.array(
  fc.record({
    userId: fc.constantFrom('user-a'),
    errorClass: fc.constantFrom<QoderErrorClass>('model_quota', 'output_limit'),
    gapMs: fc.integer({ min: 0, max: Math.floor(WINDOW_MS / 8) }),
    delivered: fc.boolean(),
  }),
  { minLength: 6, maxLength: 40 },
);

/**
 * 按事件序列跑一遍去重存储
 * @param events - 失败事件序列
 * @returns 每次真正下发完整提示的时间与键
 */
function replay(events: FailureEvent[]): Array<{ key: string; at: number; full: boolean }> {
  let current = 0;
  const store = new ErrorDedupStore({ windowMs: WINDOW_MS, now: () => current });
  const notices: Array<{ key: string; at: number; full: boolean }> = [];

  for (const event of events) {
    current += event.gapMs;
    const decision = store.plan(event.userId, event.errorClass);
    if (!event.delivered) continue;
    store.commit(event.userId, event.errorClass, decision.full);
    notices.push({ key: `${event.userId}\u0000${event.errorClass}`, at: current, full: decision.full });
  }

  return notices;
}

describe('错误提示去重属性', () => {
  it('应该保证同一键的相邻完整提示间隔不小于窗口时长', () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        const fulls = replay(events).filter((notice) => notice.full);
        const lastBy = new Map<string, number>();
        for (const notice of fulls) {
          const previous = lastBy.get(notice.key);
          if (previous !== undefined) expect(notice.at - previous).toBeGreaterThanOrEqual(WINDOW_MS);
          lastBy.set(notice.key, notice.at);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('应该保证任一窗口内每个键最多下发一条完整提示', () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        const fulls = replay(events).filter((notice) => notice.full);
        for (const anchor of fulls) {
          const inWindow = fulls.filter(
            (other) => other.key === anchor.key && other.at >= anchor.at && other.at < anchor.at + WINDOW_MS,
          );
          expect(inWindow).toHaveLength(1);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('应该保证未送达的事件不改变已送达事件看到的决策', () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        // 先把相对增量折算成绝对时间轴，两次重放共用同一条时间轴
        const timeline: Array<FailureEvent & { at: number }> = [];
        let clock = 0;
        for (const event of events) {
          clock += event.gapMs;
          timeline.push({ ...event, at: clock });
        }

        /**
         * 按时间轴重放一次，只记录已送达事件的决策
         * @param skipUndelivered - 是否完全跳过未送达事件（连 plan 都不调）
         * @returns 已送达事件的决策序列
         */
        const run = (skipUndelivered: boolean) => {
          let index = 0;
          const store = new ErrorDedupStore({ windowMs: WINDOW_MS, now: () => timeline[index]!.at });
          const records: Array<{ key: string; full: boolean; suppressed: number }> = [];
          for (const event of timeline) {
            if (event.delivered || !skipUndelivered) {
              const decision = store.plan(event.userId, event.errorClass);
              if (event.delivered) {
                store.commit(event.userId, event.errorClass, decision.full);
                records.push({
                  key: `${event.userId}\u0000${event.errorClass}`,
                  full: decision.full,
                  suppressed: decision.suppressed,
                });
              }
            }
            index += 1;
          }
          return records;
        };

        // 未送达事件若污染了存储（plan 有副作用、或误调了 commit），两次重放的决策序列就会不同
        expect(run(false)).toEqual(run(true));
      }),
      { numRuns: 300 },
    );
  });

  it('应该保证全部未送达时同一键反复尝试完整提示', () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        const allFailed = events.map((event) => ({ ...event, delivered: false }));
        let current = 0;
        const store = new ErrorDedupStore({ windowMs: WINDOW_MS, now: () => current });
        for (const event of allFailed) {
          current += event.gapMs;
          expect(store.plan(event.userId, event.errorClass).full).toBe(true);
        }
        expect(store.size).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it('应该保证已送达 ack 的抑制次数在同一窗口内单调递增', () => {
    fc.assert(
      fc.property(denseEventsArb, (events) => {
        let current = 0;
        const store = new ErrorDedupStore({ windowMs: WINDOW_MS, now: () => current });
        const lastSuppressed = new Map<string, number>();
        let comparisons = 0;
        for (const event of events) {
          current += event.gapMs;
          const decision = store.plan(event.userId, event.errorClass);
          const key = `${event.userId}\u0000${event.errorClass}`;
          // 未送达时不推进窗口，计数会重复，故单调性只对已送达的 ack 成立
          if (!event.delivered) continue;
          if (decision.full) {
            lastSuppressed.delete(key);
          } else {
            const previous = lastSuppressed.get(key);
            if (previous !== undefined) {
              expect(decision.suppressed).toBeGreaterThan(previous);
              comparisons += 1;
            }
            lastSuppressed.set(key, decision.suppressed);
          }
          store.commit(event.userId, event.errorClass, decision.full);
        }
        // 没有发生过任何比较时该属性是空转的，丢弃这次样本让 fast-check 重新生成
        fc.pre(comparisons >= 1);
      }),
      { numRuns: 300 },
    );
  });
});
