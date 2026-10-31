/**
 * 配置与运行状态：遵循 XDG 目录规范，支持 QWB_* 环境变量覆盖
 * @module config
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  qoderTimeoutMs: 10 * 60_000,
  typingKeepAliveMs: 5_000,
  maxReplyChars: 2_000,
  maxRepliesPerTurn: 9,
  pollTimeoutMs: 35_000,
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
  ['qoderTimeoutMs', 'QWB_TIMEOUT_MS', (v) => Number(v)],
  ['maxReplyChars', 'QWB_MAX_REPLY_CHARS', (v) => Number(v)],
  ['maxRepliesPerTurn', 'QWB_MAX_REPLIES', (v) => Number(v)],
];

/** 某个微信用户对应的 Qoder 会话 */
export interface SessionRecord {
  sessionId: string;
  updatedAt: number;
  turns: number;
}

/** 因超时/额度未能送达、留待下次入站补发的结果 */
export interface OutboxItem {
  id: string;
  toUserId: string;
  text: string;
  createdAt: number;
  attempts: number;
}

/** 持久化运行状态 */
export interface State {
  /** getUpdates 游标，重启不丢消息 */
  getUpdatesBuf: string;
  sessions: Record<string, SessionRecord>;
  outbox: OutboxItem[];
  /** 最近处理过的消息 id，用于去重 */
  seenMessageIds: string[];
  /** 微信用户 -> 指定的模型 id（缺省用配置里的默认模型） */
  models: Record<string, string>;
  /** 微信用户 -> 最近一次入站消息的 context_token，供主动提醒使用 */
  contextTokens: Record<string, string>;
}

/** 状态默认值 */
export const DEFAULT_STATE: State = {
  getUpdatesBuf: '',
  sessions: {},
  outbox: [],
  seenMessageIds: [],
  models: {},
  contextTokens: {},
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
 * 读取状态
 * @returns 合并后的状态
 */
export function loadState(): State {
  try {
    const raw = fs.readFileSync(statePath(), 'utf-8');
    return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<State>) };
  } catch {
    return { ...DEFAULT_STATE };
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
