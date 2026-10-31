/**
 * 库入口：既可直接运行 CLI，也可被其他程序以编程方式调用
 * @module index
 */
export {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  configDir,
  configPath,
  ensureDirs,
  loadConfig,
  loadState,
  migrateLegacyConfig,
  saveConfig,
  saveState,
  stateDir,
  statePath,
} from './config.js';
export type { Config, OutboxItem, SessionRecord, State } from './config.js';

export { login } from './weixin/login.js';
export type { LoginResult } from './weixin/login.js';

/** 微信通道能力（收发消息、扫码状态、typing） */
export * as weixin from './weixin/client.js';
/** iLink 协议类型与常量 */
export * as protocol from './weixin/types.js';

export { cleanEnv, runQoder } from './bridge/qoder.js';
export type { QoderRunInput, QoderRunResult } from './bridge/qoder.js';
export { chunkText } from './bridge/reply.js';
export { runService } from './bridge/service.js';
export type { BridgeHandle } from './bridge/service.js';

export { formatModelList, listModels, resolveModel } from './models.js';
export type { ModelOption } from './models.js';

export { COMMANDS, formatHelp, isUnknownCommand } from './commands.js';
export type { CommandDef } from './commands.js';

export { log, setLevel } from './log.js';

export { notify, pendingFilePath, takePending } from './notify.js';
export type { NotifyResult, PendingNotice } from './notify.js';
