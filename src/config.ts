/**
 * 配置与运行状态：遵循 XDG 目录规范，支持 QWB_* 环境变量覆盖
 * @module config
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ERROR_CODE_MAX_CHARS, sanitizeSingleLine, type QoderErrorClass } from './bridge/error-class.js';

/** 包名，用于目录名 */
const APP = 'qoder-wechat-bridge';

/** 配置目录：$QWB_CONFIG_DIR > $XDG_CONFIG_HOME/qoder-wechat-bridge > ~/.config/qoder-wechat-bridge */
export function configDir(): string {
  return (
    process.env.QWB_CONFIG_DIR ??
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), APP)
  );
}

/** 状态目录：$QWB_STATE_DIR > $XDG_STATE_HOME/qoder-wechat-bridge > ~/.local/state/qoder-wechat-bridge */
export function stateDir(): string {
  return (
    process.env.QWB_STATE_DIR ??
    path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), APP)
  );
}

/** 配置文件路径 */
export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

/** 状态文件路径 */
export function statePath(): string {
  return path.join(stateDir(), 'state.json');
}

/** 运行记录路径：保存当前桥接进程的 pid，供 stop 命令定位 */
export function runInfoPath(): string {
  return path.join(stateDir(), 'run.json');
}

/** 桥接进程的运行记录 */
export interface RunInfo {
  /** 进程 id */
  pid: number;
  /** 父进程 id */
  ppid: number;
  /** 启动时间（ISO 字符串） */
  startedAt: string;
  /** 启动时的工作目录 */
  cwd: string;
}

/** 把当前进程登记为运行中的桥接服务 */
export function writeRunInfo(): void {
  const info: RunInfo = {
    pid: process.pid,
    ppid: process.ppid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };
  writeAtomic(runInfoPath(), `${JSON.stringify(info, null, 2)}\n`, 0o600);
}

/**
 * 读取运行记录
 * @returns 运行记录；文件缺失或内容损坏时返回 null
 */
export function readRunInfo(): RunInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(runInfoPath(), 'utf-8')) as Partial<RunInfo>;
    if (typeof raw.pid !== 'number' || raw.pid <= 0) return null;
    return { pid: raw.pid, ppid: raw.ppid ?? 0, startedAt: raw.startedAt ?? '', cwd: raw.cwd ?? '' };
  } catch {
    return null;
  }
}

/**
 * 删除运行记录
 * @param expectedPid - 传入时只删除属于该 pid 的记录，避免覆盖新实例的登记
 */
export function clearRunInfo(expectedPid?: number): void {
  if (expectedPid !== undefined) {
    const current = readRunInfo();
    if (current && current.pid !== expectedPid) return;
  }
  try {
    fs.rmSync(runInfoPath());
  } catch {
    // 记录本就不存在，无需处理
  }
}

