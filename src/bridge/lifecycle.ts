/**
 * 桥接进程的生命周期控制：定位运行中的实例、识别监督方式、请求停止
 * @module bridge/lifecycle
 */
import { execFileSync } from 'node:child_process';
import { clearRunInfo, readRunInfo, type RunInfo } from '../config.js';

/** 发出停止信号后等待优雅退出的默认上限 */
const DEFAULT_WAIT_MS = 10_000;

/** 轮询进程是否退出的间隔 */
const POLL_MS = 200;

/** 桥接进程 */
export interface BridgeProcess {
  pid: number;
  command: string;
}

/** launchd 托管的桥接服务 */
export interface LaunchdService {
  pid: number;
  label: string;
  domain: string;
}

/** 停止结果 */
export type StopOutcome =
  | { kind: 'idle'; message: string }
  | { kind: 'stopped'; pids: number[]; waitedMs: number }
  | { kind: 'timeout'; pids: number[]; waitedMs: number }
  | { kind: 'supervised'; supervised: LaunchdService[]; extra: BridgeProcess[] }
  | { kind: 'conflict'; processes: BridgeProcess[]; detail: string }
  | { kind: 'permission'; pids: number[]; reason: string };

/** 停止决策 */
export type StopDecision =
  | { kind: 'idle'; staleRunInfo?: number }
  | { kind: 'signal'; pids: number[]; extra: BridgeProcess[]; staleRunInfo?: number }
  | { kind: 'supervised'; supervised: LaunchdService[]; extra: BridgeProcess[] }
  | { kind: 'conflict'; processes: BridgeProcess[]; detail: string };

/** 可注入依赖，便于单测 */
export interface StopDeps {
  readRunInfo?: () => RunInfo | null;
  isAlive?: (pid: number) => boolean;
  isBridgeProcess?: (pid: number) => boolean;
  listBridgeProcesses?: () => BridgeProcess[];
  findLaunchdServices?: () => LaunchdService[];
  clearRunInfo?: (expectedPid?: number) => void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** launchd 标签关键词 */
const LAUNCHD_LABEL_PATTERN = /(qoder.*wechat|qoder.*bridge|wechat.*bridge)/i;

/** shell 解释器名，含 `-c` 包装命令时不应被当成桥接进程 */
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh']);

/** 允许作为桥接进程首段的可执行文件名（JS 运行器、包管理器与 CLI 自身） */
const RUNTIME_NAMES = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'env',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'qoder-wechat',
  'qoder-wechat.js',
]);

/** 桥接入口脚本名 */
const BRIDGE_SCRIPTS = new Set(['qoder-wechat', 'qoder-wechat.js', 'cli.js']);

/**
 * 判断 cli.js 是否位于 `dist/` 下，避免把别的项目的 cli.js 当成本包进程
 * @param token - 脚本路径片段
 * @returns 是否位于 dist 目录
 */
function isDistScript(token: string): boolean {
  const segments = token.split(/[\\/]/).filter(Boolean);
  const parent = segments[segments.length - 2];
  return parent !== undefined && parent.toLowerCase() === 'dist';
}

/**
 * 取可执行文件 basename，兼容 Windows 路径与 .exe
 * @param token - 命令行片段
 * @returns basename
 */
function basename(token: string): string {
  const name = token.split(/[\\/]/).pop() ?? token;
  return name.replace(/\.exe$/i, '').toLowerCase();
}

/**
 * 判断命令行是否为桥接 run 进程
 *
 * 只看真正的 argv 首段，避免把 `zsh -c "... node dist/cli.js run ..."` 这类
 * 包装命令误判成第二个实例；桥接脚本之后的第一个非选项 token 必须恰好是 `run`，
 * 因此 `node --inspect`、`env node`、`npm exec` 等前缀形态都能识别。
 * @param command - 进程命令行
 * @returns 是否匹配
 */
function isBridgeCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first) return false;
  const executable = basename(first);
  if (SHELL_NAMES.has(executable)) return false;
  if (!RUNTIME_NAMES.has(executable)) return false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || !BRIDGE_SCRIPTS.has(basename(token))) continue;
    if (basename(token) === 'cli.js' && !isDistScript(token)) continue;
    const next = tokens.slice(i + 1).find((item) => !item.startsWith('-'));
    return next === 'run';
  }
  return false;
}

