/**
 * 实例互斥：状态目录锁 + bot 级锁
 * 用 O_CREAT|O_EXCL 原子占锁，靠 pid 存活与进程特征接管陈旧锁
 * @module bridge/instance-lock
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { isAlive, isBridgeProcess, launchdLabel } from './lifecycle.js';

/** 默认等待窗口，覆盖 launchd 重启重叠 */
const DEFAULT_WAIT_MS = 5_000;

/** 等待重试间隔 */
const DEFAULT_POLL_MS = 250;

/** 连续清理陈旧锁的最大次数 */
const MAX_DIRTY_RETRIES = 3;

/** 锁的类型 */
export type LockRole = 'state' | 'bot';

/** 锁文件内容 */
export interface LockRecord {
  /** 持锁进程 id */
  pid: number;
  /** 父进程 id */
  ppid: number;
  /** 获取锁的时间（ISO 字符串） */
  startedAt: string;
  /** 启动时的工作目录 */
  cwd: string;
  /** 机器人账号 id；状态锁为空串 */
  botId: string;
  /** 该实例使用的状态目录 */
  stateDir: string;
  /** 锁类型 */
  role: LockRole;
}

/** 锁句柄 */
export interface LockHandle {
  /** 幂等释放；只删除内容 pid 等于自身 pid 的锁文件 */
  release: () => void;
  /** 当前持有的锁文件路径 */
  paths: string[];
}

/** 获取锁的参数 */
export interface AcquireLockInput {
  /** 状态目录（状态锁所在目录） */
  stateDir: string;
  /** 机器人账号 id；空串表示跳过 bot 锁 */
  botId: string;
  /** 只取某一层锁；默认两层都取 */
  mode?: 'both' | 'state' | 'bot';
  /** 等待存活实例退出的上限 */
  waitMs?: number;
  /** 绝对截止时间；两阶段传同一个值可保证总等待不超过上限 */
  deadline?: number;
  /** 重试间隔 */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  isBridgeProcess?: (pid: number) => boolean;
  now?: () => number;
}

/** 已有存活实例 */
export class AlreadyRunningError extends Error {
  /**
   * @param owner - 锁记录的持有者
   * @param launchdLabelValue - launchd 标签；非托管为 null
   * @param waitedMs - 实际等待时长
   * @param lockFile - 造成冲突的锁文件或运行记录路径，便于人工处置
   */
  constructor(
    readonly owner: LockRecord,
    readonly launchdLabelValue: string | null,
    readonly waitedMs: number,
    readonly lockFile = '',
  ) {
    super(`已在运行：pid ${owner.pid}`);
    this.name = 'AlreadyRunningError';
  }
}

/** 锁文件无法创建/读取（fail-closed） */
export class LockIoError extends Error {
  /**
   * @param path - 出错的锁文件路径
   * @param code - 系统错误码或内部标记
   * @param detail - 可读说明
   */
  constructor(
    readonly path: string,
    readonly code: string,
    detail: string,
  ) {
    super(`无法使用实例锁：${detail}（${code}）：${path}`);
    this.name = 'LockIoError';
  }
}

/**
 * 状态目录锁路径
 * @param stateDir - 状态目录
 * @returns 锁文件绝对路径
 */
export function stateLockPath(stateDir: string): string {
  return path.join(stateDir, 'run.lock');
}

/**
 * 本机跨状态目录的实例登记目录
 * 固定在家目录下，不随 QWB_STATE_DIR 变化，否则跨目录检测失效
 * @returns 目录绝对路径
 */
export function globalInstancesDir(): string {
  return path.join(os.homedir(), '.local', 'state', 'qoder-wechat-bridge', 'instances');
}

/**
 * bot 级锁路径（按 botId 哈希命名，避免路径字符问题）
 * @param botId - 机器人账号 id
 * @returns 锁文件绝对路径
 */
export function botLockPath(botId: string): string {
  const key = crypto.createHash('sha1').update(botId).digest('hex').slice(0, 16);
  return path.join(globalInstancesDir(), `${key}.lock`);
}

/**
 * 组装锁记录
 * @param input - 获取参数
 * @param role - 锁类型
 * @returns 锁记录
 */
function makeRecord(input: AcquireLockInput, role: LockRole): LockRecord {
  return {
    pid: process.pid,
    ppid: process.ppid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    botId: role === 'bot' ? input.botId : '',
    stateDir: input.stateDir,
    role,
  };
}

/**
 * 解析锁记录；格式非法时返回 null
 * @param raw - 锁文件原文
 * @returns 锁记录或 null
 */
function parseRecord(raw: string): LockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return {
      pid: parsed.pid,
      ppid: typeof parsed.ppid === 'number' ? parsed.ppid : 0,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      botId: typeof parsed.botId === 'string' ? parsed.botId : '',
      stateDir: typeof parsed.stateDir === 'string' ? parsed.stateDir : '',
      role: parsed.role === 'bot' ? 'bot' : 'state',
    };
  } catch {
    return null;
  }
}

