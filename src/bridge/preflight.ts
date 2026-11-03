/**
 * 启动本地预检：Node 版本、qodercli 可执行与版本、Node 指纹变化
 * @module bridge/preflight
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 预检失败类别 */
export type PreflightFailureKind = 'node_version' | 'qoder_missing' | 'qoder_version';

/** 预检结果 */
export interface PreflightResult {
  ok: boolean;
  node: { version: string; major: number; execPath: string; ino: number; mtimeMs: number };
  qodercli: { path: string; version: string } | null;
  failures: Array<{ kind: PreflightFailureKind; detail: string }>;
}

/** 可注入依赖，便于单测 */
export interface PreflightDeps {
  nodeVersion?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
  statFile?: (file: string) => { ino: number; mtimeMs: number };
  resolveBin?: (bin: string) => string | null;
  runVersion?: (bin: string, timeoutMs: number) => Promise<string | null>;
}

/** Node 指纹 */
export interface NodeFingerprint {
  path: string;
  ino: number;
  mtimeMs: number;
  version: string;
}

/**
 * 默认的文件 stat
 * @param file - 文件路径
 * @returns inode 与 mtime
 */
function defaultStat(file: string): { ino: number; mtimeMs: number } {
  const stat = fs.statSync(file);
  return { ino: stat.ino, mtimeMs: stat.mtimeMs };
}

/**
 * 解析可执行文件路径
 * @param bin - 配置的 qodercli 路径或命令名
 * @param platform - 当前平台
 * @returns 绝对路径；找不到时为 null
 */
function defaultResolveBin(bin: string, platform: NodeJS.Platform): string | null {
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  try {
    const command = platform === 'win32' ? 'where' : 'which';
    const output = execFileSync(command, [bin], { encoding: 'utf-8' });
    const first = output.split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/**
 * 执行 qodercli --version
 * @param bin - qodercli 路径
 * @param timeoutMs - 超时
 * @returns 版本字符串；失败或超时为 null
 */
function defaultRunVersion(bin: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const first = String(stdout).split(/\r?\n/)[0]?.trim();
      resolve(first || null);
    });
  });
}

/**
 * 记录当前 Node 二进制指纹
 * @param deps - 可注入依赖
 * @returns 指纹
 */
export function nodeFingerprint(deps: PreflightDeps = {}): NodeFingerprint {
  const execPath = deps.execPath ?? process.execPath;
  const version = deps.nodeVersion ?? process.versions.node;
  const statFile = deps.statFile ?? defaultStat;
  try {
    const stat = statFile(execPath);
    return { path: execPath, ino: stat.ino, mtimeMs: stat.mtimeMs, version };
  } catch {
    return { path: execPath, ino: 0, mtimeMs: 0, version };
  }
}

/**
 * 检测 Node 指纹变化
 * @param prev - 上次指纹
 * @param next - 当前指纹
 * @returns 变化原因；无变化时为 null
 */
export function detectNodeChange(prev: NodeFingerprint, next: NodeFingerprint): string | null {
  if (prev.path !== next.path) return 'path';
  if (prev.ino !== next.ino) return 'inode';
  if (prev.version !== next.version) return 'version';
  return null;
}

/**
 * 执行启动预检
 * @param input - qodercli 路径与版本超时
 * @returns 预检结果
 */
export async function runPreflight(input: {
  qoderBin: string;
  versionTimeoutMs: number;
  deps?: PreflightDeps;
}): Promise<PreflightResult> {
  const deps = input.deps ?? {};
  const platform = deps.platform ?? process.platform;
  const fingerprint = nodeFingerprint(deps);
  const major = Number.parseInt(fingerprint.version.split('.')[0] ?? '0', 10) || 0;
  const node = {
    version: fingerprint.version,
    major,
    execPath: fingerprint.path,
    ino: fingerprint.ino,
    mtimeMs: fingerprint.mtimeMs,
  };
  const failures: PreflightResult['failures'] = [];

  if (major < 20) {
    failures.push({ kind: 'node_version', detail: `Node ${fingerprint.version} 低于 20` });
  }

  const resolveBin = deps.resolveBin ?? ((bin: string) => defaultResolveBin(bin, platform));
  const resolved = resolveBin(input.qoderBin);
  if (!resolved) {
    failures.push({ kind: 'qoder_missing', detail: `找不到可执行的 ${input.qoderBin}` });
    return { ok: false, node, qodercli: null, failures };
  }

  const runVersion = deps.runVersion ?? defaultRunVersion;
  const version = await runVersion(resolved, input.versionTimeoutMs);
  if (!version) {
    failures.push({ kind: 'qoder_version', detail: `${resolved} --version 失败或超时` });
    return { ok: false, node, qodercli: null, failures };
  }

  return {
    ok: failures.length === 0,
    node,
    qodercli: { path: resolved, version },
    failures,
  };
}
