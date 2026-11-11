import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  ensureDirs,
  loadState,
  saveState,
  type Config,
  type State,
} from '../../src/config.js';
import { log } from '../../src/log.js';
import { createBridgeRuntime, formatPreflightAlert, runService, type ServiceDeps } from '../../src/bridge/service.js';
import { AlreadyRunningError } from '../../src/bridge/instance-lock.js';
import type { PreflightResult } from '../../src/bridge/preflight.js';
import { MessageItemType, MessageType } from '../../src/weixin/types.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-startup-'));
  process.env.QWB_CONFIG_DIR = path.join(root, 'config');
  process.env.QWB_STATE_DIR = path.join(root, 'state');
  ensureDirs();
});

afterEach(() => {
  delete process.env.QWB_CONFIG_DIR;
  delete process.env.QWB_STATE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

const okPreflight: PreflightResult = {
  ok: true,
  node: { version: '24.0.0', major: 24, execPath: '/node', ino: 1, mtimeMs: 1 },
  qodercli: { path: '/bin/qodercli', version: '1.1.81' },
  failures: [],
};

const failPreflight: PreflightResult = {
  ok: false,
  node: { version: '24.0.0', major: 24, execPath: '/node', ino: 1, mtimeMs: 1 },
  qodercli: null,
  failures: [{ kind: 'qoder_missing', detail: 'not found' }],
};

/**
 * 构造配置
 * @returns 配置
 */
function makeConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    baseUrl: 'https://example.test',
    token: 'token',
    ownerUserId: 'u',
    cwd: '',
    qoderBin: 'qodercli',
    personaFile: path.join(root, 'persona.md'),
    inboxDir: path.join(root, 'inbox'),
  };
}

/**
 * 构造启动依赖
 * @param overrides - 覆盖项
 * @returns 依赖
 */
function makeDeps(overrides: ServiceDeps = {}): ServiceDeps {
  return {
    sendText: vi.fn(async () => ({ ret: 0, message_id: 'm' })),
    runQoder: vi.fn(async (input: { onStart?: (cancel: () => void) => void }) => {
      input.onStart?.(() => undefined);
      return { ok: true, text: 'reply', sessionId: 's1', durationMs: 1 };
    }),
    getTypingTicket: vi.fn(async () => ''),
    sendTyping: vi.fn(async () => undefined),
    takePending: vi.fn(() => []),
    loadPersona: vi.fn(() => ''),
    listModels: vi.fn(() => []),
    downloadItemMedia: vi.fn(async () => null),
    pruneDiagnostics: vi.fn(() => 0),
    pruneInbox: vi.fn(),
    login: vi.fn(async () => ({ connected: true, message: 'ok' })),
    notifyClient: vi.fn(async () => undefined),
    getUpdates: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ret: 0, msgs: [], get_updates_buf: 'buf' };
    }),
    writeRunInfo: vi.fn(),
    clearRunInfo: vi.fn(),
    runPreflight: vi.fn(async () => okPreflight),
    ...overrides,
  };
}

