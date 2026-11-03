/**
 * 出站补发队列状态机：根据发送结果决定删除、保留、跳过或隔离
 * @module bridge/outbox
 */
import type { OutboxItem, QuarantineItem, State } from '../config.js';
import type { SendFailureKind } from '../weixin/errors.js';

/** 单条消息的发送结果 */
export type DeliveryOutcome =
  | { kind: 'sent'; messageId?: string }
  | { kind: 'quota' }
  | { kind: 'session_expired' }
  | { kind: 'transient'; reason: string }
  | { kind: 'permanent'; reason: string }
  | { kind: 'unknown'; reason: string };

/** 队列策略 */
export interface OutboxPolicy {
  maxItems: number;
  ttlMs: number;
  poisonMaxAttempts: number;
  transientMaxAttempts: number;
  quarantineMaxItems: number;
  quarantineTtlMs: number;
  now: () => number;
  /** 生成隔离预览前的脱敏函数 */
  redact?: (text: string) => string;
}

/** 一轮补发的结果 */
export interface FlushResult {
  /** 未发送 / 未处理的消息，保持原顺序 */
  remaining: OutboxItem[];
  /** 本轮新隔离的消息 */
  quarantined: QuarantineItem[];
  sent: number;
  budgetLeft: number;
  stopReason: 'done' | 'budget' | 'quota' | 'session_expired' | 'transient';
}

/** 清理结果 */
export interface PruneResult {
  expired: OutboxItem[];
  dropped: OutboxItem[];
  quarantineExpired: QuarantineItem[];
  quarantineDropped: QuarantineItem[];
}

/**
 * 把消息转换为隔离项
 * @param item - 原始消息
 * @param reason - 隔离原因
 * @param policy - 队列策略
 * @returns 隔离项
 */
function toQuarantine(item: OutboxItem, reason: string, policy: OutboxPolicy): QuarantineItem {
  const redact = policy.redact ?? ((text: string): string => text);
  return {
    ...item,
    quarantinedAt: policy.now(),
    reason,
    preview: redact(item.text).slice(0, 120),
  };
}

/**
 * 按顺序补发消息
 * @param input - 消息快照、预算、策略与发送函数
 * @returns 本轮结果
 */
export async function flushOutbox(input: {
  items: OutboxItem[];
  budget: number;
  policy: OutboxPolicy;
  send: (item: OutboxItem) => Promise<DeliveryOutcome>;
}): Promise<FlushResult> {
  const { items, policy, send } = input;
  const keep = new Array<boolean>(items.length).fill(true);
  const quarantined: QuarantineItem[] = [];
  let budget = input.budget;
  let sent = 0;
  let stopReason: FlushResult['stopReason'] = 'done';

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    if (budget <= 0) {
      stopReason = 'budget';
      break;
    }

    let outcome: DeliveryOutcome;
    try {
      outcome = await send(item);
    } catch (err) {
      outcome = { kind: 'unknown', reason: String(err) };
    }

    if (outcome.kind === 'sent') {
      keep[index] = false;
      sent += 1;
      budget -= 1;
      continue;
    }

    if (outcome.kind === 'quota') {
      stopReason = 'quota';
      break;
    }

    if (outcome.kind === 'session_expired') {
      stopReason = 'session_expired';
      break;
    }

    if (outcome.kind === 'transient') {
      item.transientFailures += 1;
      item.lastErrorKind = 'transient' satisfies SendFailureKind;
      item.lastErrorAt = policy.now();
      if (item.transientFailures >= policy.transientMaxAttempts) {
        keep[index] = false;
        quarantined.push(toQuarantine(item, 'transient', policy));
        continue;
      }
      stopReason = 'transient';
      break;
    }

    // permanent / unknown：未达阈值时跳过，继续尝试后续消息
    item.failures += 1;
    item.lastErrorKind = outcome.kind;
    item.lastErrorAt = policy.now();
    if (item.failures >= policy.poisonMaxAttempts) {
      keep[index] = false;
      quarantined.push(toQuarantine(item, outcome.kind, policy));
    }
  }

  return {
    remaining: items.filter((_, index) => keep[index]),
    quarantined,
    sent,
    budgetLeft: budget,
    stopReason,
  };
}

/**
 * 入队并在超限时丢弃最旧消息
 * @param state - 运行状态
 * @param item - 要入队的消息
 * @param policy - 队列策略
 * @returns 被丢弃的消息
 */
export function pushOutbox(state: State, item: OutboxItem, policy: OutboxPolicy): { dropped: OutboxItem[] } {
  state.outbox.push(item);
  const dropped: OutboxItem[] = [];
  const maxItems = Math.max(0, policy.maxItems);
  const excess = state.outbox.length - maxItems;
  for (let droppedCount = 0; droppedCount < excess; droppedCount += 1) {
    let oldestIndex = 0;
    for (let index = 1; index < state.outbox.length; index += 1) {
      const current = state.outbox[index]!;
      const oldest = state.outbox[oldestIndex]!;
      if (current.createdAt < oldest.createdAt) oldestIndex = index;
    }
    dropped.push(state.outbox.splice(oldestIndex, 1)[0]!);
  }
  return { dropped };
}

/**
 * 删除 outbox 与隔离区中的过期 / 超限消息
 * @param state - 运行状态
 * @param policy - 队列策略
 * @returns 被删除的消息
 */
export function pruneOutbox(state: State, policy: OutboxPolicy): PruneResult {
  const now = policy.now();
  const expired = state.outbox.filter((item) => now - item.createdAt > policy.ttlMs);
  state.outbox = state.outbox.filter((item) => now - item.createdAt <= policy.ttlMs);

  const maxItems = Math.max(0, policy.maxItems);
  const dropped =
    state.outbox.length > maxItems ? state.outbox.splice(0, state.outbox.length - maxItems) : [];

  const quarantineExpired = state.quarantine.filter((item) => now - item.quarantinedAt > policy.quarantineTtlMs);
  state.quarantine = state.quarantine.filter((item) => now - item.quarantinedAt <= policy.quarantineTtlMs);

  const quarantineMax = Math.max(0, policy.quarantineMaxItems);
  const quarantineDropped =
    state.quarantine.length > quarantineMax
      ? state.quarantine.splice(0, state.quarantine.length - quarantineMax)
      : [];

  return { expired, dropped, quarantineExpired, quarantineDropped };
}

/**
 * 把消息移入隔离区
 * @param state - 运行状态
 * @param item - 要隔离的消息
 * @param reason - 隔离原因
 * @param policy - 队列策略
 * @returns 隔离项
 */
export function quarantineItem(
  state: State,
  item: OutboxItem,
  reason: string,
  policy: OutboxPolicy,
): QuarantineItem {
  state.outbox = state.outbox.filter((outboxItem) => outboxItem.id !== item.id);
  const quarantined = toQuarantine(item, reason, policy);
  state.quarantine.push(quarantined);
  const maxItems = Math.max(0, policy.quarantineMaxItems);
  if (state.quarantine.length > maxItems) state.quarantine.splice(0, state.quarantine.length - maxItems);
  return quarantined;
}