/** 桥接服务配置 */
export interface Config {
  /** iLink API 基础地址，登录成功后服务端可能下发新的 baseUrl */
  baseUrl: string;
  /** 扫码登录拿到的 Bearer token */
  token: string;
  /** 机器人账号 id（登录返回的 ilink_bot_id） */
  botId: string;
  /** 唯一授权发送者的 ilink user id（扫码登录时自动写入） */
  ownerUserId: string;
  /** 额外允许的发送者 */
  allowFrom: string[];
  /** ownerUserId 为空时是否信任首个发送者（公网部署建议 false） */
  allowFirstSender: boolean;
  /** Qoder 会话的工作目录；空串表示不限定（在用户主目录下运行全局会话） */
  cwd: string;
  /** 传给 qodercli 的权限模式 */
  permissionMode: string;
  /** qodercli 可执行文件名或绝对路径 */
  qoderBin: string;
  /** 可选模型名，空串表示用 Qoder 默认 */
  qoderModel: string;
  /** 是否在 Qoder 会话中加载长期记忆（QODER_MEMORY_HEADLESS） */
  memoryEnabled: boolean;
  /** 人设文件路径；文件存在时作为 --append-system-prompt 传入 */
  personaFile: string;
  /** 入站附件存放目录；默认在状态目录下，可指向磁盘更宽裕的位置 */
  inboxDir: string;
  /** 语音合成发音人（macOS say） */
  ttsVoice: string;
  /** 单个任务最长执行时间 */
  qoderTimeoutMs: number;
  /** typing 保活间隔 */
  typingKeepAliveMs: number;
  /** 单条微信消息最大字符数 */
  maxReplyChars: number;
  /** 单轮最多下行条数（官方实测约 10 条，留 1 条余量） */
  maxRepliesPerTurn: number;
  /** getUpdates 长轮询超时 */
  pollTimeoutMs: number;
  /** outbox 最大条数，超出后丢弃最旧消息 */
  outboxMaxItems: number;
  /** outbox 消息最长保留时间 */
  outboxTtlMs: number;
  /** 永久 / 未知失败达到该次数后移入隔离区 */
  poisonMaxAttempts: number;
  /** 瞬时失败达到该次数后移入隔离区 */
  transientMaxAttempts: number;
  /** 隔离区最大条数 */
  quarantineMaxItems: number;
  /** 隔离区消息最长保留时间 */
  quarantineTtlMs: number;
  /** 单条用户错误提示最大字符数 */
  userErrorMaxChars: number;
  /** 同类错误提示的去重窗口时长 */
  errorDedupWindowMs: number;
  /** 单次失败诊断文件最大字节数 */
  diagnosticMaxBytes: number;
  /** 诊断文件保留天数 */
  diagnosticRetentionDays: number;
  /** qodercli --version 预检超时 */
  preflightVersionTimeoutMs: number;
}

/** 默认配置：面向通用场景，安全优先 */
export const DEFAULT_CONFIG: Config = {
  baseUrl: 'https://ilinkai.weixin.qq.com',
  token: '',
  botId: '',
  ownerUserId: '',
  allowFrom: [],
  allowFirstSender: false,
  cwd: '',
  permissionMode: 'dont_ask',
  qoderBin: 'qodercli',
  qoderModel: '',
  memoryEnabled: true,
  personaFile: path.join(configDir(), 'persona.md'),
  inboxDir: path.join(stateDir(), 'inbox'),
  ttsVoice: 'Tingting',
  qoderTimeoutMs: 10 * 60_000,
  typingKeepAliveMs: 5_000,
  maxReplyChars: 2_000,
  maxRepliesPerTurn: 9,
  pollTimeoutMs: 35_000,
  outboxMaxItems: 200,
  outboxTtlMs: 24 * 60 * 60_000,
  poisonMaxAttempts: 3,
  transientMaxAttempts: 10,
  quarantineMaxItems: 500,
  quarantineTtlMs: 7 * 24 * 60 * 60_000,
  userErrorMaxChars: 300,
  errorDedupWindowMs: 10 * 60_000,
  diagnosticMaxBytes: 64 * 1024,
  diagnosticRetentionDays: 7,
  preflightVersionTimeoutMs: 5_000,
};