describe('runService 启动流程', () => {
  it('应该在预检通过时记录信息并正常启动/停止', async () => {
    const deps = makeDeps();
    const handle = await runService(makeConfig(), deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deps.pruneDiagnostics).toHaveBeenCalledWith(DEFAULT_CONFIG.diagnosticRetentionDays);
    expect(deps.writeRunInfo).toHaveBeenCalled();
    expect(deps.sendText).not.toHaveBeenCalled();
    expect(deps.notifyClient).toHaveBeenCalledWith(expect.objectContaining({ action: 'start' }));
    expect(deps.notifyClient).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop' }));
    expect(deps.clearRunInfo).toHaveBeenCalledWith(process.pid);
  });

  it('应该在预检失败且存在 token 时发送一条短告警', async () => {
    const state: State = { ...DEFAULT_STATE, contextTokens: { u: 'ctx' } };
    saveState(state);
    const sendText = vi.fn(async () => ({ ret: 0, message_id: 'm' }));
    const deps = makeDeps({ runPreflight: vi.fn(async () => failPreflight), sendText });

    const handle = await runService(makeConfig(), deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendText).toHaveBeenCalledTimes(1);
    const text = sendText.mock.calls[0]?.[0].text as string;
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain('环境异常');
    expect(loadState().outbox).toEqual([]);
  });

  it('应该在预检失败且没有 token 时只写日志', async () => {
    const sendText = vi.fn(async () => ({ ret: 0, message_id: 'm' }));
    const deps = makeDeps({ runPreflight: vi.fn(async () => failPreflight), sendText });

    const handle = await runService(makeConfig(), deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendText).not.toHaveBeenCalled();
  });

  it('应该在未登录时调用 login', async () => {
    const login = vi.fn(async () => ({ connected: true, message: 'ok' }));
    const deps = makeDeps({ login });
    const handle = await runService({ ...makeConfig(), token: '' }, deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(login).toHaveBeenCalled();
  });

  it('应该在登录失败时抛出错误', async () => {
    const deps = makeDeps({
      login: vi.fn(async () => ({ connected: false, message: 'no' })),
    });
    await expect(runService({ ...makeConfig(), token: '' }, deps)).rejects.toThrow('微信登录未完成');
  });

  it('应该在诊断清理失败时继续启动', async () => {
    const deps = makeDeps({
      pruneDiagnostics: vi.fn(() => {
        throw new Error('cleanup failed');
      }),
    });
    const handle = await runService(makeConfig(), deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deps.writeRunInfo).toHaveBeenCalled();
  });

  it('应该在预检告警发送失败时继续启动', async () => {
    saveState({ ...DEFAULT_STATE, contextTokens: { u: 'ctx' } });
    const sendText = vi.fn(async () => {
      throw new Error('send failed');
    });
    const deps = makeDeps({
      runPreflight: vi.fn(async () => failPreflight),
      sendText,
    });

    const handle = await runService(makeConfig(), deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendText).toHaveBeenCalled();
    expect(deps.writeRunInfo).toHaveBeenCalled();
  });

  it('应该采用服务端建议的长轮询时长', async () => {
    const getUpdates = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: 'buf',
        longpolling_timeout_ms: 10,
      };
    });
    const deps = makeDeps({ getUpdates });

    const handle = await runService(makeConfig(), deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getUpdates).toHaveBeenCalled();
  });

  it('应该在 getupdates 错误与异常时退避重试', async () => {
    let calls = 0;
    const getUpdates = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ret: 7, errmsg: 'bad' };
      if (calls === 2) throw new Error('boom');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ret: 0, msgs: [], get_updates_buf: 'buf' };
    });
    const handle = await runService(makeConfig(), makeDeps({ getUpdates }));
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getUpdates.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 10_000);

  it('应该在主循环启动失败时清理运行记录', async () => {
    const deps = makeDeps({
      notifyClient: vi.fn(async (params: { action: string }) => {
        if (params.action === 'start') throw new Error('boom');
      }),
    });
    const handle = await runService(makeConfig(), deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deps.clearRunInfo).toHaveBeenCalled();
  });

  it('应该处理 getupdates 返回的消息', async () => {
    let delivered = false;
    const getUpdates = vi.fn(async () => {
      if (!delivered) {
        delivered = true;
        return {
          ret: 0,
          msgs: [
            {
              message_type: MessageType.USER,
              from_user_id: 'u',
              message_id: 'm1',
              context_token: 'ctx',
              item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hello' } }],
            },
          ],
          get_updates_buf: 'buf',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ret: 0, msgs: [], get_updates_buf: 'buf' };
    });
    const sendText = vi.fn(async () => ({ ret: 0, message_id: 'm' }));
    const handle = await runService(makeConfig(), makeDeps({ getUpdates, sendText }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sendText).toHaveBeenCalled();
  });

  it('应该在会话过期时停止循环并发送 stop 通知', async () => {
    const deps = makeDeps({
      getUpdates: vi.fn(async () => ({ ret: -14 })),
    });

    await runService(makeConfig(), deps);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deps.notifyClient).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop' }));
    expect(deps.clearRunInfo).toHaveBeenCalled();
  });
});

describe('formatPreflightAlert', () => {
  it('应该生成不超过 300 字的短告警', () => {
    const text = formatPreflightAlert(failPreflight);
    expect(text).toContain('qoder_missing');
    expect(text.length).toBeLessThanOrEqual(300);
  });
});

describe('Node 指纹变化', () => {
  it('应该在任务执行前检测到变化并告警', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const nodeFingerprint = vi
      .fn()
      .mockReturnValueOnce({ path: '/node-a', ino: 1, mtimeMs: 1, version: '24.0.0' })
      .mockReturnValueOnce({ path: '/node-b', ino: 1, mtimeMs: 1, version: '24.0.0' });
    const deps = makeDeps({ nodeFingerprint });
    const state: State = { ...DEFAULT_STATE, outbox: [], quarantine: [], quota: { streak: 0, lastAt: 0 } };
    const runtime = createBridgeRuntime(makeConfig(), state, deps);

    await runtime.processTask('u', 'hello', 'ctx');

    expect(warn).toHaveBeenCalledWith('Node 二进制已变化', expect.objectContaining({ reason: 'path' }));
    warn.mockRestore();
  });
});

