/**
 * 单向提醒：优先用 context_token 直接推送，窗口不可用时落队列等下次入站补发
 * @module notify
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadState, stateDir } from './config.js';
import { SESSION_EXPIRED_ERRCODE, sendText } from './weixin/client.js';
import { chunkText } from './bridge/reply.js';
import { log } from './log.js';

/** 待补发的提醒 */
export interface PendingNotice {
  id: string;
  toUserId: string;
  text: string;
  createdAt: number;
}

/** 提醒结果 */
export interface NotifyResult {
  status: 'sent' | 'queued' | 'error';
  message: string;
  sent: number;
  queued: number;
}

/**
 * 待发队列文件路径
 * @returns 绝对路径
 */
export function pendingFilePath(): string {
  return path.join(stateDir(), 'pending-notifications.jsonl');
}

/**
 * 统计待发队列条数
 * @returns 条数
 */
function pendingCount(): number {
  const file = pendingFilePath();
  if (!fs.existsSync(file)) return 0;
  try {
    return fs.readFileSync(file, 'utf-8').split('\n').filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * 追加到待发队列
 * @param items - 待发提醒
 * @param maxItems - 队列上限
 * @returns 入队与拒绝条数
 */
function appendPending(items: PendingNotice[], maxItems: number): { queued: number; rejected: number } {
  if (items.length === 0) return { queued: 0, rejected: 0 };
  const existing = pendingCount();
  if (existing + items.length > maxItems) {
    log.warn('待发提醒队列已满，拒绝新增', {
      existing,
      incoming: items.length,
      maxItems,
    });
    return { queued: 0, rejected: items.length };
  }
  fs.mkdirSync(stateDir(), { recursive: true });
  const lines = items.map((item) => JSON.stringify(item)).join('\n');
  fs.appendFileSync(pendingFilePath(), `${lines}\n`, { encoding: 'utf-8', mode: 0o600 });
  return { queued: items.length, rejected: 0 };
}

/**
 * 取出并清空待发队列
 * 先重命名再读取，避免与并发追加互相覆盖
 * @returns 待发提醒列表
 */
export function takePending(): PendingNotice[] {
  const file = pendingFilePath();
  if (!fs.existsSync(file)) return [];
  const processing = `${file}.processing-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(file, processing);
  } catch {
    return [];
  }
  try {
    const raw = fs.readFileSync(processing, 'utf-8');
    const items: PendingNotice[] = [];
    const ttlMs = loadConfig().outboxTtlMs;
    const now = Date.now();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as PendingNotice;
        if (!item.toUserId || !item.text) continue;
        if (typeof item.createdAt !== 'number' || now - item.createdAt > ttlMs) {
          log.warn('提醒已过期，已丢弃', {
            id: item.id,
            ageMs: typeof item.createdAt === 'number' ? now - item.createdAt : null,
          });
          continue;
        }
        items.push(item);
      } catch {
        // 跳过坏行
      }
    }
    return items;
  } finally {
    fs.rmSync(processing, { force: true });
  }
}

/**
 * 发送一条主动提醒
 * @param text - 提醒内容
 * @param toUserId - 目标用户，缺省为授权账号
 * @returns 发送结果
 */
export async function notify(text: string, toUserId?: string): Promise<NotifyResult> {
  const config = loadConfig();
  const state = loadState();
  const body = text.trim();
  if (!body) return { status: 'error', message: '提醒内容为空', sent: 0, queued: 0 };

  const target = (toUserId ?? config.ownerUserId).trim();
  if (!target) {
    return { status: 'error', message: '尚未设置授权账号，请先登录或配置 ownerUserId', sent: 0, queued: 0 };
  }
  if (target !== config.ownerUserId && !config.allowFrom.includes(target)) {
    return { status: 'error', message: '目标不在授权名单内，已拒绝', sent: 0, queued: 0 };
  }
  if (!config.token) {
    return { status: 'error', message: '尚未登录微信，请先执行 login', sent: 0, queued: 0 };
  }

  const chunks = chunkText(`【Qoder 提醒】${body}`, config.maxReplyChars).slice(0, config.maxRepliesPerTurn);
  const token = state.contextTokens[target] ?? '';

  /**
   * 把剩余片段放进队列
   * @param rest - 剩余片段
   * @param reason - 原因
   * @param sent - 已经成功发送的条数
   * @returns 结果
   */
  const queue = (rest: string[], reason: string, sent = 0): NotifyResult => {
    const now = Date.now();
    const items = rest.map((chunk, index) => ({
      id: `${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      toUserId: target,
      text: chunk,
      createdAt: now,
    }));
    const queued = appendPending(items, config.outboxMaxItems);
    if (queued.rejected > 0) {
      return {
        status: 'error',
        message: `待发提醒队列已满（上限 ${config.outboxMaxItems} 条），未入队。`,
        sent,
        queued: 0,
      };
    }
    log.warn('提醒未送达，已排队', { target, count: queued.queued, reason });
    return {
      status: 'queued',
      message: `未送达：${reason}\n已排队 ${queued.queued} 条，等你下次给机器人发消息时自动补发。`,
      sent,
      queued: queued.queued,
    };
  };

  if (!token) {
    return queue(chunks, '没有可用的 context_token（超过约 24h 窗口或你还没给机器人发过消息）');
  }

  let sent = 0;
  for (const chunk of chunks) {
    try {
      await sendText({ baseUrl: config.baseUrl, token: config.token, toUserId: target, text: chunk, contextToken: token });
      sent += 1;
    } catch (err) {
      const reason = String(err);
      const rest = chunks.slice(sent);
      if (reason.includes(String(SESSION_EXPIRED_ERRCODE))) {
        return queue(rest, '微信会话已过期（-14），需要重新登录', sent);
      }
      return queue(rest, `发送失败（${reason.slice(0, 120)}）`, sent);
    }
  }
  return { status: 'sent', message: `已推送 ${sent} 条提醒。`, sent, queued: 0 };
}