/**
 * 实例归属信息（与 instance-lock 的 LockRecord 结构兼容，避免循环依赖）
 */
export interface InstanceOwner {
  /** 实例 pid */
  pid: number;
  /** 该实例使用的状态目录 */
  stateDir: string;
  /** 启动时间 */
  startedAt: string;
  /** 启动时的工作目录 */
  cwd?: string;
}

/**
 * 生成"实例已在运行"的中文说明
 * @param owner - 持有实例锁的进程信息
 * @param launchdLabelValue - launchd 标签；非托管为 null
 * @returns 可直接输出的多行文本
 */
export function describeOwner(owner: InstanceOwner, launchdLabelValue: string | null): string {
  const lines = [
    `已在运行：pid ${owner.pid}${launchdLabelValue ? `（launchd：${launchdLabelValue}）` : ''}`,
    `状态目录：${owner.stateDir || '(未知)'}`,
    `启动时间：${owner.startedAt || '(未知)'}`,
    `工作目录：${owner.cwd || '(未知)'}`,
  ];
  if (launchdLabelValue) {
    lines.push('该实例由 launchd 托管，KeepAlive 会自动拉起。如需重启：');
    lines.push('  qoder-wechat stop');
    lines.push('（launchd 托管的实例需要按 stop 输出里的 bootout 命令操作）');
  } else {
    lines.push('如需重启：');
    lines.push('  qoder-wechat stop && qoder-wechat run');
  }
  return lines.join('\n');
}

/**
 * 判断进程是否存活
 * @param pid - 目标进程 id
 * @returns 进程存在返回 true（存在但无权限访问也算存在）
 */
export function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 查询 launchd 中托管该进程的服务标签
 * @param pid - 目标进程 id
 * @returns 服务标签；非 macOS 或由 launchd 之外的方式启动时返回 null
 */
export function launchdLabel(pid: number): string | null {
  if (process.platform !== 'darwin') return null;
  let output: string;
  try {
    output = execFileSync('launchctl', ['list'], { encoding: 'utf-8' });
  } catch {
    return null;
  }
  for (const line of output.split('\n')) {
    const [pidColumn, , label] = line.split('\t');
    if (label && Number(pidColumn) === pid) return label.trim();
  }
  return null;
}

/**
 * 解析 ps 输出
 * @param text - ps 输出
 * @returns 桥接进程列表
 */
export function parsePsOutput(text: string): BridgeProcess[] {
  const processes: BridgeProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]?.trim() ?? '';
    if (pid > 0 && isBridgeCommand(command)) processes.push({ pid, command });
  }
  return processes;
}

/**
 * 列出命令行匹配桥接 run 的进程
 * @param platform - 当前平台
 * @returns 进程列表
 */
export function listBridgeProcesses(platform: NodeJS.Platform = process.platform): BridgeProcess[] {
  if (platform === 'win32') return [];
  try {
    const args = platform === 'linux' ? ['-eo', 'pid=,args='] : ['-axo', 'pid=,command='];
    return parsePsOutput(execFileSync('ps', args, { encoding: 'utf-8' }));
  } catch {
    return [];
  }
}

/**
 * 校验 pid 是否真的是桥接 run 进程
 * @param pid - 进程 id
 * @param platform - 当前平台
 * @returns 是否匹配
 */
export function isBridgeProcess(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32' || pid <= 0) return false;
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
    return isBridgeCommand(output);
  } catch {
    return false;
  }
}

/**
 * 解析 launchctl list 输出
 * @param text - launchctl list 输出
 * @param domain - launchd domain
 * @returns 桥接服务列表
 */
export function parseLaunchctlList(text: string, domain = 'gui/0'): LaunchdService[] {
  const services: LaunchdService[] = [];
  for (const line of text.split(/\r?\n/)) {
    const columns = line.split('\t');
    if (columns.length < 3) continue;
    const pidColumn = columns[0]?.trim() ?? '';
    const label = columns[2]?.trim() ?? '';
    if (!label || !LAUNCHD_LABEL_PATTERN.test(label)) continue;
    const pid = /^\d+$/.test(pidColumn) ? Number(pidColumn) : 0;
    services.push({ pid, label, domain });
  }
  return services;
}