/** 环境变量覆盖表 */
const ENV_OVERRIDES: ReadonlyArray<[keyof Config, string, (raw: string) => unknown]> = [
  ['baseUrl', 'QWB_BASE_URL', (v) => v],
  ['token', 'QWB_TOKEN', (v) => v],
  ['botId', 'QWB_BOT_ID', (v) => v],
  ['ownerUserId', 'QWB_OWNER_ID', (v) => v],
  ['allowFrom', 'QWB_ALLOW_FROM', (v) => v.split(',').map((s) => s.trim()).filter(Boolean)],
  ['allowFirstSender', 'QWB_ALLOW_FIRST_SENDER', (v) => v === '1' || v === 'true'],
  ['cwd', 'QWB_CWD', (v) => v],
  ['permissionMode', 'QWB_PERMISSION_MODE', (v) => v],
  ['qoderBin', 'QWB_QODER_BIN', (v) => v],
  ['qoderModel', 'QWB_MODEL', (v) => v],
  ['memoryEnabled', 'QWB_MEMORY', (v) => !['0', 'false', 'no', 'off'].includes(v.toLowerCase())],
  ['personaFile', 'QWB_PERSONA_FILE', (v) => v],
  ['inboxDir', 'QWB_INBOX_DIR', (v) => v],
  ['ttsVoice', 'QWB_TTS_VOICE', (v) => v],
  ['qoderTimeoutMs', 'QWB_TIMEOUT_MS', (v) => Number(v)],
  ['maxReplyChars', 'QWB_MAX_REPLY_CHARS', (v) => Number(v)],
  ['maxRepliesPerTurn', 'QWB_MAX_REPLIES', (v) => Number(v)],
  ['outboxMaxItems', 'QWB_OUTBOX_MAX', (v) => Number(v)],
  ['outboxTtlMs', 'QWB_OUTBOX_TTL_MS', (v) => Number(v)],
  ['poisonMaxAttempts', 'QWB_POISON_ATTEMPTS', (v) => Number(v)],
  ['transientMaxAttempts', 'QWB_TRANSIENT_ATTEMPTS', (v) => Number(v)],
  ['quarantineMaxItems', 'QWB_QUARANTINE_MAX', (v) => Number(v)],
  ['quarantineTtlMs', 'QWB_QUARANTINE_TTL_MS', (v) => Number(v)],
  ['userErrorMaxChars', 'QWB_USER_ERROR_CHARS', (v) => Number(v)],
  [
    'errorDedupWindowMs',
    'QWB_ERROR_DEDUP_WINDOW_MS',
    // 非法值必须回落默认：NaN 会让窗口永不过期，用户首次失败后永久只收到 ack
    (v) => {
      const parsed = Number(v);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONFIG.errorDedupWindowMs;
    },
  ],
  ['diagnosticMaxBytes', 'QWB_DIAG_MAX_BYTES', (v) => Number(v)],
  ['diagnosticRetentionDays', 'QWB_DIAG_RETENTION_DAYS', (v) => Number(v)],
  ['preflightVersionTimeoutMs', 'QWB_PREFLIGHT_VERSION_TIMEOUT_MS', (v) => Number(v)],
];

/** 某个微信用户对应的 Qoder 会话 */
export interface SessionRecord {
  sessionId: string;
  updatedAt: number;
  turns: number;
}

/** 出站消息类别 */
export type OutboxItemKind = 'reply' | 'notice' | 'error';

/** 因超时/额度未能送达、留待下次入站补发的结果 */
export interface OutboxItem {
  id: string;
  toUserId: string;
  text: string;
  kind: OutboxItemKind;
  createdAt: number;
  /** UTF-8 字节数，入队时计算（用于日志与 status） */
  bytes: number;
  /** 永久 / 未知失败次数 */
  failures: number;
  /** 瞬时失败次数 */
  transientFailures: number;
  /** 最近一次失败类别 */
  lastErrorKind?: string;
  /** 最近一次失败时间 */
  lastErrorAt?: number;
  /** 关联任务 id */
  taskId?: string;
}

/** 已判定为毒丸、不再自动补发的消息 */
export interface QuarantineItem extends OutboxItem {
  quarantinedAt: number;
  reason: string;
  /** 脱敏后的截断预览 */
  preview: string;
}

/** 下行额度连续告警状态 */
export interface QuotaState {
  /** 连续命中 ret=-2 的入站窗口数 */
  streak: number;
  /** 最近一次 ret=-2 的时间 */
  lastAt: number;
}

/** 最近一次任务失败记录，供 status 展示 */
export interface LastFailureRecord {
  /** 传输层类别，取自 QoderErrorKind */
  kind: string;
  /** 业务语义类别 */
  errorClass: QoderErrorClass;
  /** 归一化后的 error_code */
  errorCode?: string;
  /** 退出码；null 表示未知（超时 / 无法启动） */
  exitCode: number | null;
  /** 发生时间（毫秒时间戳） */
  at: number;
  /** 关联任务 id */
  taskId: string;
}

