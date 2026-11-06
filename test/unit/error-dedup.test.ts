import { describe, expect, it } from 'vitest';
import { ErrorDedupStore } from '../../src/bridge/error-dedup.js';

const WINDOW_MS = 600_000;
const USER = 'user-a';

/**
 * 建一个由测试驱动时钟的去重存储
 * @param start - 起始时间
 * @returns 存储与推进时钟的函数
 */
function setup(start = 0) {
  let current = start;
  const store = new ErrorDedupStore({ windowMs: WINDOW_MS, now: () => current });
  return { store, at: (value: number) => (current = value), tick: (delta: number) => (current += delta) };
}

describe('错误提示去重窗口', () => {
  it('应该在首次失败时要求发完整提示', () => {
    const { store } = setup();
    expect(store.plan(USER, 'model_quota')).toEqual({ full: true, firstAt: 0, suppressed: 0 });
  });

  it('应该在窗口内的第二次同类失败时要求发 ack', () => {
    const { store, tick } = setup();
    store.commit(USER, 'model_quota', true);
    tick(60_000);
    expect(store.plan(USER, 'model_quota')).toEqual({ full: false, firstAt: 0, suppressed: 1 });
  });

  it('应该让 ack 的抑制次数含本次并逐次递增', () => {
    const { store, tick } = setup();
    store.commit(USER, 'model_quota', true);
    for (const expected of [1, 2, 3, 4]) {
      tick(1_000);
      const decision = store.plan(USER, 'model_quota');
      expect(decision.suppressed).toBe(expected);
      store.commit(USER, 'model_quota', false);
    }
  });

  it('应该让 ack 携带窗口内首次提示的时间', () => {
    const { store, at } = setup(1_700_000_000_000);
    store.commit(USER, 'model_quota', true);
    at(1_700_000_300_000);
    expect(store.plan(USER, 'model_quota').firstAt).toBe(1_700_000_000_000);
  });

  it('应该在只 plan 不 commit 时保持状态不变', () => {
    const { store } = setup();
    expect(store.plan(USER, 'model_quota')).toEqual(store.plan(USER, 'model_quota'));
    expect(store.size).toBe(0);
  });

  it('应该在窗口过期后重新要求完整提示并把计数归零', () => {
    const { store, tick } = setup();
    store.commit(USER, 'model_quota', true);
    tick(60_000);
    store.commit(USER, 'model_quota', false);
    tick(WINDOW_MS);
    expect(store.plan(USER, 'model_quota')).toEqual({ full: true, firstAt: 60_000 + WINDOW_MS, suppressed: 0 });
  });

  it('应该在恰好到达窗口时长时视为已过期', () => {
    const { store, tick } = setup();
    store.commit(USER, 'model_quota', true);
    tick(WINDOW_MS - 1);
    expect(store.plan(USER, 'model_quota').full).toBe(false);
    tick(1);
    expect(store.plan(USER, 'model_quota').full).toBe(true);
  });

  it('应该让不同类别各自独立计数互不抑制', () => {
    const { store } = setup();
    store.commit(USER, 'model_quota', true);
    expect(store.plan(USER, 'output_limit').full).toBe(true);
    expect(store.plan(USER, 'auth').full).toBe(true);
    expect(store.plan(USER, 'model_quota').full).toBe(false);
  });

  it('应该让不同用户各自独立计数互不抑制', () => {
    const { store } = setup();
    store.commit(USER, 'model_quota', true);
    expect(store.plan('user-b', 'model_quota').full).toBe(true);
  });

  it('应该在 userId 含分隔符时不产生键歧义', () => {
    const { store } = setup();
    store.commit('user-a\u0000model_quota', 'auth', true);
    expect(store.plan(USER, 'model_quota').full).toBe(true);
  });

  it('应该让 size 只统计未过期条目', () => {
    const { store, tick } = setup();
    store.commit(USER, 'model_quota', true);
    store.commit(USER, 'output_limit', true);
    expect(store.size).toBe(2);
    tick(WINDOW_MS);
    store.plan(USER, 'auth');
    expect(store.size).toBe(0);
  });

  it('应该在时钟回拨时延长窗口而不抛异常', () => {
    const { store, at } = setup(10_000);
    store.commit(USER, 'model_quota', true);
    at(5_000);
    expect(() => store.plan(USER, 'model_quota')).not.toThrow();
    expect(store.plan(USER, 'model_quota').full).toBe(false);
  });

  it('应该在时钟大幅前跳时立即过期并重新发完整提示', () => {
    const { store, at } = setup(0);
    store.commit(USER, 'model_quota', true);
    at(10 * WINDOW_MS);
    expect(store.plan(USER, 'model_quota').full).toBe(true);
  });

  it('应该在缺少注入时钟时回落到系统时间', () => {
    const store = new ErrorDedupStore({ windowMs: WINDOW_MS });
    const before = Date.now();
    const decision = store.plan(USER, 'unknown');
    expect(decision.full).toBe(true);
    expect(decision.firstAt).toBeGreaterThanOrEqual(before);
    expect(decision.firstAt).toBeLessThanOrEqual(Date.now());
  });

  it('应该在别的用户触发全局清理删掉本键后仍安全提交', () => {
    const { store, at } = setup(0);
    store.commit(USER, 'model_quota', true);
    at(WINDOW_MS - 1);
    // A 拿到 ack 决策，此时条目尚未过期
    const decision = store.plan(USER, 'model_quota');
    expect(decision.full).toBe(false);
    // 发送期间时间越过窗口边界，另一个用户的 plan 触发全表清理，删掉了 A 的条目
    at(WINDOW_MS);
    store.plan('user-b', 'auth');
    expect(store.size).toBe(0);

    expect(() => store.commit(USER, 'model_quota', decision.full)).not.toThrow();
    // 兜底后不应把 A 错误地记成"窗口内已提示过"
    expect(store.plan(USER, 'model_quota').full).toBe(true);
  });

  it('应该在窗口时长非法时退化为不去重而不是永久抑制', () => {
    for (const windowMs of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) {
      const store = new ErrorDedupStore({ windowMs, now: () => 0 });
      store.commit(USER, 'model_quota', true);
      expect(store.plan(USER, 'model_quota').full).toBe(true);
      expect(store.size).toBe(0);
    }
  });
});