/**
 * 查找 launchd 中的桥接服务（不依赖 run.json）
 * @param platform - 当前平台
 * @returns 桥接服务列表
 */
export function findLaunchdServices(platform: NodeJS.Platform = process.platform): LaunchdService[] {
  if (platform !== 'darwin') return [];
  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  try {
    return parseLaunchctlList(execFileSync('launchctl', ['list'], { encoding: 'utf-8' }), domain);
  } catch {
    return [];
  }
}

/**
 * 根据发现结果制定停止决策
 * @param input - 运行记录、进程与 launchd 发现结果
 * @returns 停止决策
 */
export function planStop(input: {
  runInfo: RunInfo | null;
  runInfoAlive: boolean;
  runInfoIsBridge: boolean;
  processes: BridgeProcess[];
  launchd: LaunchdService[];
}): StopDecision {
  const validRunInfo = input.runInfo && input.runInfoAlive && input.runInfoIsBridge ? input.runInfo : null;
  const staleRunInfo = input.runInfo && !validRunInfo ? input.runInfo.pid : undefined;
  const supervisedPids = new Set(input.launchd.map((service) => service.pid).filter((pid) => pid > 0));
  const extra = input.processes.filter((process) => !supervisedPids.has(process.pid));

  if (input.launchd.length > 0) {
    return { kind: 'supervised', supervised: input.launchd, extra };
  }

  const all = input.processes.slice();
  if (validRunInfo && !all.some((process) => process.pid === validRunInfo.pid)) {
    all.unshift({ pid: validRunInfo.pid, command: 'qoder-wechat run（run.json）' });
  }

  if (all.length === 0) return { kind: 'idle', staleRunInfo };

  if (validRunInfo) {
    const primary = all.find((process) => process.pid === validRunInfo.pid);
    if (primary) {
      return {
        kind: 'signal',
        pids: [primary.pid],
        extra: all.filter((process) => process.pid !== primary.pid),
        staleRunInfo,
      };
    }
  }

  if (all.length === 1) {
    return { kind: 'signal', pids: [all[0]!.pid], extra: [], staleRunInfo };
  }

  return { kind: 'conflict', processes: all, detail: '发现多个桥接实例，未自动停止' };
}

/**
 * 停止运行中的桥接服务
 *
 * launchd 托管的实例不会被发送信号：`KeepAlive` 会在数十秒内把它重新拉起，
 * 发信号只会让任务中断得更难排查，因此只返回可直接执行的 bootout 命令。
 * @param waitMs - 发出 SIGTERM 后等待优雅退出的上限
 * @param deps - 可注入依赖
 * @returns 停止结果
 */
