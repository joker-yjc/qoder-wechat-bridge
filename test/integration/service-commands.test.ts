import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_STATE, ensureDirs, type Config, type State } from '../../src/config.js';
import { MessageItemType, MessageType, type WeixinMessage } from '../../src/weixin/types.js';
import { createBridgeRuntime, type ServiceDeps } from '../../src/bridge/service.js';
import type { SessionEntry } from '../../src/bridge/sessions.js';

const UUID1 = '9a113144-7a3b-432f-b5fb-c6b560ccb43a';
const UUID2 = '3f2c8be1-1111-2222-3333-444455556666';
const CATALOG: SessionEntry[] = [
  { index: 1, name: '探针新名', lastActive: '2 分钟前', sessionId: UUID1 },
  { index: 2, name: '登录页重构', lastActive: '昨天', sessionId: UUID2 },
];

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-svc-cmd-'));
  process.env.QWB_CONFIG_DIR = path.join(root, 'config');
  process.env.QWB_STATE_DIR = path.join(root, 'state');
  ensureDirs();
});

afterEach(() => {
  delete process.env.QWB_CONFIG_DIR;
  delete process.env.QWB_STATE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * 构造配置
 * @param overrides - 覆盖项
 * @returns 配置
 */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    baseUrl: 'https://example.test',
    token: 'token',
    ownerUserId: 'u',
    cwd: '',
    memoryEnabled: false,
    personaFile: path.join(root, 'persona.md'),
    inboxDir: path.join(root, 'inbox'),
    ...overrides,
  };
}

/**
 * 构造文本消息
 * @param text - 正文
 * @returns 微信消息
 */
