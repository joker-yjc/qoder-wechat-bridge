/**
 * 桥接服务编排：收消息 → 授权 → 串行队列 → Qoder → 分片回传
 * @module bridge/service
 */
import {
  clearRunInfo,
  ensureDirs,
  loadConfig,
  loadState,
  saveConfig,
  saveState,
  writeRunInfo,
  type Config,
  type OutboxItem,
  type OutboxItemKind,
  type State,
} from '../config.js';
import os from 'node:os';
import { log } from '../log.js';
import { listModels, resolveModel, formatModelList } from '../models.js';
import { formatHelp, isUnknownCommand } from '../commands.js';
import { login } from '../weixin/login.js';
import {
  extractText,
  getTypingTicket,
  getUpdates,
  notifyClient,
  sendText,
  sendTyping,
  SESSION_EXPIRED_ERRCODE,
} from '../weixin/client.js';
import { classifySendError } from '../weixin/errors.js';
import { MessageItemType, MessageType, TypingStatus, type MessageItem, type WeixinMessage } from '../weixin/types.js';
import { downloadItemMedia, pruneInbox, type SavedMedia } from '../weixin/media.js';
import { runQoder } from './qoder.js';
import { flushOutbox, pruneOutbox, pushOutbox, type DeliveryOutcome, type OutboxPolicy } from './outbox.js';
import { OutboundSession } from './outbound.js';
import { buildAckText, buildUserErrorReply } from './failure.js';
import { ErrorDedupStore } from './error-dedup.js';
import { redactSensitive, pruneDiagnostics } from '../diagnostics.js';
import { detectNodeChange, nodeFingerprint, runPreflight, type PreflightResult } from './preflight.js';
import { takePending } from '../notify.js';
import { loadPersona } from '../persona.js';

/** 桥接服务句柄 */
export interface BridgeHandle {
  /** 停止服务 */
  stop: () => void;
  /** 当前生效配置 */
  config: Config;
}

/** 可注入依赖，便于单测 */
export interface ServiceDeps {
  sendText?: typeof sendText;
  runQoder?: typeof runQoder;
  takePending?: typeof takePending;
  loadPersona?: typeof loadPersona;
  listModels?: typeof listModels;
  getTypingTicket?: typeof getTypingTicket;
  sendTyping?: typeof sendTyping;
  downloadItemMedia?: typeof downloadItemMedia;
  runPreflight?: typeof runPreflight;
  pruneDiagnostics?: typeof pruneDiagnostics;
  pruneInbox?: typeof pruneInbox;
  login?: typeof login;
  notifyClient?: typeof notifyClient;
  getUpdates?: typeof getUpdates;
  writeRunInfo?: typeof writeRunInfo;
  clearRunInfo?: typeof clearRunInfo;
  nodeFingerprint?: typeof nodeFingerprint;
  now?: () => number;
  onSessionExpired?: () => void;
}

/** 桥接运行时 */
export interface BridgeRuntime {
  handleInbound: (msg: WeixinMessage) => Promise<void>;
  processTask: (
    userId: string,
    text: string,
    contextToken: string,
    attachments?: string[],
    taskId?: string,
  ) => Promise<void>;
  cancelAllTasks: () => void;
  waitForIdle: () => Promise<void>;
  prune: () => void;
  getConfig: () => Config;
  getState: () => State;
}

/**
 * 描述一个媒体项，用于失败提示
 * @param item - 消息项
 * @returns 描述文本
 */
function describeItem(item: MessageItem): string {
  if (item.type === MessageItemType.IMAGE) return '图片';
  if (item.type === MessageItemType.VIDEO) return '视频';
  if (item.type === MessageItemType.VOICE) return '语音';
  if (item.type === MessageItemType.FILE) return `文件「${item.file_item?.file_name ?? '未命名'}」`;
  return '附件';
}

/**
 * 把文本与附件说明拼成给 Qoder 的任务描述
 * @param text - 用户文本
 * @param media - 已下载附件
 * @param failures - 下载失败的附件
 * @returns 最终 prompt
 */
function buildPrompt(text: string, media: SavedMedia[], failures: string[]): string {
  const notes: string[] = [];
  if (media.length > 0) {
    const list = media.map((m) => `- ${m.name}（${m.kind}，${Math.round(m.bytes / 1024)}KB）`).join('\n');
    notes.push(`用户发来 ${media.length} 个附件，已作为附件提供：\n${list}`);
  }
  if (failures.length > 0) {
    notes.push(`部分附件无法读取：${failures.join('；')}`);
  }
  return [text, ...notes].filter(Boolean).join('\n\n').trim();
}

/**
 * 构造一个 outbox 消息
 * @param input - 消息字段
 * @returns outbox 消息
 */