describe('实例互斥接入', () => {
  it('应该拒绝同一状态目录的第二个实例', async () => {
    const first = await runService(makeConfig(), makeDeps());
    const secondDeps = makeDeps();

    await expect(runService(makeConfig(), secondDeps)).rejects.toBeInstanceOf(AlreadyRunningError);
    expect(secondDeps.writeRunInfo).not.toHaveBeenCalled();

    first.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('应该接管陈旧锁并继续启动', async () => {
    const lockPath = path.join(root, 'state', 'run.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999_999,
        ppid: 0,
        startedAt: '',
        cwd: '/',
        botId: '',
        stateDir: path.dirname(lockPath),
        role: 'state',
      }),
    );

    const deps = makeDeps();
    const handle = await runService(makeConfig(), deps);
    expect(deps.writeRunInfo).toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);

    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('应该在登录失败时释放已获取的锁', async () => {
    const deps = makeDeps({ login: vi.fn(async () => ({ connected: false, message: 'cancel' })) });

    await expect(runService({ ...makeConfig(), token: '' }, deps)).rejects.toThrow('微信登录未完成');
    expect(fs.existsSync(path.join(root, 'state', 'run.lock'))).toBe(false);
  });

  it('应该在启动期（预检未完成）收到 SIGTERM 时释放锁并以 130 退出', async () => {    const deps = makeDeps({
      runPreflight: vi.fn(
        () =>
          new Promise<PreflightResult>(() => {
            // 保持挂起，模拟登录/预检尚未结束的启动期
          }),
      ),
    });
    const beforeSigint = process.listeners('SIGINT');
    const beforeSigterm = process.listeners('SIGTERM');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const lockPath = path.join(root, 'state', 'run.lock');
    void runService(makeConfig(), deps);
    const startedAt = Date.now();
    while (!fs.existsSync(lockPath)) {
      if (Date.now() - startedAt > 2_000) throw new Error('等待锁文件超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // 锁文件创建与锁句柄登记之间隔了一个微任务，等它落定后再发信号
    await new Promise((resolve) => setTimeout(resolve, 50));

    process.emit('SIGTERM');

    expect(exit).toHaveBeenCalledWith(130);
    expect(fs.existsSync(lockPath)).toBe(false);

    // process.exit 被 mock 后早期处理器仍在，手工摘掉避免污染后续用例
    for (const listener of process.listeners('SIGINT')) {
      if (!beforeSigint.includes(listener)) process.off('SIGINT', listener as () => void);
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!beforeSigterm.includes(listener)) process.off('SIGTERM', listener as () => void);
    }
    exit.mockRestore();
  });

  it('应该在 run.json 指向运行中的旧版本实例时拒绝启动', async () => {
    const deps = makeDeps({
      readRunInfo: vi.fn(() => ({ pid: 55_555, ppid: 0, startedAt: '2026-11-10T00:00:00.000Z', cwd: '/old' })),
      isAlive: () => true,
      isBridgeProcess: () => true,
    });

    await expect(runService(makeConfig(), deps)).rejects.toBeInstanceOf(AlreadyRunningError);
    expect(deps.writeRunInfo).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'state', 'run.lock'))).toBe(false);
  });

  it('应该清理陈旧的 run.json 并继续启动', async () => {
    const deps = makeDeps({
      readRunInfo: vi.fn(() => ({ pid: 999_999, ppid: 0, startedAt: '', cwd: '/gone' })),
      isAlive: () => false,
    });

    const handle = await runService(makeConfig(), deps);
    expect(deps.clearRunInfo).toHaveBeenCalledWith(999_999);
    expect(deps.writeRunInfo).toHaveBeenCalled();

    await handle.stop();
  });

  it('应该在缺少 botId 时提示跨状态目录互斥不可用', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const handle = await runService(makeConfig(), makeDeps());

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('botId');

    await handle.stop();
    warn.mockRestore();
  });

  it('应该在预检抛错时释放锁并摘掉信号监听', async () => {
    const before = process.listenerCount('SIGTERM');
    const deps = makeDeps({
      runPreflight: vi.fn(async () => {
        throw new Error('preflight boom');
      }),
    });

    await expect(runService(makeConfig(), deps)).rejects.toThrow('preflight boom');
    expect(fs.existsSync(path.join(root, 'state', 'run.lock'))).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('应该在停止时等待在途任务结束再释放锁', async () => {    let delivered = false;
    const message = {
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'm1',
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hi' } }],
    };
    const getUpdates = vi.fn(async () => {
      if (!delivered) {
        delivered = true;
        return { ret: 0, msgs: [message], get_updates_buf: 'buf' };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ret: 0, msgs: [], get_updates_buf: 'buf' };
    });
    let started = false;
    const runQoder = vi.fn(async (input: { onStart?: (cancel: () => void) => void }) => {
      started = true;
      input.onStart?.(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { ok: true, text: 'reply', sessionId: 's1', durationMs: 1 };
    });

    const handle = await runService(makeConfig(), makeDeps({ getUpdates, runQoder }));
    const waitStart = Date.now();
    while (!started) {
      if (Date.now() - waitStart > 2_000) throw new Error('等待任务启动超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const lockPath = path.join(root, 'state', 'run.lock');
    const stopping = handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(lockPath)).toBe(true);

    await stopping;
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('应该在排空超时时保留锁而不是带着未完成任务释放', async () => {
    let delivered = false;
    const message = {
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: 'm-long',
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hi' } }],
    };
    const getUpdates = vi.fn(async () => {
      if (!delivered) {
        delivered = true;
        return { ret: 0, msgs: [message], get_updates_buf: 'buf' };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ret: 0, msgs: [], get_updates_buf: 'buf' };
    });
    let started = false;
    const runQoder = vi.fn(async (input: { onStart?: (cancel: () => void) => void }) => {
      started = true;
      input.onStart?.(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true, text: 'reply', sessionId: 's1', durationMs: 1 };
    });
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const handle = await runService(
      makeConfig(),
      makeDeps({ getUpdates, runQoder, drainTimeoutMs: 50 }),
    );
    const waitStart = Date.now();
    while (!started) {
      if (Date.now() - waitStart > 2_000) throw new Error('等待任务启动超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const lockPath = path.join(root, 'state', 'run.lock');
    await handle.stop();

    // 超时当下必须保留锁；任务落定后的补释放见「应该在排空超时后的任务落定时补释放实例锁」
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.stringify(errorLog.mock.calls)).toContain('保留实例锁');

    errorLog.mockRestore();
  });

  it('应该在收到一次 SIGTERM 后由主循环收尾并释放锁', async () => {
    const deps = makeDeps();
    const handle = await runService(makeConfig(), deps);
    const lockPath = path.join(root, 'state', 'run.lock');

    process.emit('SIGTERM');
    const startedAt = Date.now();
    while (fs.existsSync(lockPath)) {
      if (Date.now() - startedAt > 3_000) throw new Error('等待释放锁超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(deps.clearRunInfo).toHaveBeenCalledWith(process.pid);
    await handle.stop();
  });

  it('应该在第二次 SIGTERM 时立即退出并释放锁', async () => {
    const beforeSigint = process.listeners('SIGINT');
    const beforeSigterm = process.listeners('SIGTERM');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const handle = await runService(makeConfig(), makeDeps());
    const lockPath = path.join(root, 'state', 'run.lock');

    process.emit('SIGTERM');
    process.emit('SIGTERM');

    expect(exit).toHaveBeenCalledWith(130);
    expect(fs.existsSync(lockPath)).toBe(false);

    for (const listener of process.listeners('SIGINT')) {
      if (!beforeSigint.includes(listener)) process.off('SIGINT', listener as () => void);
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!beforeSigterm.includes(listener)) process.off('SIGTERM', listener as () => void);
    }
    exit.mockRestore();
    await handle.stop();
  });

  it('应该在停止后不再执行队列中未启动的任务', async () => {
    const makeMessage = (id: string) => ({
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: id,
      context_token: 'ctx',
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: `hi-${id}` } }],
    });
    let delivered = false;
    let qoderCalls = 0;
    const runQoder = vi.fn(async (input: { onStart?: (cancel: () => void) => void }) => {
      qoderCalls += 1;
      input.onStart?.(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { ok: true, text: 'reply', sessionId: 's1', durationMs: 1 };
    });
    // 同一条队列里排两个任务：第一个执行中收到停止信号，第二个不得起跑
    const getUpdates = vi.fn(async () => {
      if (!delivered) {
        delivered = true;
        return { ret: 0, msgs: [makeMessage('m1'), makeMessage('m2')], get_updates_buf: 'buf' };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ret: 0, msgs: [], get_updates_buf: 'buf' };
    });
    const beforeSigint = process.listeners('SIGINT');
    const beforeSigterm = process.listeners('SIGTERM');
    const handle = await runService(makeConfig(), makeDeps({ getUpdates, runQoder }));

    const startedAt = Date.now();
    while (qoderCalls < 1) {
      if (Date.now() - startedAt > 2_000) throw new Error('等待任务启动超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    process.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(qoderCalls).toBe(1);

    for (const listener of process.listeners('SIGINT')) {
      if (!beforeSigint.includes(listener)) process.off('SIGINT', listener as () => void);
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!beforeSigterm.includes(listener)) process.off('SIGTERM', listener as () => void);
    }
    await handle.stop();
  });

  it('应该在排空超时后的任务落定时补释放实例锁', async () => {
    const lockPath = path.join(root, 'state', 'run.lock');
    let delivered = false;
    const getUpdates = vi.fn(async () => {
      if (!delivered) {
        delivered = true;
        return {
          ret: 0,
          msgs: [
            {
              message_type: MessageType.USER,
              from_user_id: 'u',
              message_id: 'm-late',
              context_token: 'ctx',
              item_list: [{ type: MessageItemType.TEXT, text_item: { text: 'hi' } }],
            },
          ],
          get_updates_buf: 'buf',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ret: 0, msgs: [], get_updates_buf: 'buf' };
    });
    let started = false;
    const runQoder = vi.fn(async (input: { onStart?: (cancel: () => void) => void }) => {
      started = true;
      input.onStart?.(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { ok: true, text: 'reply', sessionId: 's1', durationMs: 1 };
    });

    const handle = await runService(
      makeConfig(),
      makeDeps({ getUpdates, runQoder, drainTimeoutMs: 40 }),
    );
    const startedAt = Date.now();
    while (!started) {
      if (Date.now() - startedAt > 2_000) throw new Error('等待任务启动超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // 排空上限 40ms < 任务 120ms：stop 返回时锁仍被持有
    await handle.stop();
    expect(fs.existsSync(lockPath)).toBe(true);

    // 任务落定后必须补释放，否则同进程内重启会被自身的防重入拒绝
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('应该在停止后丢弃已拉取但尚未交给 Qoder 的消息', async () => {
    // 一批两条：m1 带附件（下载中收到停止信号），m2 在停止后才轮到入站
    const textWithImage = (id: string) => ({
      message_type: MessageType.USER,
      from_user_id: 'u',
      message_id: id,
      context_token: 'ctx',
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: `hi-${id}` } },
        { type: MessageItemType.IMAGE, image_item: { media: { aes_key: 'k', encrypted_file_id: 'f', filesize: 1 } } },
      ],
    });
    let delivered = false;
    let qoderCalls = 0;
    let mediaDownloads = 0;
    const runQoder = vi.fn(async (input: { onStart?: (cancel: () => void) => void }) => {
      qoderCalls += 1;
      input.onStart?.(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, text: 'reply', sessionId: 's1', durationMs: 1 };
    });
    const getUpdates = vi.fn(async () => {
      if (!delivered) {
        delivered = true;
        return { ret: 0, msgs: [textWithImage('m1'), textWithImage('m2')], get_updates_buf: 'buf' };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ret: 0, msgs: [], get_updates_buf: 'buf' };
    });
    const downloadItemMedia = vi.fn(async () => {
      mediaDownloads += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return null;
    });
    const beforeSigint = process.listeners('SIGINT');
    const beforeSigterm = process.listeners('SIGTERM');
    const handle = await runService(
      makeConfig(),
      makeDeps({ getUpdates, runQoder, downloadItemMedia }),
    );

    // 等两条消息进入本轮批处理，再在附件下载期间停止
    await new Promise((resolve) => setTimeout(resolve, 30));
    process.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 400));

    // 停止后：m1 的附件照常下载，m2 既不下载也不起跑
    expect(mediaDownloads).toBe(1);
    expect(qoderCalls).toBe(0);

    for (const listener of process.listeners('SIGINT')) {
      if (!beforeSigint.includes(listener)) process.off('SIGINT', listener as () => void);
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!beforeSigterm.includes(listener)) process.off('SIGTERM', listener as () => void);
    }
    await handle.stop();
  });
});