function textMessage(text: string): WeixinMessage {
  return {
    message_type: MessageType.USER,
    from_user_id: 'u',
    message_id: `m-${Math.random()}`,
    context_token: 'ctx',
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

/**
 * 构造运行时
 * @param deps - 覆盖依赖
 * @returns 运行时与 spies
 */
function makeRuntime(deps: ServiceDeps = {}) {
  const state: State = { ...DEFAULT_STATE, sessions: {}, models: {}, contextTokens: {} };
  const sent: string[] = [];
  const sendText = vi.fn(async (params: { text: string }) => {
    sent.push(params.text);
    return { ret: 0, message_id: `m${sent.length}` };
  });
  const runQoder = vi.fn(async (input: { onStart?: (cancel: () => void) => void; name?: string }) => {
    input.onStart?.(() => undefined);
    return { ok: true, text: 'reply', sessionId: 's1', modelUsed: 'x', exitCode: 0, durationMs: 1 };
  });
  const runtime = createBridgeRuntime(makeConfig(), state, {
    sendText,
    runQoder,
    getTypingTicket: vi.fn(async () => ''),
    sendTyping: vi.fn(async () => undefined),
    takePending: vi.fn(() => []),
    loadPersona: vi.fn(() => ''),
    listModels: vi.fn(() => [{ label: 'Auto', id: 'Auto', custom: false }]),
    downloadItemMedia: vi.fn(async () => null),
    listSessions: vi.fn(() => CATALOG),
    renameSession: vi.fn(async () => ({ ok: true as const })),
    ...deps,
  });
  return { runtime, state, sent, runQoder, sendText };
}

describe('注册表分发接线', () => {
  it('应该经 processTask 执行 /sessions 并列清单', async () => {
    const { runtime, sent } = makeRuntime();
    await runtime.processTask('u', '/sessions', 'ctx');
    expect(sent[0]).toContain('会话清单');
    expect(sent[0]).toContain('探针新名');
  });

  it('应该 /sessions 后按序号 /switch 改指针', async () => {
    const { runtime, state } = makeRuntime();
    await runtime.processTask('u', '/sessions', 'ctx');
    await runtime.processTask('u', '/switch 2', 'ctx');
    expect(state.sessions.u?.sessionId).toBe(UUID2);
  });

  it('应该 /new 清指针且不调 CLI', async () => {
    const { runtime, state, runQoder } = makeRuntime();
    state.sessions.u = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    await runtime.processTask('u', '/new', 'ctx');
    expect(state.sessions.u).toBeUndefined();
    expect(runQoder).not.toHaveBeenCalled();
  });

  it('应该 /new 名称后下条消息经 -n 创建，成功后清待用名', async () => {
    const { runtime, runQoder } = makeRuntime();
    await runtime.processTask('u', '/new 登录页重构', 'ctx');
    await runtime.processTask('u', 'hello', 'ctx');
    expect(runQoder.mock.calls[0][0]).toMatchObject({ name: '登录页重构' });
    expect(runQoder.mock.calls[0][0].sessionId).toBeUndefined();
    await runtime.processTask('u', 'hello again', 'ctx');
    expect(runQoder.mock.calls[1][0].name).toBeUndefined();
    expect(runQoder.mock.calls[1][0].sessionId).toBe('s1');
  });

  it('应该 /rename 调用 renameSession', async () => {
    const renameSession = vi.fn(async () => ({ ok: true as const }));
    const { runtime, state, sent } = makeRuntime({ renameSession });
    state.sessions.u = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    await runtime.processTask('u', '/rename 新名', 'ctx');
    expect(renameSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: UUID1, name: '新名' }));
    expect(sent[0]).toContain('重命名');
  });

  it('应该保持普通消息黄金路径', async () => {
    const { runtime, sent, state } = makeRuntime();
    await runtime.processTask('u', 'hello', 'ctx');
    expect(sent).toEqual(['reply']);
    expect(state.sessions.u?.sessionId).toBe('s1');
  });

  it('应该保持 /help 与未知命令提示', async () => {
    const { runtime, sent } = makeRuntime();
    await runtime.processTask('u', '/help', 'ctx');
    expect(sent[0]).toContain('可用命令');
    await runtime.processTask('u', '/nope', 'ctx');
    expect(sent[1]).toContain('未知命令');
  });

  it('应该在命令处理器抛错时给可读回复而非静默（P1-4）', async () => {
    const listModels = vi.fn(() => {
      throw new Error('boom');
    });
    const { runtime, sent } = makeRuntime({ listModels });
    await runtime.processTask('u', '/model', 'ctx');
    expect(sent.some((t) => t.includes('命令执行出错'))).toBe(true);
  });

  it('应该经 processTask 走 /delete 两步确认并清活动会话指针', async () => {
    const deletedCatalog = CATALOG.filter((e) => e.sessionId !== UUID2);
    let listCalls = 0;
    const listSessions = vi.fn(() => {
      listCalls += 1;
      return listCalls <= 2 ? CATALOG : deletedCatalog;
    });
    const deleteSession = vi.fn(async () => ({ ok: true as const }));
    const { runtime, state, sent } = makeRuntime({ listSessions, deleteSession });
    state.sessions.u = { sessionId: UUID2, updatedAt: 1, turns: 1 };
    await runtime.processTask('u', '/delete 2', 'ctx');
    expect(sent[0]).toContain('/delete yes 2');
    await runtime.processTask('u', '/delete yes 2', 'ctx');
    expect(deleteSession).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
    expect(sent[1]).toContain('已删除');
    expect(state.sessions.u).toBeUndefined();
  });
});

describe('intake 变更命令守卫', () => {
  it('应该在任务运行中拒绝 /switch 但放行 /sessions', async () => {
    let release: () => void = () => undefined;
    const hanging = vi.fn((input: { onStart?: (c: () => void) => void }) => {
      input.onStart?.(() => undefined);
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, text: 'reply', sessionId: 's1', durationMs: 1, exitCode: 0 });
      });
    });
    const { runtime, sent } = makeRuntime({ runQoder: hanging as never });

    await runtime.handleInbound(textMessage('hello'));
    await vi.waitFor(() => expect(hanging).toHaveBeenCalled());

    await runtime.handleInbound(textMessage('/switch 2'));
    expect(sent.some((t) => t.includes('任务执行中'))).toBe(true);

    await runtime.handleInbound(textMessage('/sessions'));
    expect(sent.filter((t) => t.includes('任务执行中'))).toHaveLength(1);

    release();
    await runtime.waitForIdle();
  });
});