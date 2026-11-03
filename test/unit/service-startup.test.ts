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
