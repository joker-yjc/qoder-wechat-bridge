/**
 * 出站会话：统一处理预算、额度耗尽、失败分类与分片入队
 * @module bridge/outbound
 */
import type { OutboxItem, OutboxItemKind, State } from '../config.js';
import { log } from '../log.js';
import { classifySendError, type SendFailureKind } from '../weixin/errors.js';
import { pushOutbox, type OutboxPolicy } from './outbox.js';
import { chunkText } from './reply.js';

/** 发送函数返回值 */
export interface OutboundSendResult {
  messageId?: string;
}

/** 发送函数 */
export type OutboundSend = (text: string) => Promise<OutboundSendResult>;

/** 入队选项 */
export interface EnqueueOptions {
  kind: OutboxItemKind;
  taskId?: string;
  failures?: number;
  transientFailures?: number;
  lastErrorKind?: SendFailureKind;
}

/** 出站会话选项 */
export interface OutboundSessionOptions {
  state: State;
  toUserId: string;
  policy: OutboxPolicy;
  maxChars: number;
  budget: number;
  send: OutboundSend;
  now?: () => number;
}

/** 单条发送结果 */
export type SendSingleOutcome = 'sent' | 'queued' | 'skipped';

/**
 * 出站会话
 */
export class OutboundSession {
  budget: number;
  quotaExhausted = false;
  sessionExpired = false;
  sentCount = 0;

  constructor(private readonly opts: OutboundSessionOptions) {
    this.budget = opts.budget;
  }

  /**
   * 当前时间
   * @returns 毫秒时间戳
   */
  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * 记录成功发送
   * @param text - 正文
   * @param kind - 消息类别
   * @param taskId - 任务 id
   * @param messageId - 服务端消息 id
   */
  private logSent(text: string, kind: OutboxItemKind, taskId: string | undefined, messageId?: string): void {
    log.info('出站消息', {
      category: 'sent',
      kind,
      taskId: taskId ?? '',
      messageId: messageId ?? '',
      chars: text.length,
      bytes: Buffer.byteLength(text, 'utf8'),
    });
  }

  /**
   * 记录失败
   * @param failure - 分类后的失败
   * @param kind - 消息类别
   * @param taskId - 任务 id
   * @param text - 正文
   */
  private logFailure(
    failure: ReturnType<typeof classifySendError>,
    kind: OutboxItemKind,
    taskId: string | undefined,
    text: string,
  ): void {
    log.warn('出站失败', {
      category: failure.kind,
      kind,
      taskId: taskId ?? '',
      chars: text.length,
      bytes: Buffer.byteLength(text, 'utf8'),
      reason: failure.message.slice(0, 120),
    });
  }

  /**
   * 把消息写入 outbox
   * @param text - 正文
   * @param options - 入队选项
   * @returns 被丢弃的最旧消息
   */
  enqueue(text: string, options: EnqueueOptions): OutboxItem[] {
    const now = this.now();
    const item: OutboxItem = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      toUserId: this.opts.toUserId,
      text,
      kind: options.kind,
      createdAt: now,
      bytes: Buffer.byteLength(text, 'utf8'),
      failures: options.failures ?? 0,
      transientFailures: options.transientFailures ?? 0,
      lastErrorKind: options.lastErrorKind,
      lastErrorAt: options.lastErrorKind ? now : undefined,
      taskId: options.taskId,
    };
    const { dropped } = pushOutbox(this.opts.state, item, this.opts.policy);
    if (dropped.length > 0) {
      log.warn('outbox 超限，已丢弃最旧消息', {
        count: dropped.length,
        ids: dropped.map((message) => message.id),
      });
    }
    return dropped;
  }

  /**
   * 发送一条原文，不经过分片
   * @param text - 正文
   * @param options - 类别、是否在失败时入队、任务 id
   * @returns 发送结果
   */
  async sendSingle(
    text: string,
    options: { kind: OutboxItemKind; queueOnFailure: boolean; taskId?: string },
  ): Promise<SendSingleOutcome> {
    const body = text.trim();
    if (!body) return 'skipped';

    if (this.quotaExhausted || this.sessionExpired || this.budget <= 0) {
      if (!options.queueOnFailure) return 'skipped';
      this.enqueue(body, { kind: options.kind, taskId: options.taskId });
      return 'queued';
    }

    try {
      const result = await this.opts.send(body);
      this.budget -= 1;
      this.sentCount += 1;
      this.logSent(body, options.kind, options.taskId, result.messageId);
      return 'sent';
    } catch (err) {
      const failure = classifySendError(err);
      if (failure.kind === 'quota') this.quotaExhausted = true;
      if (failure.kind === 'session_expired') this.sessionExpired = true;
      this.logFailure(failure, options.kind, options.taskId, body);
      if (!options.queueOnFailure) return 'skipped';
      this.enqueue(body, {
        kind: options.kind,
        taskId: options.taskId,
        failures: failure.kind === 'permanent' || failure.kind === 'unknown' ? 1 : 0,
        transientFailures: failure.kind === 'transient' ? 1 : 0,
        lastErrorKind: failure.kind,
      });
      return 'queued';
    }
  }

  /**
   * 按现有字符分片发送正常回复
   * @param text - 正文
   * @param options - 类别与任务 id
   * @returns 已发送与已入队条数
   */
  async sendChunked(
    text: string,
    options: { kind: OutboxItemKind; taskId?: string },
  ): Promise<{ sent: number; queued: number }> {
    const chunks = chunkText(text, this.opts.maxChars);
    let sent = 0;
    let queued = 0;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      if (this.quotaExhausted || this.sessionExpired || this.budget <= 0) {
        for (const rest of chunks.slice(index)) {
          this.enqueue(rest, { kind: options.kind, taskId: options.taskId });
          queued += 1;
        }
        break;
      }

      try {
        const result = await this.opts.send(chunk);
        this.budget -= 1;
        this.sentCount += 1;
        sent += 1;
        this.logSent(chunk, options.kind, options.taskId, result.messageId);
      } catch (err) {
        const failure = classifySendError(err);
        if (failure.kind === 'quota') this.quotaExhausted = true;
        if (failure.kind === 'session_expired') this.sessionExpired = true;
        this.logFailure(failure, options.kind, options.taskId, chunk);
        const rest = chunks.slice(index);
        for (let offset = 0; offset < rest.length; offset += 1) {
          this.enqueue(rest[offset]!, {
            kind: options.kind,
            taskId: options.taskId,
            failures:
              offset === 0 && (failure.kind === 'permanent' || failure.kind === 'unknown') ? 1 : 0,
            transientFailures: offset === 0 && failure.kind === 'transient' ? 1 : 0,
            lastErrorKind: offset === 0 ? failure.kind : undefined,
          });
          queued += 1;
        }
        break;
      }
    }

    return { sent, queued };
  }
}