/** 持久化运行状态 */
export interface State {
  /** 状态版本 */
  version: number;
  /** getUpdates 游标，重启不丢消息 */
  getUpdatesBuf: string;
  sessions: Record<string, SessionRecord>;
  outbox: OutboxItem[];
  /** 隔离区，重启后不回到 outbox */
  quarantine: QuarantineItem[];
  /** 下行额度连续告警 */
  quota: QuotaState;
  /** 最近处理过的消息 id，用于去重 */
  seenMessageIds: string[];
  /** 微信用户 -> 指定的模型 id（缺省用配置里的默认模型） */
  models: Record<string, string>;
  /** 微信用户 -> 最近一次入站消息的 context_token，供主动提醒使用 */
  contextTokens: Record<string, string>;
  /** 最近一次任务失败；从未失败时为 null */
  lastFailure: LastFailureRecord | null;
}

/** 状态默认值 */
export const DEFAULT_STATE: State = {
  version: 2,
  getUpdatesBuf: '',
  sessions: {},
  outbox: [],
  quarantine: [],
  quota: { streak: 0, lastAt: 0 },
  seenMessageIds: [],
  models: {},
  contextTokens: {},
  lastFailure: null,
};

/**
 * 确保配置目录与状态目录存在
 */
export function ensureDirs(): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
}

/**
 * 原子写文件：先写临时文件再改名
 * @param filePath - 目标文件
 * @param content - 文本内容
 * @param mode - 文件权限
 */
function writeAtomic(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode });
  fs.renameSync(tmp, filePath);
}

/**
 * 读取配置：默认值 <- 配置文件 <- 环境变量
 * @returns 合并后的配置
 */
export function loadConfig(): Config {
  let fromFile: Partial<Config> = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Partial<Config>;
  } catch {
    // 首次运行没有配置文件
  }
  const merged: Config = { ...DEFAULT_CONFIG, ...fromFile };
  // errorDedupWindowMs 必须校验：NaN 会让去重窗口永不过期，用户首次失败后永久只收到 ack，
  // 是唯一一条把失败方向反转的配置路径。配置文件可能是手写的，值甚至不是 number
  const dedupWindow = Number(merged.errorDedupWindowMs);
  merged.errorDedupWindowMs =
    Number.isFinite(dedupWindow) && dedupWindow > 0 ? dedupWindow : DEFAULT_CONFIG.errorDedupWindowMs;
  for (const [key, envName, parse] of ENV_OVERRIDES) {
    const raw = process.env[envName];
    if (raw === undefined || raw === '') continue;
    (merged as unknown as Record<string, unknown>)[key] = parse(raw);
  }
  return merged;
}

/**
 * 保存配置（含 token，权限 600）
 * @param config - 要保存的配置
 */
export function saveConfig(config: Config): void {
  ensureDirs();
  writeAtomic(configPath(), JSON.stringify(config, null, 2), 0o600);
}

/**
 * 判断是否为普通对象
 * @param value - 任意值
 * @returns 是否为普通对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 读取数字字段，非法值回退
 * @param value - 原始值
 * @param fallback - 回退值
 * @returns 数字
 */
function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 把旧版 / 损坏的 outbox 项补齐为新结构
 * @param raw - 原始项
 * @returns 归一化后的项
 */
