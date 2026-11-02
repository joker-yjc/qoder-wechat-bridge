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
import { MessageItemType, MessageType, TypingStatus, type MessageItem, type WeixinMessage } from '../weixin/types.js';
import { downloadItemMedia, pruneInbox, type SavedMedia } from '../weixin/media.js';
import { runQoder } from './qoder.js';
import { chunkText } from './reply.js';
import { takePending } from '../notify.js';
import { loadPersona } from '../persona.js';

/** 桥接服务句柄 */
export interface BridgeHandle {
  /** 停止服务 */
  stop: () => void;
  /** 当前生效配置 */
  config: Config;
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
 * 启动常驻桥接服务
 * @param overrides - 覆盖配置文件中的字段（不落盘）
 * @returns 运行句柄
 */
export async function runService(overrides: Partial<Config> = {}): Promise<BridgeHandle> {
  ensureDirs();
  let config: Config = { ...loadConfig(), ...overrides };
  const state: State = loadState();
  try {
    pruneInbox(config.inboxDir);
  } catch {
    // 清理失败不影响启动
  }
  let running = true;
  /** 用于中断长轮询，保证 Ctrl+C 后立即退出 */
  const abortController = new AbortController();
  /** 每个微信用户一条串行队列，避免同一会话并发 */
  const queues = new Map<string, Promise<void>>();
  /** 每个用户当前正在执行的任务句柄，用于 /stop 强制停止 */
  const runningTasks = new Map<string, { cancel: () => void; cancelled: boolean }>();

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
   * 发送一条文本，失败时记录原因
   * @param toUserId - 目标用户
   * @param contextToken - 上下文令牌
   * @param text - 正文
   * @returns 是否发送成功
   */
  const deliver = async (toUserId: string, contextToken: string, text: string): Promise<boolean> => {
    try {
      await sendText({ baseUrl: config.baseUrl, token: config.token, toUserId, text, contextToken });
      return true;
    } catch (err) {
      const msg = String(err);
      log.error('发送失败', { toUserId, error: msg, preview: text.slice(0, 60) });
      if (msg.includes(String(SESSION_EXPIRED_ERRCODE))) {
        running = false;
        log.error('会话过期（-14），停止循环，请重新执行 login');
      }
      return false;
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
      this.ticket = await getTypingTicket({
        baseUrl: config.baseUrl,
        token: config.token,
        userId: this.userId,
        contextToken: this.contextToken,
      });
      if (!this.ticket) return;
      const beat = (): void => {
        void sendTyping({
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
      await sendTyping({
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
   * 处理一条任务：补发欠账 → 调 Qoder → 回传
   * @param userId - 微信用户
   * @param text - 任务文本
   * @param contextToken - 本次入站的上下文令牌
   */
  const processTask = async (
    userId: string,
    text: string,
    contextToken: string,
    attachments: string[] = [],
  ): Promise<void> => {
    let budget = config.maxRepliesPerTurn;
    const typing = new TypingKeeper(userId, contextToken);
    await typing.start();
    try {
      // 0. 补发 CLI 侧暂存的主动提醒（qoder-wechat notify）
      const pending = takePending();
      if (pending.length > 0) {
        log.info('补发主动提醒', { count: pending.length, userId });
        for (const item of pending.filter((p) => p.toUserId !== userId)) {
          state.outbox.push({ id: item.id, toUserId: item.toUserId, text: item.text, createdAt: item.createdAt, attempts: 0 });
        }
        for (const item of pending.filter((p) => p.toUserId === userId)) {
          if (budget <= 0) {
            state.outbox.push({ id: item.id, toUserId: item.toUserId, text: item.text, createdAt: item.createdAt, attempts: 0 });
            continue;
          }
          if (await deliver(userId, contextToken, item.text)) {
            budget -= 1;
          } else {
            state.outbox.push({ id: item.id, toUserId: item.toUserId, text: item.text, createdAt: item.createdAt, attempts: 1 });
            break;
          }
        }
        persistState();
      }

      // 1. 补发上一轮未送达的结果
      for (const item of state.outbox.filter((o) => o.toUserId === userId)) {
        if (budget <= 0) break;
        if (await deliver(userId, contextToken, item.text)) {
          state.outbox = state.outbox.filter((o) => o.id !== item.id);
          budget -= 1;
          persistState();
        } else {
          item.attempts += 1;
          persistState();
          break;
        }
      }

      // 2. 内置命令
      const command = text.trim();
      if (command === '/help') {
        await deliver(userId, contextToken, formatHelp());
        return;
      }
      if (command === '/reset') {
        delete state.sessions[userId];
        persistState();
        await deliver(userId, contextToken, '会话已重置，下一条消息将开启新的 Qoder 会话。');
        return;
      }
      if (command === '/status') {
        const record = state.sessions[userId];
        const lines = [
          `工作目录：${workdir()}${config.cwd.trim() ? '' : '（全局）'}`,
          `模型：${state.models[userId] ?? config.qoderModel ?? 'Auto（默认）'}`,
          `Qoder 会话：${record ? record.sessionId : '（尚未创建）'}`,
          `累计轮次：${record?.turns ?? 0}`,
          `待补发：${state.outbox.filter((o) => o.toUserId === userId).length} 条`,
        ];
        await deliver(userId, contextToken, lines.join('\n'));
        return;
      }

      // 3. 模型切换
      const modelMatch = /^\/model(?:\s+([\s\S]*))?$/.exec(command);
      if (modelMatch) {
        const arg = (modelMatch[1] ?? '').trim();
        if (!arg) {
          const catalog = listModels(config.qoderBin);
          await deliver(userId, contextToken, formatModelList(catalog, state.models[userId] ?? config.qoderModel));
          return;
        }
        if (['default', 'auto', '默认'].includes(arg.toLowerCase())) {
          delete state.models[userId];
          persistState();
          await deliver(userId, contextToken, '已恢复默认模型（Auto）。');
          return;
        }
        const catalog = listModels(config.qoderBin);
        const resolved = resolveModel(arg, catalog);
        if (!resolved.ok) {
          await deliver(userId, contextToken, `未找到模型：${arg}\n发送 /model 查看可用列表。`);
          return;
        }
        state.models[userId] = resolved.option.id;
        persistState();
        await deliver(userId, contextToken, `已切换模型：${resolved.option.label}\n下一条任务起生效。`);
        return;
      }

      // 未知命令给出提示，避免拼错后静默落到 Qoder
      if (isUnknownCommand(command)) {
        await deliver(userId, contextToken, `未知命令：${command}\n发送 /help 查看可用命令。`);
        return;
      }

      // 4. 调 Qoder
      const record = state.sessions[userId];
      const modelForTask = state.models[userId] ?? config.qoderModel;
      // 每条任务重新读取人设，改文件后下一条消息即生效
      const persona = loadPersona(config.personaFile);
      let taskHandle: { cancel: () => void; cancelled: boolean } | undefined;
      log.info('开始执行 Qoder 任务', {
        userId,
        sessionId: record?.sessionId ?? '(new)',
        cwd: workdir(),
        model: modelForTask || '(default)',
        personaChars: persona.length,
      });
      let result = await runQoder({
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
        onStart: (cancel) => {
          taskHandle = { cancel, cancelled: false };
          runningTasks.set(userId, taskHandle);
        },
      });

      // 用户通过 /stop 主动终止
      if (taskHandle?.cancelled) {
        log.info('任务已被用户停止', { userId });
        runningTasks.delete(userId);
        await deliver(userId, contextToken, '任务已停止。');
        return;
      }

      // 会话不可续接时降级为新会话重试一次
      if (!result.ok && record?.sessionId && /session|resume|not found/i.test(result.error ?? '')) {
        log.warn('续接会话失败，改为新建会话重试', { error: result.error });
        result = await runQoder({
          prompt: text,
          cwd: config.cwd.trim() ? config.cwd : undefined,
          timeoutMs: config.qoderTimeoutMs,
          bin: config.qoderBin,
          permissionMode: config.permissionMode,
          model: modelForTask || undefined,
          memory: config.memoryEnabled,
          appendSystemPrompt: persona || undefined,
          attachments,
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

      const replyText = result.ok
        ? result.text.trim() || '任务执行完成，但没有文本输出。'
        : `执行失败：${result.error ?? '未知错误'}`;
      log.info('任务结束', {
        userId,
        ok: result.ok,
        durationMs: result.durationMs,
        sessionId: result.sessionId ?? record?.sessionId ?? '',
        replyChars: replyText.length,
        model: result.modelUsed ?? modelForTask ?? '(default)',
      });

      // 5. 分片回传，超出额度的进入 outbox
      const chunks = chunkText(replyText, config.maxReplyChars);
      let sentCount = 0;
      for (const chunk of chunks) {
        if (budget <= 0) break;
        if (await deliver(userId, contextToken, chunk)) {
          budget -= 1;
          sentCount += 1;
        } else {
          break;
        }
      }
      const remaining = chunks.slice(sentCount);
      if (remaining.length > 0) {
        for (const chunk of remaining) {
          state.outbox.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            toUserId: userId,
            text: chunk,
            createdAt: Date.now(),
            attempts: 0,
          });
        }
        persistState();
        log.warn('超出本轮额度，剩余内容进入补发队列', { count: remaining.length });
      }
    } finally {
      runningTasks.delete(userId);
      await typing.stop();
    }
  };

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
        await deliver(from, stopToken, '当前没有正在执行的任务。');
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
        const saved = await downloadItemMedia(item, msgId, mediaIndex, config.inboxDir);
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
        await deliver(from, contextToken, '这条语音没有转写，我没法听到内容。请重发一次，或改用文字/图片。');
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

  /** 主循环 */
  const runLoop = async (): Promise<void> => {
    await notifyClient({ baseUrl: config.baseUrl, token: config.token, action: 'start' });
    let pollTimeout = config.pollTimeoutMs;
    let backoff = 1_000;
    while (running) {
      try {
        const resp = await getUpdates({
          baseUrl: config.baseUrl,
          token: config.token,
          getUpdatesBuf: state.getUpdatesBuf,
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
          state.getUpdatesBuf = resp.get_updates_buf;
          persistState();
        }
        for (const msg of resp.msgs ?? []) {
          await handleInbound(msg);
        }
      } catch (err) {
        log.error('轮询异常，退避重试', { error: String(err), backoff });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
    await notifyClient({ baseUrl: config.baseUrl, token: config.token, action: 'stop' });
  };

  if (!config.token) {
    log.warn('尚未登录微信，先执行扫码登录');
    const result = await login();
    log.info(result.message);
    if (!result.connected) throw new Error('微信登录未完成');
    config = { ...loadConfig(), ...overrides };
  }

  log.info('桥接服务启动', {
    baseUrl: config.baseUrl,
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    ownerUserId: config.ownerUserId || '(未设置)',
    token: config.token ? '***' : '(empty)',
  });
  writeRunInfo();

  /**
   * 取消所有进行中的 Qoder 任务
   *
   * 长轮询的 abortController 管不到子进程，不显式取消的话父进程退出后
   * qodercli 会变成孤儿继续执行，跑完还可能往微信回消息。
   */
  const cancelAllTasks = (): void => {
    for (const task of runningTasks.values()) {
      task.cancelled = true;
      task.cancel();
    }
  };

  let signalCount = 0;
  const onSignal = (): void => {
    signalCount += 1;
    if (signalCount > 1) {
      log.warn('再次收到停止信号，立即退出');
      persistState();
      process.exit(130);
    }
    log.info('收到停止信号，准备退出');
    running = false;
    cancelAllTasks();
    abortController.abort();
    persistState();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  void runLoop()
    .catch((err) => log.error('主循环异常退出', { error: String(err) }))
    .finally(() => clearRunInfo(process.pid));

  return {
    stop: (): void => {
      running = false;
      cancelAllTasks();
      abortController.abort();
    },
    config,
  };
}