/**
 * 把锁记录写进同目录临时文件，内容写完再返回路径
 * 直接写到锁路径会让并发读者读到空文件并误判为损坏锁
 * @param filePath - 最终锁路径（用于错误信息与同目录临时文件）
 * @param record - 锁内容
 * @returns 临时文件路径
 */
function writeTempLock(filePath: string, record: LockRecord): string {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const payload = JSON.stringify(record);
  let fd: number;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
  } catch (err) {
    throw new LockIoError(filePath, (err as NodeJS.ErrnoException).code ?? 'UNKNOWN', '创建临时锁文件失败');
  }
  try {
    const written = fs.writeSync(fd, payload);
    if (written !== Buffer.byteLength(payload)) {
      throw new LockIoError(tmpPath, 'ENOSPC', '锁内容写入不完整');
    }
  } catch (err) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // 清理失败不掩盖原始错误
    }
    if (err instanceof LockIoError) throw err;
    throw new LockIoError(filePath, (err as NodeJS.ErrnoException).code ?? 'UNKNOWN', '写入锁文件失败');
  }
  fs.closeSync(fd);
  return tmpPath;
}

/**
 * 不支持硬链接的文件系统上的退路：O_EXCL 直接创建并写内容
 * @param filePath - 锁路径
 * @param record - 锁内容
 * @returns 已创建返回 true；已存在返回 false
 */
function createLockFallback(filePath: string, record: LockRecord): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'wx', 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code === 'EEXIST') return false;
    throw new LockIoError(filePath, code, '创建锁文件失败');
  }
  const payload = JSON.stringify(record);
  try {
    const written = fs.writeSync(fd, payload);
    if (written !== Buffer.byteLength(payload)) {
      throw new LockIoError(filePath, 'ENOSPC', '锁内容写入不完整');
    }
  } catch (err) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // 清理失败不掩盖原始错误
    }
    if (err instanceof LockIoError) throw err;
    throw new LockIoError(filePath, (err as NodeJS.ErrnoException).code ?? 'UNKNOWN', '写入锁文件失败');
  }
  fs.closeSync(fd);
  return true;
}

/**
 * 原子创建锁文件
 *
 * 先把完整内容写进临时文件，再用 `link(2)` 原子挂到锁路径：
 * 并发读者只会看到"不存在"或"内容完整"两种状态，不会读到半写文件后误判脏锁。
 * @param filePath - 锁路径
 * @param record - 锁内容
 * @returns 已创建返回 true；已存在返回 false
 */
function createLock(filePath: string, record: LockRecord): boolean {
  const tmpPath = writeTempLock(filePath, record);
  try {
    fs.linkSync(tmpPath, filePath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code === 'EEXIST') return false;
    // 部分文件系统（FAT、网络盘）不支持硬链接，退回 O_EXCL 创建
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES' || code === 'EXDEV') {
      return createLockFallback(filePath, record);
    }
    throw new LockIoError(filePath, code, '创建锁文件失败');
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // 临时文件清理失败不影响取锁结果
    }
  }
}

/**
 * 读取锁记录，区分"文件不存在"与"内容损坏"
 * @param filePath - 锁路径
 * @returns 读取结果
 */
function readExisting(
  filePath: string,
): { kind: 'missing' } | { kind: 'ok'; record: LockRecord } | { kind: 'corrupt' } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code === 'ENOENT') return { kind: 'missing' };
    throw new LockIoError(filePath, code, '读取锁文件失败');
  }
  const record = parseRecord(raw);
  return record ? { kind: 'ok', record } : { kind: 'corrupt' };
}

/**
 * 删除锁文件，ENOENT 视为已达成目标
 * @param filePath - 锁路径
 */
function removeLock(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code === 'ENOENT') return;
    throw new LockIoError(filePath, code, '清理陈旧锁失败');
  }
}

/**
 * 释放单个锁文件；只删除自己持有的锁
 * @param filePath - 锁路径
 */
function releaseLock(filePath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code !== 'ENOENT') log.warn('释放实例锁失败', { path: filePath, code });
    return;
  }
  const record = parseRecord(raw);
  // 内容损坏时无法证明归属，交给下一次启动按陈旧锁接管
  if (!record || record.pid !== process.pid) return;
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code !== 'ENOENT') log.warn('释放实例锁失败', { path: filePath, code });
  }
}

/**
 * 获取单个锁文件
 * @param filePath - 锁路径
 * @param record - 新锁内容
 * @param input - 获取参数
 * @param deadline - 等待截止时间
 * @param startedAt - 本次取锁开始时间，用于报告实际等待时长
 */