function normalizeOutboxItem(raw: Record<string, unknown>): OutboxItem {
  const text = typeof raw.text === 'string' ? raw.text : '';
  const createdAt = asNumber(raw.createdAt, Date.now());
  const kind: OutboxItemKind = raw.kind === 'notice' || raw.kind === 'error' ? raw.kind : 'reply';
  return {
    id: typeof raw.id === 'string' ? raw.id : `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    toUserId: typeof raw.toUserId === 'string' ? raw.toUserId : '',
    text,
    kind,
    createdAt,
    bytes: asNumber(raw.bytes, Buffer.byteLength(text, 'utf8')),
    failures: asNumber(raw.failures, asNumber(raw.attempts, 0)),
    transientFailures: asNumber(raw.transientFailures, 0),
    lastErrorKind: typeof raw.lastErrorKind === 'string' ? raw.lastErrorKind : undefined,
    lastErrorAt: typeof raw.lastErrorAt === 'number' ? raw.lastErrorAt : undefined,
    taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
  };
}

/**
 * 把旧版 / 损坏的隔离项补齐为新结构
 * @param raw - 原始项
 * @returns 归一化后的隔离项
 */
function normalizeQuarantineItem(raw: Record<string, unknown>): QuarantineItem {
  const base = normalizeOutboxItem(raw);
  return {
    ...base,
    quarantinedAt: asNumber(raw.quarantinedAt, base.createdAt),
    reason: typeof raw.reason === 'string' ? raw.reason : 'unknown',
    preview: typeof raw.preview === 'string' ? raw.preview : base.text.slice(0, 120),
  };
}

/** 合法的语义类别取值，用于拦截被手改坏的 state.json */
const ERROR_CLASSES: readonly QoderErrorClass[] = ['model_quota', 'output_limit', 'auth', 'unknown'];

/** 任务 id 长度上限；实际由 makeTaskId 生成，约 13 字符 */
const TASK_ID_MAX_CHARS = 64;

/**
 * 把任意值归一化为最近失败记录
 * @param raw - 原始值
 * @returns 归一化后的记录；不可用时为 null
 */
function normalizeLastFailure(raw: unknown): LastFailureRecord | null {
  if (!isRecord(raw)) return null;
  return {
    kind: typeof raw.kind === 'string' ? raw.kind : 'exit',
    errorClass: ERROR_CLASSES.find((value) => value === raw.errorClass) ?? 'unknown',
    // errorCode / taskId 会拼进 status 的纯文本行，与活路径共用同一套清洗（审查 N-1）；
    // kind 不参与渲染，故不清洗
    errorCode: sanitizeSingleLine(raw.errorCode, ERROR_CODE_MAX_CHARS),
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    at: asNumber(raw.at, 0),
    taskId: sanitizeSingleLine(raw.taskId, TASK_ID_MAX_CHARS) ?? '',
  };
}

/**
 * 把任意状态归一化为 v2
 * @param raw - 原始状态
 * @returns 归一化后的状态
 */
export function normalizeState(raw: Record<string, unknown>): State {
  const outbox = Array.isArray(raw.outbox) ? raw.outbox.filter(isRecord).map(normalizeOutboxItem) : [];
  const quarantine = Array.isArray(raw.quarantine)
    ? raw.quarantine.filter(isRecord).map(normalizeQuarantineItem)
    : [];
  const quotaRaw = isRecord(raw.quota) ? raw.quota : {};
  return {
    ...DEFAULT_STATE,
    ...raw,
    version: 2,
    outbox,
    quarantine,
    quota: {
      streak: asNumber(quotaRaw.streak, 0),
      lastAt: asNumber(quotaRaw.lastAt, 0),
    },
    sessions: isRecord(raw.sessions) ? (raw.sessions as Record<string, SessionRecord>) : {},
    seenMessageIds: Array.isArray(raw.seenMessageIds)
      ? raw.seenMessageIds.filter((value): value is string => typeof value === 'string')
      : [],
    models: isRecord(raw.models) ? (raw.models as Record<string, string>) : {},
    contextTokens: isRecord(raw.contextTokens) ? (raw.contextTokens as Record<string, string>) : {},
    lastFailure: normalizeLastFailure(raw.lastFailure),
  };
}

/**
 * 读取状态
 * @returns 归一化后的状态
 */
export function loadState(): State {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf-8')) as unknown;
    return normalizeState(isRecord(parsed) ? parsed : {});
  } catch {
    return normalizeState({});
  }
}

/**
 * 保存状态
 * @param state - 要保存的状态
 */
export function saveState(state: State): void {
  ensureDirs();
  writeAtomic(statePath(), JSON.stringify(state, null, 2), 0o600);
}

/**
 * 迁移旧版（项目内 data/config.json）配置到 XDG 目录，便于本地升级
 * @returns 是否发生了迁移
 */
export function migrateLegacyConfig(legacyPath: string): boolean {
  if (fs.existsSync(configPath()) || !fs.existsSync(legacyPath)) return false;
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as Partial<Config>;
    saveConfig({ ...DEFAULT_CONFIG, ...legacy });
    return true;
  } catch {
    return false;
  }
}
