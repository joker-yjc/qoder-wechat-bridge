/**
 * status 输出：把配置与运行状态格式化为终端文本
 * @module status
 */
import type { Config, State } from './config.js';

/** status 上下文 */
export interface StatusContext {
  configFile: string;
  stateFile: string;
  personaInfo: string;
  inbox: { bytes: number; files: number };
  home: string;
}

/**
 * 人类可读的字节数
 * @param bytes - 字节
 * @returns 形如 1.2MB
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/**
 * 人类可读的时长
 * @param ms - 毫秒
 * @returns 形如 2 小时
 */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/**
 * 生成 status 文本
 * @param config - 配置
 * @param state - 状态
 * @param context - 路径与附件信息
 * @returns 终端输出行
 */
export function buildStatusLines(config: Config, state: State, context: StatusContext): string[] {
  const oldest = state.outbox.reduce((min, item) => Math.min(min, item.createdAt), Number.POSITIVE_INFINITY);
  const outboxBytes = state.outbox.reduce((sum, item) => sum + item.bytes, 0);
  const queueLine =
    state.outbox.length === 0
      ? '待补发：0 条'
      : `待补发：${state.outbox.length} 条（最旧 ${formatAge(Date.now() - oldest)}前，共 ${formatBytes(outboxBytes)}）`;
  const quotaLine =
    state.quota.streak > 0
      ? `下行额度：上次 ret=-2 于 ${new Date(state.quota.lastAt).toLocaleString('zh-CN', { hour12: false })}（连续 ${state.quota.streak} 个窗口）`
      : '下行额度：正常';

  return [
    `配置：${context.configFile}`,
    `状态：${context.stateFile}`,
    `iLink：${config.baseUrl}`,
    `Token：${config.token ? '已配置' : '未配置'}`,
    `机器人 ID：${config.botId || '(未登录)'}`,
    `授权账号：${config.ownerUserId || '(未设置)'}${config.allowFrom.length ? ` + ${config.allowFrom.length} 个白名单` : ''}`,
    `工作目录：${config.cwd.trim() || `${context.home}（全局）`}`,
    `权限模式：${config.permissionMode}`,
    `人设：${context.personaInfo}`,
    `附件目录：${config.inboxDir}（${formatBytes(context.inbox.bytes)}，${context.inbox.files} 个文件）`,
    `会话数：${Object.keys(state.sessions).length}`,
    queueLine,
    `隔离区：${state.quarantine.length} 条`,
    quotaLine,
  ];
}