export async function stopService(waitMs = DEFAULT_WAIT_MS, deps: StopDeps = {}): Promise<StopOutcome> {
  const readInfo = deps.readRunInfo ?? readRunInfo;
  const alive = deps.isAlive ?? isAlive;
  const bridge = deps.isBridgeProcess ?? isBridgeProcess;
  const listProcesses = deps.listBridgeProcesses ?? listBridgeProcesses;
  const findLaunchd = deps.findLaunchdServices ?? findLaunchdServices;
  const clear = deps.clearRunInfo ?? clearRunInfo;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals): void => void process.kill(pid, signal));
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const info = readInfo();
  const runInfoAlive = info ? alive(info.pid) : false;
  const runInfoIsBridge = info && runInfoAlive ? bridge(info.pid) : false;
  const decision = planStop({
    runInfo: info,
    runInfoAlive,
    runInfoIsBridge,
    processes: listProcesses(),
    launchd: findLaunchd(),
  });

  if (decision.kind === 'idle') {
    if (decision.staleRunInfo !== undefined) clear(decision.staleRunInfo);
    return {
      kind: 'idle',
      message:
        decision.staleRunInfo !== undefined
          ? `运行记录里的 pid ${decision.staleRunInfo} 已失效，记录已清理`
          : '没有运行中的桥接服务',
    };
  }

  if (decision.kind === 'conflict') {
    return { kind: 'conflict', processes: decision.processes, detail: decision.detail };
  }

  if (decision.kind === 'supervised') {
    return { kind: 'supervised', supervised: decision.supervised, extra: decision.extra };
  }

  const pids = decision.pids;
  try {
    for (const pid of pids) kill(pid, 'SIGTERM');
  } catch (err) {
    return { kind: 'permission', pids, reason: err instanceof Error ? err.message : String(err) };
  }

  const startedAt = now();
  while (pids.some((pid) => alive(pid)) && now() - startedAt < waitMs) {
    await sleep(POLL_MS);
  }
  const stillAlive = pids.filter((pid) => alive(pid));
  if (stillAlive.length > 0) {
    return { kind: 'timeout', pids: stillAlive, waitedMs: now() - startedAt };
  }

  if (decision.staleRunInfo !== undefined) clear(decision.staleRunInfo);
  if (info && pids.includes(info.pid)) clear(info.pid);

  const extraAlive = decision.extra.filter((process) => alive(process.pid));
  if (extraAlive.length > 0) {
    return { kind: 'conflict', processes: extraAlive, detail: '主实例已停止，但仍存在其它桥接实例' };
  }

  return { kind: 'stopped', pids, waitedMs: now() - startedAt };
}

/**
 * 生成 stop 的终端输出
 * @param outcome - 停止结果
 * @returns 可读文本
 */
export function formatStopOutcome(outcome: StopOutcome): string {
  switch (outcome.kind) {
    case 'idle':
      return outcome.message;
    case 'stopped':
      return `桥接服务已停止（pid ${outcome.pids.join(', ')}，等待 ${outcome.waitedMs}ms）`;
    case 'timeout':
      return [
        `停止信号已发出，但 pid ${outcome.pids.join(', ')} 在 ${outcome.waitedMs}ms 内没有退出`,
        '再执行一次 stop，目标进程收到第二次信号会立即结束',
      ].join('\n');
    case 'supervised': {
      const lines: string[] = [`桥接服务由 launchd 托管（${outcome.supervised.length} 个实例）`, ''];
      for (const service of outcome.supervised) {
        lines.push(`pid ${service.pid}，标签 ${service.label}`);
        lines.push(`  launchctl bootout ${service.domain}/${service.label}`);
        lines.push('');
      }
      lines.push('KeepAlive 会重新拉起，必须手动执行上面的 bootout。');
      lines.push('验证是否已停止：');
      for (const service of outcome.supervised) {
        lines.push(`  launchctl print ${service.domain}/${service.label}`);
      }
      lines.push('  pgrep -fl "qoder-wechat run"');
      lines.push('恢复自启：');
      for (const service of outcome.supervised) {
        lines.push(`  launchctl bootstrap ${service.domain} <plist 路径>`);
      }
      lines.push('兜底（bootout 不可用时，KeepAlive 可能重新拉起）：');
      lines.push('  pkill -TERM -f "qoder-wechat run"');
      if (outcome.extra.length > 0) {
        lines.push('', '其它桥接实例：');
        for (const process of outcome.extra) {
          lines.push(`  pid ${process.pid}：kill -TERM ${process.pid}`);
        }
      }
      return lines.join('\n');
    }
    case 'conflict': {
      const lines = [outcome.detail, '冲突实例：'];
      for (const process of outcome.processes) {
        lines.push(`  pid ${process.pid}：kill -TERM ${process.pid}`);
        lines.push(`    ${process.command}`);
      }
      return lines.join('\n');
    }
    case 'permission': {
      const lines = [`无法停止桥接服务：${outcome.reason}`, '请手动执行：'];
      for (const pid of outcome.pids) lines.push(`  kill -TERM ${pid}`);
      return lines.join('\n');
    }
  }
}

/**
 * stop 命令的退出码
 * @param outcome - 停止结果
 * @returns 退出码
 */
export function stopExitCode(outcome: StopOutcome): number {
  switch (outcome.kind) {
    case 'idle':
    case 'stopped':
      return 0;
    case 'timeout':
      return 1;
    default:
      return 2;
  }
}
