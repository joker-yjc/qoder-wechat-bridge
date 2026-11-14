/**
 * 命令处理器接口：注册表插件化的共享类型
 * @module bridge/commands/types
 */
import type { Config, State } from '../../config.js';
import type { log } from '../../log.js';
import type { listModels } from '../../models.js';
import type { SessionEntry, deleteSession, listSessions, renameSession } from '../sessions.js';

/** 一条内置命令的元数据（/help 与 isUnknownCommand 的单一事实来源） */
export interface CommandDef {
  /** 命令名，含斜杠 */
  name: string;
  /** 用法示例 */
  usage: string;
  /** 一句话说明 */
  description: string;
}

/** /delete 两步确认的待确认记录（内存态，60s 过期） */
export interface PendingDelete {
  /** 目标会话 id */
  sessionId: string;
  /** 目标显示名 */
  name: string;
  /** 第一步解析时的 CLI 序号（确认时按 id 重新取当前序号防漂移） */
  index: number;
  /** 过期时间戳 */
  expiresAt: number;
}

/** 处理器运行所需上下文，由 processTask 组装 */
export interface CommandContext {
  /** 发起命令的微信用户 id */
  userId: string;
  /** 本条入站的 context_token */
  contextToken: string;
  /** 持久化运行状态 */
  state: State;
  /** 当前生效配置 */
  config: Config;
  /** 统一回复（内部走 OutboundSession，计入下行额度） */
  reply: (text: string) => Promise<void>;
  /** 桥接工作目录 */
  workdir: () => string;
  /** 原子保存状态 */
  persistState: () => void;
  /** 每用户最近一次 /sessions 清单缓存（序号稳定性） */
  catalogs: Map<string, SessionEntry[]>;
  /** 每用户 /new 记录的待用显示名 */
  pendingNames: Map<string, string>;
  /** 每用户 /delete 第一步留下的待确认删除 */
  pendingDeletes: Map<string, PendingDelete>;
  /** 该用户是否有正在执行的任务 */
  isTaskRunning: (userId: string) => boolean;
  /** 可注入依赖，便于单测 */
  deps: {
    listSessions: typeof listSessions;
    renameSession: typeof renameSession;
    deleteSession: typeof deleteSession;
    listModels: typeof listModels;
  };
  /** 结构化日志 */
  log: typeof log;
}

/** 一条命令处理器 */
export interface CommandHandler {
  /** 元数据 */
  def: CommandDef;
  /** 是否接受尾随参数；零参命令（/help /reset /status /sessions）仅精确匹配，带参数交回 Qoder */
  acceptsArgs?: boolean;
  /** 变更类命令标 true：任务运行中由 intake 拒绝 */
  requiresIdle?: boolean;
  /**
   * 匹配并处理命令
   * @param ctx - 运行上下文
   * @param text - 原始命令文本
   * @returns true=已处理（含错误回复），false=不匹配
   */
  handle: (ctx: CommandContext, text: string) => Promise<boolean>;
}