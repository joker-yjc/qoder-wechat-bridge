/**
 * 库入口：既可直接运行 CLI，也可被其他程序以编程方式调用
 * @module index
 */
export {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  clearRunInfo,
  configDir,
  configPath,
  ensureDirs,
  loadConfig,
  loadState,
  migrateLegacyConfig,
  normalizeState,
  readRunInfo,
  runInfoPath,
  saveConfig,
  saveState,
  stateDir,
  statePath,
  writeRunInfo,
} from './config.js';
export type {
  Config,
  OutboxItem,
  OutboxItemKind,
  QuarantineItem,
  QuotaState,
  RunInfo,
  SessionRecord,
  State,
} from './config.js';

export { login } from './weixin/login.js';
export type { LoginResult } from './weixin/login.js';

/** 微信通道能力（收发消息、扫码状态、typing） */
export * as weixin from './weixin/client.js';
/** iLink 协议类型与常量 */
export * as protocol from './weixin/types.js';
export { BridgeSendError, classifySendError } from './weixin/errors.js';
export type { SendFailureKind } from './weixin/errors.js';

export {
  findLaunchdServices,
  formatStopOutcome,
  isAlive,
  isBridgeProcess,
  launchdLabel,
  listBridgeProcesses,
  parseLaunchctlList,
  parsePsOutput,
  planStop,
  stopExitCode,
  stopService,
} from './bridge/lifecycle.js';
export type {
  BridgeProcess,
  LaunchdService,
  StopDecision,
  StopDeps,
  StopOutcome,
} from './bridge/lifecycle.js';

export { cleanEnv, runQoder } from './bridge/qoder.js';
export type { QoderRunInput, QoderRunResult } from './bridge/qoder.js';
export { flushOutbox, pruneOutbox, pushOutbox, quarantineItem } from './bridge/outbox.js';
export type { DeliveryOutcome, FlushResult, OutboxPolicy, PruneResult } from './bridge/outbox.js';
export { buildUserErrorReply, truncateGraphemes } from './bridge/failure.js';
export type { QoderErrorKind } from './bridge/failure.js';
export { detectNodeChange, nodeFingerprint, runPreflight } from './bridge/preflight.js';
export type { NodeFingerprint, PreflightDeps, PreflightFailureKind, PreflightResult } from './bridge/preflight.js';
export { OutboundSession } from './bridge/outbound.js';
export type {
  EnqueueOptions,
  OutboundSend,
  OutboundSendResult,
  OutboundSessionOptions,
  SendSingleOutcome,
} from './bridge/outbound.js';
export { chunkText } from './bridge/reply.js';
export { runService } from './bridge/service.js';
export type { BridgeHandle } from './bridge/service.js';

export { formatModelList, listModels, resolveModel } from './models.js';
export type { ModelOption } from './models.js';

export { COMMANDS, formatHelp, isUnknownCommand } from './commands.js';
export type { CommandDef } from './commands.js';

export { log, setLevel } from './log.js';

export { buildStatusLines, formatAge, formatBytes } from './status.js';
export type { StatusContext } from './status.js';

export { pruneDiagnostics, redactSensitive, writeDiagnostic } from './diagnostics.js';
export type { DiagnosticInput, DiagnosticOptions } from './diagnostics.js';

export { notify, pendingFilePath, takePending } from './notify.js';
export type { NotifyResult, PendingNotice } from './notify.js';

export { loadPersona, MAX_PERSONA_BYTES } from './persona.js';

export { sendMediaFile, sendVoiceFromText } from './weixin/send-media.js';
export type { MediaKind, SendMediaResult, SendVoiceResult } from './weixin/send-media.js';
