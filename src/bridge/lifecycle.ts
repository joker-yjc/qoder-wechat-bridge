/**
 * 桥接进程的生命周期控制：定位运行中的实例、识别监督方式、请求停止
 * @module bridge/lifecycle
 */
import { execFileSync } from 'node:child_process';
import { clearRunInfo, readRunInfo } from '../config.js';

/** 发出停止信号后等待优雅退出的默认上限 */
const DEFAULT_WAIT_MS = 10_000;

/** 轮询进程是否退出的间隔 */
const POLL_MS = 200;

/** 停止请求的结果 */
export type StopOutcome =
  /** 没有运行中的服务，或运行记录已过期被清理 */
  | { kind: 'idle'; message: string }
  /** 进程由 launchd 托管，发信号会被重新拉起，只返回停止命令 */
  | { kind: 'supervised'; pid: number; label: string; domain: string }
  /** 已优雅退出 */
  | { kind: 'stopped'; pid: number; waitedMs: number }
  /** 信号已发出但超时未退出 */
  | { kind: 'timeout'; pid: number; waitedMs: number };

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
 * 停止运行中的桥接服务
 *
 * launchd 托管的实例不会被发送信号：`KeepAlive` 会在数十秒内把它重新拉起，
 * 发信号只会让任务中断得更难排查，因此只返回可直接执行的 bootout 命令。
 * @param waitMs - 发出 SIGTERM 后等待优雅退出的上限
 * @returns 停止结果
 * @example
 * const result = await stopService();
 */
export async function stopService(waitMs = DEFAULT_WAIT_MS): Promise<StopOutcome> {
  const info = readRunInfo();
  if (!info) {
    return { kind: 'idle', message: '没有运行记录，桥接服务应该没在跑' };
  }
  if (!isAlive(info.pid)) {
    clearRunInfo(info.pid);
    return { kind: 'idle', message: `运行记录里的 pid ${info.pid} 已不存在，记录已清理` };
  }

  const label = launchdLabel(info.pid);
  if (label) {
    const uid = process.getuid?.() ?? 0;
    return { kind: 'supervised', pid: info.pid, label, domain: `gui/${uid}` };
  }

  const startedAt = Date.now();
  process.kill(info.pid, 'SIGTERM');
  while (Date.now() - startedAt < waitMs) {
    if (!isAlive(info.pid)) {
      clearRunInfo(info.pid);
      return { kind: 'stopped', pid: info.pid, waitedMs: Date.now() - startedAt };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return { kind: 'timeout', pid: info.pid, waitedMs: Date.now() - startedAt };
}
