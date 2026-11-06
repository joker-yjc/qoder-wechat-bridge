/**
 * 错误提示去重：窗口内同类错误只发一条完整提示，其余改发 ack
 * @module bridge/error-dedup
 */
import type { QoderErrorClass } from './error-class.js';

/** 单次去重决策 */
export interface ErrorDedupDecision {
  /** true 表示发完整提示，false 表示发 ack */
  full: boolean;
  /** 窗口内首次完整提示的时间；full 为 true 时等于本次时间 */
  firstAt: number;
  /** 含本次在内的累计抑制次数；full 为 true 时为 0 */
  suppressed: number;
}

/** 去重存储选项 */
export interface ErrorDedupOptions {
  /** 去重窗口时长（毫秒） */
  windowMs: number;
  /** 时钟，测试可注入 */
  now?: () => number;
}

/** 窗口内的单个条目 */
interface Entry {
  /** 首次完整提示时间 */
  firstAt: number;
  /** 已抑制次数，不含本次 */
  suppressed: number;
}

/** 键分隔符，避免 userId 自带分隔符时产生歧义 */
const KEY_SEPARATOR = '\u0000';

/**
 * 错误提示去重存储
 *
 * 内存态，进程重启即重置：窗口只有 10 分钟且失败全部由用户入站触发，
 * 重启后最坏结果是多发一条完整提示，失败方向安全（宁可多提示，不可静默吞掉）
 */
export class ErrorDedupStore {
  private readonly entries = new Map<string, Entry>();

  /** 归一化后的窗口时长；非法值退化为 0，即不去重——宁可多提示，不可永久只发 ack */
  private readonly windowMs: number;

  constructor(private readonly opts: ErrorDedupOptions) {
    this.windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : 0;
  }

  /** 当前未过期条目数；读取时会先清理已过期条目 */
  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  /**
   * 当前时间
   * @returns 毫秒时间戳
   */
  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * 拼接去重键
   * @param userId - 微信用户 id
   * @param errorClass - 语义类别
   * @returns 去重键
   */
  private key(userId: string, errorClass: QoderErrorClass): string {
    return `${userId}${KEY_SEPARATOR}${errorClass}`;
  }

  /** 删除已过期的条目，使 Map 保持有界 */
  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      // 时钟回拨时差值为负，条目被保留，窗口自然延长而不会误判过期
      if (now - entry.firstAt >= this.windowMs) this.entries.delete(key);
    }
  }

  /**
   * 只读决策：判断本次该发完整提示还是 ack，不修改状态
   * @param userId - 微信用户 id
   * @param errorClass - 语义类别
   * @returns 决策结果
   */
  plan(userId: string, errorClass: QoderErrorClass): ErrorDedupDecision {
    this.pruneExpired();
    const entry = this.entries.get(this.key(userId, errorClass));
    if (!entry) return { full: true, firstAt: this.now(), suppressed: 0 };
    return { full: false, firstAt: entry.firstAt, suppressed: entry.suppressed + 1 };
  }

  /**
   * 提交决策，仅在消息真正送达后调用
   *
   * 发送失败时不调用本方法，窗口不推进，下一次同类失败仍尝试完整提示
   * @param userId - 微信用户 id
   * @param errorClass - 语义类别
   * @param full - 本次发的是完整提示还是 ack
   */
  commit(userId: string, errorClass: QoderErrorClass, full: boolean): void {
    const key = this.key(userId, errorClass);
    if (full) {
      this.entries.set(key, { firstAt: this.now(), suppressed: 0 });
      return;
    }
    // pruneExpired 是全表遍历：其他用户的 plan 可能在本次 await 发送期间删掉本键。
    // 条目已消失时不重建——用户收到的 ack 引用的是旧的首次提示时间，
    // 若按 now 重建会让后续 ack 指向一次从未发生过的完整提示；留空则下次重新发完整提示，方向安全。
    const entry = this.entries.get(key);
    if (entry) entry.suppressed += 1;
  }
}
