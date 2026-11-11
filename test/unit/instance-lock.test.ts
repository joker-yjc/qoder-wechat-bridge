/**
 * 实例锁单元测试
 * @module test/unit/instance-lock
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bridge/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/bridge/lifecycle.js')>();
  return {
    ...actual,
    launchdLabel: (): string => {
      throw new Error('launchctl unavailable');
    },
  };
});

import { log } from '../../src/log.js';
import {
  AlreadyRunningError,
  LockIoError,
  acquireInstanceLock,
  botLockPath,
  globalInstancesDir,
  stateLockPath,
} from '../../src/bridge/instance-lock.js';

let root: string;
let originalHome: string | undefined;

/**
 * 写入一条锁记录
 * @param filePath - 锁路径
 * @param pid - 持有者 pid
 */
function writeLock(filePath: string, pid: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      pid,
      ppid: 0,
      startedAt: new Date().toISOString(),
      cwd: '/tmp',
      botId: '',
      stateDir: path.dirname(filePath),
      role: 'state',
    }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-lock-'));
  originalHome = process.env.HOME;
  process.env.HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('acquireInstanceLock', () => {
  it('应该获取状态锁并在释放后允许再次获取', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const handle = await acquireInstanceLock({ stateDir, botId: '' });
    expect(handle.paths).toEqual([stateLockPath(stateDir)]);
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(true);

    handle.release();
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);

    const again = await acquireInstanceLock({ stateDir, botId: '' });
    again.release();
  });

  it('应该同时持有状态锁与 bot 锁', async () => {
    const stateDir = path.join(root, 'state');
    const handle = await acquireInstanceLock({ stateDir, botId: 'bot-1' });

    expect(handle.paths).toHaveLength(2);
    expect(handle.paths[1]).toBe(botLockPath('bot-1'));
    expect(handle.paths[1]?.startsWith(globalInstancesDir())).toBe(true);
    expect(fs.existsSync(botLockPath('bot-1'))).toBe(true);

    handle.release();
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);
    expect(fs.existsSync(botLockPath('bot-1'))).toBe(false);
  });

  it('应该在同进程重复获取时立即拒绝（防重入，不代表跨进程互斥）', async () => {
    const stateDir = path.join(root, 'state');
    const results = await Promise.allSettled([
      acquireInstanceLock({ stateDir, botId: '' }),
      acquireInstanceLock({ stateDir, botId: '' }),
    ]);

    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyRunningError);

    (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireInstanceLock>>>).value.release();
  });

  it('应该接管 pid 已不存在的陈旧锁', async () => {
    const stateDir = path.join(root, 'state');
    writeLock(stateLockPath(stateDir), 999_999);

    const handle = await acquireInstanceLock({
      stateDir,
      botId: '',
      isAlive: () => false,
      isBridgeProcess: () => false,
    });
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(true);
    handle.release();
  });

  it('应该接管内容损坏的锁文件', async () => {
    const stateDir = path.join(root, 'state');
    writeLock(stateLockPath(stateDir), 1);
    fs.writeFileSync(stateLockPath(stateDir), 'not-json');

    const handle = await acquireInstanceLock({ stateDir, botId: '' });
    handle.release();
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);
  });

  it('应该在存活实例占用时等待超时后拒绝', async () => {
    const stateDir = path.join(root, 'state');
    writeLock(stateLockPath(stateDir), 4_242);

    let clock = 1_000;
    const sleeps: number[] = [];
    await expect(
      acquireInstanceLock({
        stateDir,
        botId: '',
        waitMs: 100,
        pollMs: 10,
        isAlive: () => true,
        isBridgeProcess: () => true,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);

    expect(sleeps.length).toBeGreaterThan(0);
    expect(clock).toBeGreaterThanOrEqual(1_100);
  });

  it('应该在锁目录不可用时 fail-closed', async () => {
    const notDir = path.join(root, 'not-a-dir');
    fs.writeFileSync(notDir, 'x');

    await expect(acquireInstanceLock({ stateDir: notDir, botId: '' })).rejects.toBeInstanceOf(LockIoError);
  });

  it('应该在释放时跳过不属于自己的锁', async () => {
    const stateDir = path.join(root, 'state');
    const handle = await acquireInstanceLock({ stateDir, botId: '' });

    writeLock(stateLockPath(stateDir), 999_999);
    handle.release();

    expect(fs.existsSync(stateLockPath(stateDir))).toBe(true);
  });

  it('应该在 bot 锁冲突时释放已获取的状态锁', async () => {
    const stateDir = path.join(root, 'state');
    writeLock(botLockPath('bot-2'), 4_242);

    await expect(
      acquireInstanceLock({
        stateDir,
        botId: 'bot-2',
        waitMs: 0,
        isAlive: () => true,
        isBridgeProcess: () => true,
      }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);

    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);
  });

  it('应该在 botId 为空时只创建状态锁', async () => {
    const stateDir = path.join(root, 'state');
    const handle = await acquireInstanceLock({ stateDir, botId: '' });

    expect(handle.paths).toHaveLength(1);
    expect(fs.existsSync(globalInstancesDir())).toBe(false);
    handle.release();
  });

  it('应该在打开锁文件失败时 fail-closed', async () => {
    const stateDir = path.join(root, 'state');
    vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });

    await expect(acquireInstanceLock({ stateDir, botId: '' })).rejects.toMatchObject({
      name: 'LockIoError',
      code: 'EACCES',
    });
  });

  it('应该在写入锁内容失败时清理文件并报错', async () => {
    const stateDir = path.join(root, 'state');
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('io'), { code: 'EIO' });
    });

    await expect(acquireInstanceLock({ stateDir, botId: '' })).rejects.toBeInstanceOf(LockIoError);
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);
  });

  it('应该在删除陈旧锁失败时报错', async () => {
    const stateDir = path.join(root, 'state');
    const lockPath = stateLockPath(stateDir);
    writeLock(lockPath, 999_999);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target: fs.PathLike) => {
      if (String(target) === lockPath) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return undefined;
    });

    await expect(
      acquireInstanceLock({ stateDir, botId: '', isAlive: () => false, isBridgeProcess: () => false }),
    ).rejects.toMatchObject({ name: 'LockIoError', code: 'EACCES' });
  });

  it('应该在锁路径变成目录时报告读取失败', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(stateLockPath(stateDir));

    await expect(acquireInstanceLock({ stateDir, botId: '' })).rejects.toMatchObject({
      name: 'LockIoError',
    });
  });

  it('应该在连续清理陈旧锁失败后放弃', async () => {
    const stateDir = path.join(root, 'state');
    writeLock(stateLockPath(stateDir), 999_999);
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);

    await expect(
      acquireInstanceLock({ stateDir, botId: '', isAlive: () => false, isBridgeProcess: () => false }),
    ).rejects.toMatchObject({ name: 'LockIoError', code: 'EDIRTY' });
  });

  it('应该在释放时忽略锁文件读取失败', async () => {
    const stateDir = path.join(root, 'state');
    const handle = await acquireInstanceLock({ stateDir, botId: '' });
    fs.rmSync(stateLockPath(stateDir));
    fs.mkdirSync(stateLockPath(stateDir));

    expect(() => handle.release()).not.toThrow();
  });

  it('应该在释放时忽略删除失败', async () => {
    const stateDir = path.join(root, 'state');
    const handle = await acquireInstanceLock({ stateDir, botId: '' });
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });

    expect(() => handle.release()).not.toThrow();
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(true);
  });

  it('应该在 mode=state 时只获取状态锁', async () => {
    const stateDir = path.join(root, 'state');
    const handle = await acquireInstanceLock({ stateDir, botId: 'bot-x', mode: 'state' });

    expect(handle.paths).toEqual([stateLockPath(stateDir)]);
    expect(fs.existsSync(botLockPath('bot-x'))).toBe(false);
    handle.release();
  });

  it('应该在 mode=bot 时只获取 bot 锁', async () => {
    const stateDir = path.join(root, 'state');
    const handle = await acquireInstanceLock({ stateDir, botId: 'bot-y', mode: 'bot' });

    expect(handle.paths).toEqual([botLockPath('bot-y')]);
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);
    handle.release();
  });

  it('应该在 mode=bot 且缺少 botId 时报错', async () => {
    await expect(
      acquireInstanceLock({ stateDir: path.join(root, 'state'), botId: '', mode: 'bot' }),
    ).rejects.toMatchObject({ name: 'LockIoError', code: 'EINVAL' });
  });

  it('应该在拒绝启动时记录自身 pid、对方 pid、判定依据与锁路径', async () => {
    const stateDir = path.join(root, 'state');
    const lockPath = stateLockPath(stateDir);
    writeLock(lockPath, 4_242);
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const err = await acquireInstanceLock({
      stateDir,
      botId: '',
      waitMs: 0,
      isAlive: () => true,
      isBridgeProcess: () => true,
    }).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(AlreadyRunningError);
    expect((err as AlreadyRunningError).lockFile).toBe(lockPath);

    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain('4242');
    expect(logged).toContain(String(process.pid));
    expect(logged).toContain(lockPath);
    expect(logged).toContain('锁');
  });

  it('应该在回退创建遇到已存在锁时按冲突等待', async () => {
    const stateDir = path.join(root, 'state');
    const lockPath = stateLockPath(stateDir);
    writeLock(lockPath, 4_242);
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
    });

    await expect(
      acquireInstanceLock({ stateDir, botId: '', waitMs: 0, isAlive: () => true, isBridgeProcess: () => true }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(4_242);
  });

  it('应该在回退创建写入失败时 fail-closed', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const realWrite = fs.writeSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
    });
    vi.spyOn(fs, 'writeSync')
      .mockImplementationOnce(((...args: Parameters<typeof fs.writeSync>) => realWrite(...args)) as typeof fs.writeSync)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('io'), { code: 'EIO' });
      });

    await expect(acquireInstanceLock({ stateDir, botId: '' })).rejects.toMatchObject({
      name: 'LockIoError',
      code: 'EIO',
    });
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);
  });

  it('应该在回退创建短写时 fail-closed', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const realWrite = fs.writeSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
    });
    vi.spyOn(fs, 'writeSync')
      .mockImplementationOnce(((...args: Parameters<typeof fs.writeSync>) => realWrite(...args)) as typeof fs.writeSync)
      .mockImplementationOnce(() => 1);

    await expect(acquireInstanceLock({ stateDir, botId: '' })).rejects.toMatchObject({
      name: 'LockIoError',
      code: 'ENOSPC',
    });
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);
  });

  it('应该在硬链接失败且不可回退时报错', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('io'), { code: 'EIO' });
    });

    await expect(acquireInstanceLock({ stateDir, botId: '' })).rejects.toMatchObject({
      name: 'LockIoError',
      code: 'EIO',
    });
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);
  });

  it('应该在回退创建时对非冲突错误 fail-closed', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const realOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
    });
    vi.spyOn(fs, 'openSync')
      .mockImplementationOnce((( ...args: Parameters<typeof fs.openSync>) => realOpen(...args)) as typeof fs.openSync)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      });

    await expect(acquireInstanceLock({ stateDir, botId: '' })).rejects.toMatchObject({
      name: 'LockIoError',
      code: 'EACCES',
    });
  });

  it('应该在连续清理损坏锁失败后放弃', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateLockPath(stateDir), 'not-json');
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);

    await expect(acquireInstanceLock({ stateDir, botId: '' })).rejects.toMatchObject({
      name: 'LockIoError',
      code: 'EDIRTY',
    });
  });

  it('应该在空目录下 100ms 内完成取锁与释放', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const startedAt = Date.now();
    const handle = await acquireInstanceLock({ stateDir, botId: '' });
    handle.release();

    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it('应该在锁错误信息中包含锁文件路径', async () => {
    const notDir = path.join(root, 'not-a-dir');
    fs.writeFileSync(notDir, 'x');

    const err = await acquireInstanceLock({ stateDir: notDir, botId: '' }).catch((error: unknown) => error);
    expect((err as Error).message).toContain(notDir);
  });

  it('应该报告实际等待时长而不是预算常量', async () => {
    const stateDir = path.join(root, 'state');
    writeLock(stateLockPath(stateDir), 4_242);
    let clock = 1_000;

    const err = await acquireInstanceLock({
      stateDir,
      botId: '',
      waitMs: 100,
      pollMs: 10,
      isAlive: () => true,
      isBridgeProcess: () => true,
      now: () => clock,
      sleep: async () => {
        clock += 130;
      },
    }).catch((error: unknown) => error);

    expect((err as AlreadyRunningError).waitedMs).toBe(130);
  });

  it('应该按共享 deadline 截止而不是每把锁各自计时', async () => {
    const stateDir = path.join(root, 'state');
    writeLock(stateLockPath(stateDir), 4_242);
    let clock = 5_000;

    const err = await acquireInstanceLock({
      stateDir,
      botId: '',
      waitMs: 5_000,
      deadline: 5_120,
      pollMs: 10,
      isAlive: () => true,
      isBridgeProcess: () => true,
      now: () => clock,
      sleep: async () => {
        clock += 60;
      },
    }).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(AlreadyRunningError);
    expect((err as AlreadyRunningError).waitedMs).toBeLessThanOrEqual(120);
  });

  it('应该在 pid 存活但命令行不匹配时拒绝接管', async () => {
    const stateDir = path.join(root, 'state');
    const lockPath = stateLockPath(stateDir);
    writeLock(lockPath, 4_242);

    await expect(
      acquireInstanceLock({
        stateDir,
        botId: '',
        waitMs: 0,
        isAlive: () => true,
        isBridgeProcess: () => false,
      }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);

    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(4_242);
  });

  it('应该在锁文件反复"消失"时按 deadline 放弃而不是忙等', async () => {    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    });
    let reads = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return JSON.stringify({ pid: 4_242 });
    });

    await expect(
      acquireInstanceLock({
        stateDir,
        botId: '',
        waitMs: 0,
        isAlive: () => true,
        isBridgeProcess: () => true,
      }),
    ).rejects.toMatchObject({ name: 'LockIoError', code: 'EBUSY' });
  });

  it('应该在锁内容短写时 fail-closed 且不留下锁文件', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => 1);

    await expect(acquireInstanceLock({ stateDir, botId: '' })).rejects.toMatchObject({
      name: 'LockIoError',
      code: 'ENOSPC',
    });
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);
  });

  it('应该在文件系统不支持硬链接时回退到 O_EXCL 创建', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
    });

    const handle = await acquireInstanceLock({ stateDir, botId: '' });

    expect(fs.existsSync(stateLockPath(stateDir))).toBe(true);
    handle.release();
  });

  it('应该在接管陈旧锁时记录被清理的 pid', async () => {
    const stateDir = path.join(root, 'state');
    writeLock(stateLockPath(stateDir), 4_242);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    const handle = await acquireInstanceLock({ stateDir, botId: '', isAlive: () => false });

    expect(JSON.stringify(warn.mock.calls)).toContain('4242');
    handle.release();
  });

  it('应该在锁文件短暂不可读后重试成功', async () => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    });
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const handle = await acquireInstanceLock({ stateDir, botId: '', pollMs: 10 });

    expect(handle.paths).toEqual([stateLockPath(stateDir)]);
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(true);
    handle.release();
    expect(fs.existsSync(stateLockPath(stateDir))).toBe(false);
  });
});