function makeOutboxItem(input: {
  id: string;
  toUserId: string;
  text: string;
  kind: OutboxItemKind;
  createdAt: number;
  failures?: number;
}): OutboxItem {
  return {
    ...input,
    bytes: Buffer.byteLength(input.text, 'utf8'),
    failures: input.failures ?? 0,
    transientFailures: 0,
  };
}

/**
 * 生成任务 id
 * @param now - 当前时间
 * @returns 任务 id
 */
function makeTaskId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把发送异常转换为补发队列结果
 * @param err - 原始异常
 * @returns 补发队列结果
 */
function toDeliveryOutcome(err: unknown): DeliveryOutcome {
  const failure = classifySendError(err);
  switch (failure.kind) {
    case 'quota':
      return { kind: 'quota' };
    case 'session_expired':
      return { kind: 'session_expired' };
    case 'transient':
      return { kind: 'transient', reason: failure.message };
    case 'permanent':
      return { kind: 'permanent', reason: failure.message };
    default:
      return { kind: 'unknown', reason: failure.message };
  }
}

/**
 * 创建桥接运行时
 * @param initialConfig - 初始配置
 * @param state - 运行状态
 * @param deps - 可注入依赖
 * @returns 运行时
 */
export function createBridgeRuntime(initialConfig: Config, state: State, deps: ServiceDeps = {}): BridgeRuntime {
  let config = initialConfig;
  const sendTextFn = deps.sendText ?? sendText;
  const runQoderFn = deps.runQoder ?? runQoder;
  const takePendingFn = deps.takePending ?? takePending;
  const loadPersonaFn = deps.loadPersona ?? loadPersona;
  const listModelsFn = deps.listModels ?? listModels;
  const getTypingTicketFn = deps.getTypingTicket ?? getTypingTicket;
  const sendTypingFn = deps.sendTyping ?? sendTyping;
  const downloadMediaFn = deps.downloadItemMedia ?? downloadItemMedia;
  const nodeFingerprintFn = deps.nodeFingerprint ?? nodeFingerprint;
  const now = deps.now ?? ((): number => Date.now());
  /** 错误提示去重：内存态，重启即重置（最坏是多发一条完整提示，失败方向安全） */
  const errorDedup = new ErrorDedupStore({ windowMs: config.errorDedupWindowMs, now });
  let nodeSnapshot = nodeFingerprintFn();
  /** 每个微信用户一条串行队列，避免同一会话并发 */
  const queues = new Map<string, Promise<void>>();
  /** 每个用户当前正在执行的任务句柄，用于 /stop 强制停止 */
  const runningTasks = new Map<string, { cancel: () => void; cancelled: boolean }>();

  /**
   * 当前队列策略
   * @returns 队列策略
   */
  const outboxPolicy = (): OutboxPolicy => ({
    maxItems: config.outboxMaxItems,
    ttlMs: config.outboxTtlMs,
    poisonMaxAttempts: config.poisonMaxAttempts,
    transientMaxAttempts: config.transientMaxAttempts,
    quarantineMaxItems: config.quarantineMaxItems,
    quarantineTtlMs: config.quarantineTtlMs,
    now,
    redact: redactSensitive,
  });

  /** 持久化状态 */
  const persistState = (): void => {
    try {
      saveState(state);
    } catch (err) {
      log.error('保存状态失败', { error: String(err) });
    }
  };

  /**
   * 判断发送者是否被授权
   * @param userId - 发送者 ilink user id
   * @returns 是否允许驱动 Qoder
   */
  const isAllowed = (userId: string): boolean =>
    (config.ownerUserId !== '' && userId === config.ownerUserId) || config.allowFrom.includes(userId);

  /**
   * 把任务挂到该用户的串行队列
   * @param userId - 微信用户
   * @param task - 要执行的任务
   */
  const enqueue = (userId: string, task: () => Promise<void>): void => {
    const prev = queues.get(userId) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch((err) => log.error('任务执行异常', { userId, error: String(err) }))
      .finally(() => {
        if (queues.get(userId) === next) queues.delete(userId);
      });
    queues.set(userId, next);
  };

  /**
   * 直接发送一条控制类消息（不进入 outbox）
   * @param userId - 目标用户
   * @param contextToken - 上下文令牌
   * @param text - 正文
   * @returns 是否发送成功
   */
  const sendControl = async (userId: string, contextToken: string, text: string): Promise<boolean> => {
    try {
      await sendTextFn({ baseUrl: config.baseUrl, token: config.token, toUserId: userId, text, contextToken });
      return true;
    } catch (err) {
      const failure = classifySendError(err);
      log.warn('控制消息发送失败', {
        category: failure.kind,
        toUserId: userId,
        chars: text.length,
        reason: failure.message.slice(0, 120),
      });
      if (failure.kind === 'session_expired') deps.onSessionExpired?.();
      return false;
    }
  };

  /**
   * 补发 CLI 侧暂存的主动提醒
   * @param userId - 当前入站用户
   */
  const ingestPending = (userId: string): void => {
    const pending = takePendingFn();
    if (pending.length === 0) return;
    log.info('补发主动提醒', { count: pending.length, userId });
    for (const item of pending) {
      const outboxItem = makeOutboxItem({
        id: item.id,
        toUserId: item.toUserId,
        text: item.text,
        kind: 'notice',
        createdAt: item.createdAt,
      });
      const { dropped } = pushOutbox(state, outboxItem, outboxPolicy());
      if (dropped.length > 0) {
        log.warn('outbox 超限，已丢弃最旧消息', {
          count: dropped.length,
          ids: dropped.map((message) => message.id),
        });
      }
    }
    state.outbox.sort((left, right) => left.createdAt - right.createdAt);
    persistState();
  };

  /** 清理过期 / 超限消息 */
  const prune = (): void => {
    const result = pruneOutbox(state, outboxPolicy());
    if (result.expired.length > 0) {
      log.warn('outbox 消息已过期', {
        count: result.expired.length,
        ids: result.expired.map((item) => item.id),
      });
    }
    if (result.dropped.length > 0) {
      log.warn('outbox 超限，已丢弃最旧消息', {
        count: result.dropped.length,
        ids: result.dropped.map((item) => item.id),
      });
    }
    if (result.quarantineExpired.length > 0 || result.quarantineDropped.length > 0) {
      log.warn('隔离区已清理', {
        expired: result.quarantineExpired.length,
        dropped: result.quarantineDropped.length,
      });
    }
    if (
      result.expired.length > 0 ||
      result.dropped.length > 0 ||
      result.quarantineExpired.length > 0 ||
      result.quarantineDropped.length > 0
    ) {
      persistState();
    }
  };

  /**
   * 补发某个用户的 outbox
   * @param userId - 微信用户
   * @param contextToken - 本次入站的上下文令牌
   * @param budget - 本轮剩余额度
   * @returns 补发结果与剩余额度
   */
  const flushForUser = async (
    userId: string,
    contextToken: string,
    budget: number,
  ): Promise<{ budgetLeft: number; stopReason: string; sent: number }> => {
    const items = state.outbox
      .filter((item) => item.toUserId === userId)
      .sort((left, right) => left.createdAt - right.createdAt);
    if (items.length === 0) return { budgetLeft: budget, stopReason: 'done', sent: 0 };

    const result = await flushOutbox({
      items,
      budget,
      policy: outboxPolicy(),
      send: async (item) => {
        try {
          const response = await sendTextFn({
            baseUrl: config.baseUrl,
            token: config.token,
            toUserId: userId,
            text: item.text,
            contextToken,
          });
          log.info('出站消息', {
            category: 'sent',
            kind: item.kind,
            taskId: item.taskId ?? '',
            messageId: response.message_id ?? '',
            chars: item.text.length,
            bytes: item.bytes,
            attempts: item.failures + item.transientFailures,
          });
          return { kind: 'sent', messageId: response.message_id };
        } catch (err) {
          return toDeliveryOutcome(err);
        }
      },
    });

    const remainingIds = new Set(result.remaining.map((item) => item.id));
    state.outbox = state.outbox.filter((item) => item.toUserId !== userId || remainingIds.has(item.id));

    if (result.quarantined.length > 0) {
      state.quarantine.push(...result.quarantined);
      const maxQuarantine = Math.max(0, config.quarantineMaxItems);
      if (state.quarantine.length > maxQuarantine) {
        state.quarantine.splice(0, state.quarantine.length - maxQuarantine);
      }
      for (const item of result.quarantined) {
        log.warn('消息已隔离', {
          messageId: item.id,
          taskId: item.taskId ?? '',
          reason: item.reason,
          failures: item.failures,
          preview: item.preview,
        });
      }
    }

    if (result.stopReason === 'quota') {
      state.quota.streak += 1;
      state.quota.lastAt = now();
      log.warn('下行额度耗尽', {
        streak: state.quota.streak,
        remaining: result.remaining.length,
      });
    } else if (result.sent > 0) {
      state.quota.streak = 0;
    }

    if (result.stopReason === 'session_expired') {
      log.error('微信会话过期（-14），停止循环，请重新执行 login');
      deps.onSessionExpired?.();
    }

    persistState();
    return { budgetLeft: result.budgetLeft, stopReason: result.stopReason, sent: result.sent };
  };

  /**
   * 处理一条任务：补发欠账 → 调 Qoder → 回传
   * @param userId - 微信用户
   * @param text - 任务文本
   * @param contextToken - 本次入站的上下文令牌
   * @param attachments - 附件路径
   * @param taskId - 可选任务 id
   */
  const processTask = async (
    userId: string,
    text: string,
    contextToken: string,
    attachments: string[] = [],
    taskId?: string,
  ): Promise<void> => {
    const id = taskId ?? makeTaskId(now());
    const session = new OutboundSession({
      state,
      toUserId: userId,
      policy: outboxPolicy(),
      maxChars: config.maxReplyChars,
      budget: config.maxRepliesPerTurn,
      send: async (body) => {
        const response = await sendTextFn({
          baseUrl: config.baseUrl,
          token: config.token,
          toUserId: userId,
          text: body,
          contextToken,
        });
        return { messageId: response.message_id };
      },
      now,
    });
    const typing = new TypingKeeper(userId, contextToken);
    await typing.start();
    try {
      ingestPending(userId);
      prune();

      const flushed = await flushForUser(userId, contextToken, session.budget);
      session.budget = flushed.budgetLeft;
      if (flushed.stopReason === 'quota') session.quotaExhausted = true;
      if (flushed.stopReason === 'session_expired') session.sessionExpired = true;

      // 内置命令
      const command = text.trim();
      if (command === '/help') {
        await session.sendSingle(formatHelp(), { kind: 'notice', queueOnFailure: true });
        return;
      }
      if (command === '/reset') {
        delete state.sessions[userId];
        persistState();
        await session.sendSingle('会话已重置，下一条消息将开启新的 Qoder 会话。', {
          kind: 'notice',
          queueOnFailure: true,
        });
        return;
      }
      if (command === '/status') {
        const record = state.sessions[userId];
        const lines = [
          `工作目录：${workdir()}${config.cwd.trim() ? '' : '（全局）'}`,
          `模型：${state.models[userId] ?? config.qoderModel ?? 'Auto（默认）'}`,
          `Qoder 会话：${record ? record.sessionId : '（尚未创建）'}`,
          `累计轮次：${record?.turns ?? 0}`,
          `待补发：${state.outbox.filter((item) => item.toUserId === userId).length} 条`,
          `隔离区：${state.quarantine.length} 条`,
          `下行额度：${state.quota.streak > 0 ? `连续 ${state.quota.streak} 个窗口耗尽` : '正常'}`,
        ];
        await session.sendSingle(lines.join('\n'), { kind: 'notice', queueOnFailure: true });
        return;
      }

      // 模型切换
      const modelMatch = /^\/model(?:\s+([\s\S]*))?$/.exec(command);
      if (modelMatch) {
        const arg = (modelMatch[1] ?? '').trim();
        if (!arg) {
          const catalog = listModelsFn(config.qoderBin);
          await session.sendSingle(formatModelList(catalog, state.models[userId] ?? config.qoderModel), {
            kind: 'notice',
            queueOnFailure: true,
          });
          return;
        }
        if (['default', 'auto', '默认'].includes(arg.toLowerCase())) {
          delete state.models[userId];
          persistState();
          await session.sendSingle('已恢复默认模型（Auto）。', { kind: 'notice', queueOnFailure: true });
          return;
        }
        const catalog = listModelsFn(config.qoderBin);
        const resolved = resolveModel(arg, catalog);
        if (!resolved.ok) {
          await session.sendSingle(`未找到模型：${arg}\n发送 /model 查看可用列表。`, {
            kind: 'notice',
            queueOnFailure: true,
          });
          return;
        }
        state.models[userId] = resolved.option.id;
        persistState();
        await session.sendSingle(`已切换模型：${resolved.option.label}\n下一条任务起生效。`, {
          kind: 'notice',
          queueOnFailure: true,
        });
        return;
      }

      // 未知命令给出提示，避免拼错后静默落到 Qoder
      if (isUnknownCommand(command)) {
        await session.sendSingle(`未知命令：${command}\n发送 /help 查看可用命令。`, {
          kind: 'notice',
          queueOnFailure: true,
        });
        return;
      }

      // 调 Qoder
      const record = state.sessions[userId];
      const modelForTask = state.models[userId] ?? config.qoderModel;
      const persona = loadPersonaFn(config.personaFile);
      const nextSnapshot = nodeFingerprintFn();
      const nodeChange = detectNodeChange(nodeSnapshot, nextSnapshot);
      if (nodeChange) {
        log.warn('Node 二进制已变化', {
          reason: nodeChange,
          path: nextSnapshot.path,
          ino: nextSnapshot.ino,
          version: nextSnapshot.version,
        });
        nodeSnapshot = nextSnapshot;
      }

      let taskHandle: { cancel: () => void; cancelled: boolean } | undefined;
      log.info('开始执行 Qoder 任务', {
        userId,
        taskId: id,
        sessionId: record?.sessionId ?? '(new)',
        cwd: workdir(),
        model: modelForTask || '(default)',
        personaChars: persona.length,
      });

      let result = await runQoderFn({
        prompt: text,
        cwd: config.cwd.trim() ? config.cwd : undefined,
        sessionId: record?.sessionId,
        timeoutMs: config.qoderTimeoutMs,
        bin: config.qoderBin,
        permissionMode: config.permissionMode,
        model: modelForTask || undefined,
        memory: config.memoryEnabled,
        appendSystemPrompt: persona || undefined,
        attachments,
        taskId: id,
        errorMaxChars: config.userErrorMaxChars,
        onStart: (cancel) => {
          taskHandle = { cancel, cancelled: false };
          runningTasks.set(userId, taskHandle);
        },
      });

      // 用户通过 /stop 主动终止
      if (taskHandle?.cancelled) {
        log.info('任务已被用户停止', { userId, taskId: id });
        runningTasks.delete(userId);
        await session.sendSingle('任务已停止。', { kind: 'notice', queueOnFailure: false });
        return;
      }

      // 会话不可续接时降级为新会话重试一次；匹配内部原文而非用户文案，避免中文模板让该路径静默失效
      if (!result.ok && record?.sessionId && /session|resume|not found/i.test(result.errorDetail ?? '')) {
        log.warn('续接会话失败，改为新建会话重试', {
          errorDetail: redactSensitive(result.errorDetail ?? '').slice(0, 160),
          errorClass: result.errorClass ?? '',
          errorCode: result.errorCode ?? '',
          taskId: id,
        });
        result = await runQoderFn({
          prompt: text,
          cwd: config.cwd.trim() ? config.cwd : undefined,
          timeoutMs: config.qoderTimeoutMs,
          bin: config.qoderBin,
          permissionMode: config.permissionMode,
          model: modelForTask || undefined,
          memory: config.memoryEnabled,
          appendSystemPrompt: persona || undefined,
          attachments,
          taskId: id,
          errorMaxChars: config.userErrorMaxChars,
          onStart: (cancel) => {
            taskHandle = { cancel, cancelled: false };
            runningTasks.set(userId, taskHandle);
          },
        });
      }

      if (result.sessionId) {
        state.sessions[userId] = {
          sessionId: result.sessionId,
          updatedAt: Date.now(),
          turns: (record?.turns ?? 0) + 1,
        };
        persistState();
      }

      if (!result.ok) {
        state.lastFailure = {
          kind: result.errorKind ?? 'exit',
          errorClass: result.errorClass ?? 'unknown',
          errorCode: result.errorCode,
          exitCode: result.exitCode ?? null,
          at: now(),
          taskId: id,
        };
        persistState();
      }

      log.info('任务结束', {
        userId,
        taskId: id,
        ok: result.ok,
        errorKind: result.errorKind ?? '',
        errorClass: result.errorClass ?? '',
        errorCode: result.errorCode ?? '',
        exitCode: result.exitCode ?? null,
        durationMs: result.durationMs,
        sessionId: result.sessionId ?? record?.sessionId ?? '',
        replyChars: result.ok ? result.text.length : 0,
        model: result.modelUsed ?? modelForTask ?? '(default)',
        diagnosticPath: result.diagnosticPath ?? '',
      });

      if (!result.ok && result.errorClass === 'unknown' && (result.errorCode || result.errorDetail)) {
        log.warn('未识别的 qodercli 语义错误', {
          errorCode: result.errorCode ?? '',
          errorSummary: redactSensitive(result.errorDetail ?? '').slice(0, 160),
          taskId: id,
        });
      }

      if (result.ok) {
        const replyText = result.text.trim() || '任务执行完成，但没有文本输出。';
        await session.sendChunked(replyText, { kind: 'reply', taskId: id });
      } else {
        const errorClass = result.errorClass ?? 'unknown';
        // unknown 覆盖 timeout / spawn / empty / parse 与未收录错误码：各自的提示带不同的失败种类与退出码，
        // 归到一个桶会互相抑制并丢掉关键信息（实测第二次超时只剩「未归类同 HH:MM 那条」），故不参与去重
        const deduped = errorClass !== 'unknown';
        const decision = deduped
          ? errorDedup.plan(userId, errorClass)
          : { full: true, firstAt: now(), suppressed: 0 };
        const reply = decision.full
          ? (result.error ??
            buildUserErrorReply({
              kind: result.errorKind ?? 'exit',
              errorClass,
              exitCode: result.exitCode,
              detail: undefined,
              maxChars: config.userErrorMaxChars,
            }))
          : buildAckText({ errorClass, firstAt: decision.firstAt, suppressed: decision.suppressed });
        // 错误提示与 ack 一律不入补发队列：发送失败只写日志，避免重新堵塞队列
        const outcome = await session.sendSingle(reply, { kind: 'error', queueOnFailure: false, taskId: id });
        if (outcome === 'sent') {
          if (deduped) errorDedup.commit(userId, errorClass, decision.full);
        } else {
          log.warn('错误提示未送达，不推进去重窗口', {
            userId,
            taskId: id,
            errorClass,
            outcome,
            suppressed: decision.suppressed,
          });
        }
        if (!decision.full) {
          log.info('错误提示被去重窗口抑制', {
            category: 'suppressed',
            userId,
            taskId: id,
            errorClass,
            suppressed: decision.suppressed,
            firstAt: decision.firstAt,
          });
        }
      }
    } finally {
      runningTasks.delete(userId);
      persistState();
      await typing.stop();
    }
  };

  /** typing 保活：每 5s 续一次，结束发送取消 */
  class TypingKeeper {
    private timer?: NodeJS.Timeout;
    private ticket = '';

    constructor(
      private readonly userId: string,
      private readonly contextToken: string,
    ) {}

    /** 开始保活 */
    async start(): Promise<void> {
      this.ticket = await getTypingTicketFn({
        baseUrl: config.baseUrl,
        token: config.token,
        userId: this.userId,
        contextToken: this.contextToken,
      });
      if (!this.ticket) return;
      const beat = (): void => {
        void sendTypingFn({
          baseUrl: config.baseUrl,
          token: config.token,
          userId: this.userId,
          typingTicket: this.ticket,
          status: TypingStatus.TYPING,
        });
      };
      beat();
      this.timer = setInterval(beat, config.typingKeepAliveMs);
      this.timer.unref?.();
    }

    /** 结束保活并取消提示 */
    async stop(): Promise<void> {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      if (!this.ticket) return;
      await sendTypingFn({
        baseUrl: config.baseUrl,
        token: config.token,
        userId: this.userId,
        typingTicket: this.ticket,
        status: TypingStatus.CANCEL,
      });
    }
  }

  /**
   * 当前生效的工作目录：未配置时在主目录下运行全局会话
   * @returns 绝对路径
   */
  const workdir = (): string => config.cwd.trim() || os.homedir();

  /**
   * 处理一条入站消息
   * @param msg - 微信消息
   */
  const handleInbound = async (msg: WeixinMessage): Promise<void> => {
    if (msg.message_type !== MessageType.USER) return;
    const from = msg.from_user_id;
    if (!from) return;
    const msgId = msg.message_id ?? `${from}:${msg.create_time_ms ?? Date.now()}`;
    if (state.seenMessageIds.includes(msgId)) return;
    state.seenMessageIds.push(msgId);
    if (state.seenMessageIds.length > 500) state.seenMessageIds.splice(0, state.seenMessageIds.length - 500);
    persistState();

    // 诊断：只记录字段是否存在，不落音频内容
    log.debug('入站消息项', {
      messageId: msgId,
      items: (msg.item_list ?? []).map((item) => ({
        type: item.type,
        text: Boolean(item.text_item?.text),
        voiceText: Boolean(item.voice_item?.text),
        voicePlaytime: item.voice_item?.playtime ?? null,
        hasMedia: Boolean(
          item.image_item?.media || item.voice_item?.media || item.file_item?.media || item.video_item?.media,
        ),
        hasAesKey: Boolean(
          item.image_item?.media?.aes_key ||
            item.voice_item?.media?.aes_key ||
            item.file_item?.media?.aes_key ||
            item.video_item?.media?.aes_key,
        ),
        fileName: item.file_item?.file_name ?? null,
        voiceMeta: item.voice_item
          ? {
              encode_type: item.voice_item.encode_type ?? null,
              bits_per_sample: item.voice_item.bits_per_sample ?? null,
              sample_rate: item.voice_item.sample_rate ?? null,
              playtime: item.voice_item.playtime ?? null,
              textLen: item.voice_item.text?.length ?? 0,
            }
          : null,
      })),
    });

    const text = extractText(msg);

    // 先鉴权，再下载附件，避免未授权者消耗带宽和磁盘
    if (!isAllowed(from)) {
      if (config.allowFirstSender) {
        config = { ...config, ownerUserId: from };
        saveConfig({ ...config });
        log.warn('allowFirstSender 生效，已把首个发送者设为授权账号', { from });
      } else {
        log.warn('未授权的发送者，已忽略', { from, preview: text.slice(0, 40) || '[附件]' });
        return;
      }
    }

    const contextToken = msg.context_token ?? '';
    if (contextToken) {
      state.contextTokens[from] = contextToken;
      persistState();
    }

    // 语音没有转写时给用户明确反馈，不启动 Qoder 任务
    const voiceWithoutText = (msg.item_list ?? []).some(
      (item) => item.type === MessageItemType.VOICE && !item.voice_item?.text,
    );

    // /stop 必须在入队前处理，否则会排在正在运行的任务后面
    const commandText = text.trim().toLowerCase();
    if (commandText === '/stop' || commandText === '/cancel') {
      const stopToken = msg.context_token ?? '';
      if (stopToken) {
        state.contextTokens[from] = stopToken;
        persistState();
      }
      const handle = runningTasks.get(from);
      if (handle) {
        handle.cancelled = true;
        handle.cancel();
        log.info('收到停止指令，正在终止任务', { from });
      } else if (stopToken) {
        await sendControl(from, stopToken, '当前没有正在执行的任务。');
      }
      return;
    }

    // 下载图片/文件/视频，落盘后通过 --attachment 交给 Qoder
    const media: SavedMedia[] = [];
    const failures: string[] = [];
    let mediaIndex = 0;
    for (const item of msg.item_list ?? []) {
      const isMedia =
        item.type === MessageItemType.IMAGE ||
        item.type === MessageItemType.FILE ||
        item.type === MessageItemType.VIDEO ||
        // 无转写的语音也下载，便于诊断/未来接 ASR；有转写的不下载
        (item.type === MessageItemType.VOICE && !item.voice_item?.text);
      if (!isMedia) continue;
      mediaIndex += 1;
      try {
        const saved = await downloadMediaFn(item, msgId, mediaIndex, config.inboxDir);
        if (saved) media.push(saved);
        else failures.push(describeItem(item));
      } catch (err) {
        log.warn('附件下载失败', { messageId: msgId, error: String(err) });
        failures.push(`${describeItem(item)}（${String(err).slice(0, 80)}）`);
      }
    }

    // 语音文件只做诊断，不作为附件交给 Qoder
    const attachments = media.filter((m) => m.kind !== 'voice').map((m) => m.path);
    const voiceFiles = media.filter((m) => m.kind === 'voice');
    if (voiceFiles.length > 0) {
      log.info('已保存未转写语音，供诊断', { count: voiceFiles.length, path: voiceFiles[0]?.path });
    }

    // 语音没有转写且没有其它内容：直接反馈，不启动任务
    if (voiceWithoutText && !text && attachments.length === 0) {
      log.info('语音无转写，已直接反馈', { from });
      if (contextToken) {
        await sendControl(from, contextToken, '这条语音没有转写，我没法听到内容。请重发一次，或改用文字/图片。');
      }
      return;
    }
    if (voiceWithoutText) failures.push('语音（无转写）');

    const prompt = buildPrompt(
      text,
      media.filter((m) => m.kind !== 'voice'),
      failures,
    );
    if (!prompt) {
      log.info('消息无可用内容，跳过', { from });
      return;
    }
    log.info('收到授权消息', {
      from,
      chars: text.length,
      attachments: media.length,
      preview: text.slice(0, 60),
    });
    enqueue(from, () => processTask(from, prompt, contextToken, attachments));
  };

  /**
   * 取消所有进行中的 Qoder 任务
   */
  const cancelAllTasks = (): void => {
    for (const task of runningTasks.values()) {
      task.cancelled = true;
      task.cancel();
    }
  };

  /**
   * 等待当前排队的任务全部结束
   * @returns 全部任务结束
   */
  const waitForIdle = async (): Promise<void> => {
    while (queues.size > 0) {
      await Promise.all([...queues.values()]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  return {
    handleInbound,
    processTask,
    cancelAllTasks,
    waitForIdle,
    prune,
    getConfig: () => config,
    getState: () => state,
  };
}

/**
 * 生成预检失败告警
 * @param result - 预检结果
 * @returns 单条短告警
 */
export function formatPreflightAlert(result: PreflightResult): string {
  const kinds = result.failures.map((failure) => failure.kind).join(', ') || 'unknown';
  return `本机 Qoder 环境异常：${kinds}。已记录日志，请检查 Node / qodercli。`.slice(0, 300);
}

/**
 * 启动常驻桥接服务
 * @param overrides - 覆盖配置文件中的字段（不落盘）
 * @param deps - 可注入依赖，便于单测
 * @returns 运行句柄
 */
export async function runService(
  overrides: Partial<Config> = {},
  deps: ServiceDeps = {},
): Promise<BridgeHandle> {
  const pruneDiagnosticsFn = deps.pruneDiagnostics ?? pruneDiagnostics;
  const pruneInboxFn = deps.pruneInbox ?? pruneInbox;
  const loginFn = deps.login ?? login;
  const notifyClientFn = deps.notifyClient ?? notifyClient;
  const getUpdatesFn = deps.getUpdates ?? getUpdates;
  const writeRunInfoFn = deps.writeRunInfo ?? writeRunInfo;
  const clearRunInfoFn = deps.clearRunInfo ?? clearRunInfo;
  const runPreflightFn = deps.runPreflight ?? runPreflight;
  const sendTextFn = deps.sendText ?? sendText;

  ensureDirs();
  let config: Config = { ...loadConfig(), ...overrides };
  const state: State = loadState();
  try {
    pruneDiagnosticsFn(config.diagnosticRetentionDays);
  } catch (err) {
    log.warn('诊断清理失败', { error: String(err) });
  }
  try {
    pruneInboxFn(config.inboxDir);
  } catch {
    // 清理失败不影响启动
  }
  let running = true;
  /** 用于中断长轮询，保证 Ctrl+C 后立即退出 */
  const abortController = new AbortController();

  if (!config.token) {
    log.warn('尚未登录微信，先执行扫码登录');
    const result = await loginFn();
    log.info(result.message);
    if (!result.connected) throw new Error('微信登录未完成');
    config = { ...loadConfig(), ...overrides };
  }

  const runtime = createBridgeRuntime(config, state, {
    ...deps,
    onSessionExpired: () => {
      running = false;
      deps.onSessionExpired?.();
    },
  });
  runtime.prune();

  const preflight = await runPreflightFn({
    qoderBin: config.qoderBin,
    versionTimeoutMs: config.preflightVersionTimeoutMs,
  });
  if (preflight.ok) {
    log.info('启动预检通过', {
      nodeVersion: preflight.node.version,
      nodePath: preflight.node.execPath,
      qoderPath: preflight.qodercli?.path ?? '',
      qoderVersion: preflight.qodercli?.version ?? '',
    });
  } else {
    log.error('启动预检失败', {
      failures: preflight.failures.map((failure) => failure.kind),
      nodeVersion: preflight.node.version,
      nodePath: preflight.node.execPath,
      qoderPath: preflight.qodercli?.path ?? '',
    });
    const owner = runtime.getConfig().ownerUserId;
    const token = owner ? runtime.getState().contextTokens[owner] ?? '' : '';
    if (token) {
      try {
        await sendTextFn({
          baseUrl: runtime.getConfig().baseUrl,
          token: runtime.getConfig().token,
          toUserId: owner,
          text: formatPreflightAlert(preflight),
          contextToken: token,
        });
      } catch (err) {
        log.warn('预检告警发送失败', { error: String(err) });
      }
    }
  }

  log.info('桥接服务启动', {
    baseUrl: config.baseUrl,
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    ownerUserId: config.ownerUserId || '(未设置)',
    token: config.token ? '***' : '(empty)',
  });
  writeRunInfoFn();

  /** 主循环 */
  const runLoop = async (): Promise<void> => {
    await notifyClientFn({
      baseUrl: runtime.getConfig().baseUrl,
      token: runtime.getConfig().token,
      action: 'start',
    });
    let pollTimeout = config.pollTimeoutMs;
    let backoff = 1_000;
    while (running) {
      try {
        const current = runtime.getConfig();
        const resp = await getUpdatesFn({
          baseUrl: current.baseUrl,
          token: current.token,
          getUpdatesBuf: runtime.getState().getUpdatesBuf,
          timeoutMs: pollTimeout + 5_000,
          signal: abortController.signal,
        });
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          pollTimeout = resp.longpolling_timeout_ms;
        }
        const ret = resp.ret ?? 0;
        const errcode = resp.errcode ?? 0;
        if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
          log.error('会话已过期（-14），停止循环，请重新执行 login');
          break;
        }
        if (ret !== 0 || errcode !== 0) {
          log.warn('getupdates 返回错误，退避重试', { ret, errcode, errmsg: resp.errmsg, backoff });
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 10_000);
          continue;
        }
        backoff = 1_000;
        if (resp.get_updates_buf) {
          runtime.getState().getUpdatesBuf = resp.get_updates_buf;
          saveState(runtime.getState());
        }
        for (const msg of resp.msgs ?? []) {
          await runtime.handleInbound(msg);
        }
      } catch (err) {
        log.error('轮询异常，退避重试', { error: String(err), backoff });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
    await notifyClientFn({
      baseUrl: runtime.getConfig().baseUrl,
      token: runtime.getConfig().token,
      action: 'stop',
    });
  };

  let signalCount = 0;
  const onSignal = (): void => {
    signalCount += 1;
    if (signalCount > 1) {
      log.warn('再次收到停止信号，立即退出');
      saveState(runtime.getState());
      process.exit(130);
    }
    log.info('收到停止信号，准备退出');
    running = false;
    runtime.cancelAllTasks();
    abortController.abort();
    saveState(runtime.getState());
  };
  /** 移除信号监听，避免同进程多次启动时累积 */
  const removeSignals = (): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  void runLoop()
    .catch((err) => log.error('主循环异常退出', { error: String(err) }))
    .finally(() => {
      removeSignals();
      clearRunInfoFn(process.pid);
    });

  return {
    stop: (): void => {
      running = false;
      runtime.cancelAllTasks();
      abortController.abort();
      removeSignals();
    },
    config: runtime.getConfig(),
  };
}