async function acquireOne(
  filePath: string,
  record: LockRecord,
  input: AcquireLockInput,
  deadline: number,
  startedAt: number,
): Promise<void> {
  const alive = input.isAlive ?? isAlive;
  const bridge = input.isBridgeProcess ?? isBridgeProcess;
  const sleep = input.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const basis = record.role === 'bot' ? 'bot 锁' : '状态目录锁';
  let dirtyRetries = 0;
  let mismatchLogged = false;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new LockIoError(filePath, (err as NodeJS.ErrnoException).code ?? 'UNKNOWN', '创建锁目录失败');
  }

  for (;;) {
    if (createLock(filePath, record)) return;

    const existing = readExisting(filePath);
    if (existing.kind === 'missing') {
      // open 报 EEXIST 而读不到内容：锁文件可能正被替换或是指向缺失目标的符号链接
      if (now() >= deadline) {
        throw new LockIoError(filePath, 'EBUSY', '锁文件状态反复变化，无法判定归属');
      }
      await sleep(pollMs);
      continue;
    }

    // 同进程重复获取直接视为冲突，避免单测/库调用把自身锁判成陈旧
    if (existing.kind === 'ok' && existing.record.pid === process.pid) {
      log.error('拒绝启动：本进程已持有实例锁', {
        selfPid: process.pid,
        ownerPid: existing.record.pid,
        basis,
        lockFile: filePath,
      });
      throw new AlreadyRunningError(existing.record, null, now() - startedAt, filePath);
    }

    // 只在持有者确实不存活时接管；存活但特征不符属于判定不清，保守按占用处理
    if (existing.kind !== 'ok') {
      log.warn('接管损坏的实例锁', { path: filePath });
      removeLock(filePath);
      dirtyRetries += 1;
      if (dirtyRetries > MAX_DIRTY_RETRIES) {
        throw new LockIoError(filePath, 'EDIRTY', '连续清理陈旧锁失败');
      }
      continue;
    }

    if (!alive(existing.record.pid)) {
      log.warn('接管陈旧实例锁', { path: filePath, pid: existing.record.pid });
      removeLock(filePath);
      dirtyRetries += 1;
      if (dirtyRetries > MAX_DIRTY_RETRIES) {
        throw new LockIoError(filePath, 'EDIRTY', '连续清理陈旧锁失败');
      }
      continue;
    }

    if (process.platform !== 'win32' && !bridge(existing.record.pid)) {
      if (!mismatchLogged) {
        mismatchLogged = true;
        log.error('实例锁持有者存活但命令行不匹配，按占用处理', {
          selfPid: process.pid,
          ownerPid: existing.record.pid,
          basis,
          lockFile: filePath,
        });
      }
    }

    if (now() >= deadline) {
      const owner = existing.record;
      const waitedMs = now() - startedAt;
      log.error('拒绝启动：实例锁被占用', {
        selfPid: process.pid,
        ownerPid: owner.pid,
        basis,
        lockFile: filePath,
        waitedMs,
      });
      throw new AlreadyRunningError(owner, safeLaunchdLabel(owner.pid), waitedMs, filePath);
    }
    await sleep(pollMs);
  }
}

/**
 * 查询 launchd 标签，失败不阻断
 * @param pid - 进程 id
 * @returns 标签或 null
 */
function safeLaunchdLabel(pid: number): string | null {
  try {
    return launchdLabel(pid);
  } catch {
    return null;
  }
}

/**
 * 获取实例锁（状态目录锁 + 可选 bot 锁）
 * @param input - 获取参数
 * @returns 锁句柄
 */
export async function acquireInstanceLock(input: AcquireLockInput): Promise<LockHandle> {
  const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;
  const now = input.now ?? Date.now;
  const startedAt = now();
  const deadline = input.deadline ?? startedAt + waitMs;
  const mode = input.mode ?? 'both';
  const paths: string[] = [];

  /**
   * 获取单个锁，失败时释放已持有的锁
   * @param filePath - 锁路径
   * @param role - 锁类型
   */
  const acquire = async (filePath: string, role: LockRole): Promise<void> => {
    try {
      await acquireOne(filePath, makeRecord(input, role), input, deadline, startedAt);
      paths.push(filePath);
    } catch (err) {
      for (const held of paths.splice(0)) releaseLock(held);
      throw err;
    }
  };

  if (mode !== 'bot') {
    await acquire(stateLockPath(input.stateDir), 'state');
  }

  if (mode !== 'state') {
    if (!input.botId) {
      if (mode === 'bot') throw new LockIoError(botLockPath(''), 'EINVAL', 'bot 锁需要 botId');
      log.info('botId 为空，仅持有状态目录锁', { path: stateLockPath(input.stateDir) });
    } else {
      await acquire(botLockPath(input.botId), 'bot');
    }
  }

  return {
    paths: [...paths],
    release: (): void => {
      for (const lockPath of paths.splice(0)) releaseLock(lockPath);
    },
  };
}
