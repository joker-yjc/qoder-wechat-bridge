import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_STATE, type Config, type State } from '../../src/config.js';
import { log } from '../../src/log.js';
import {
  COMMANDS,
  dispatchCommand,
  findHandler,
  formatHelp,
  isUnknownCommand,
  type CommandContext,
} from '../../src/commands.js';
import { listSessions, renameSession } from '../../src/bridge/sessions.js';

/**
 * 造一个测试上下文
 * @param overrides - 覆盖字段
 * @returns 上下文与回复收集器
 */
function makeCtx(overrides: Partial<CommandContext> = {}): { ctx: CommandContext; replies: string[] } {
  const replies: string[] = [];
  const state: State = structuredClone(DEFAULT_STATE);
  const config: Config = { ...DEFAULT_CONFIG };
  const ctx: CommandContext = {
    userId: 'u1',
    contextToken: 'tok',
    state,
    config,
    reply: async (text) => {
      replies.push(text);
    },
    workdir: () => '/work',
    persistState: vi.fn(),
    catalogs: new Map(),
    pendingNames: new Map(),
    pendingDeletes: new Map(),
    isTaskRunning: () => false,
    deps: {
      listSessions,
      renameSession,
      deleteSession: vi.fn(async () => ({ ok: true as const })),
      listModels: () => [
        { label: 'Auto', id: 'Auto', custom: false },
        { label: 'Glm 5.3', id: 'glm-5.3', custom: false },
      ],
    },
    log,
    ...overrides,
  };
  return { ctx, replies };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('注册表', () => {
  it('应该由处理器派生 COMMANDS 且含既有四命令', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['/help', '/reset', '/status', '/model']));
  });

  it('应该按前缀匹配处理器（含带参数）', () => {
    expect(findHandler('/model')?.def.name).toBe('/model');
    expect(findHandler('/model glm')?.def.name).toBe('/model');
    expect(findHandler('/modelxyz')).toBeUndefined();
    expect(findHandler('普通消息')).toBeUndefined();
  });

  it('应该在未命中时 dispatchCommand 返回 false', async () => {
    const { ctx } = makeCtx();
    expect(await dispatchCommand(ctx, '普通消息')).toBe(false);
  });

  it('应该识别未知命令但不误判路径与已知命令', () => {
    expect(isUnknownCommand('/foo')).toBe(true);
    expect(isUnknownCommand('/help')).toBe(false);
    expect(isUnknownCommand('/Users/joke')).toBe(false);
  });

  it('应该生成中文 /help 含全部命令', () => {
    const text = formatHelp();
    expect(text).toContain('可用命令');
    expect(text).toContain('/help');
    expect(text).toContain('/model');
  });

  it('应该保留 /stop 元数据进 /help 且不参与注册表分发（P1-1）', () => {
    expect(formatHelp()).toContain('/stop');
    expect(isUnknownCommand('/stop')).toBe(false);
    expect(findHandler('/stop')).toBeUndefined();
  });

  it('应该对零参命令只做精确匹配，带参数交回 Qoder（P1-5）', () => {
    expect(findHandler('/reset 一下')).toBeUndefined();
    expect(findHandler('/help me')).toBeUndefined();
    expect(findHandler('/status x')).toBeUndefined();
    expect(findHandler('/sessions extra')).toBeUndefined();
    expect(findHandler('/reset')?.def.name).toBe('/reset');
    expect(findHandler('/model 3')?.def.name).toBe('/model');
    expect(findHandler('/switch 2')?.def.name).toBe('/switch');
    expect(findHandler('/new 名')?.def.name).toBe('/new');
  });
});

describe('既有命令处理器', () => {
  it('/help 应该回复命令清单', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/help')).toBe(true);
    expect(replies[0]).toContain('可用命令');
  });

  it('/reset 应该清指针并保存', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: 's1', updatedAt: 1, turns: 1 };
    expect(await dispatchCommand(ctx, '/reset')).toBe(true);
    expect(ctx.state.sessions.u1).toBeUndefined();
    expect(ctx.persistState).toHaveBeenCalled();
    expect(replies[0]).toContain('会话已重置');
  });

  it('/status 应该展示工作目录与会话', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: 's1', updatedAt: 1, turns: 3 };
    expect(await dispatchCommand(ctx, '/status')).toBe(true);
    expect(replies[0]).toContain('工作目录：/work');
    expect(replies[0]).toContain('后端：qodercli');
    expect(replies[0]).toContain('Qoder 会话：s1');
    expect(replies[0]).toContain('累计轮次：3');
  });

  it('/status 跨后端旧指针应该显示尚未创建并展示当前后端', async () => {
    const { ctx, replies } = makeCtx({ config: { ...DEFAULT_CONFIG, qoderBin: 'qoderclicn' } });
    ctx.state.sessions.u1 = { sessionId: 's1', updatedAt: 1, turns: 3, bin: 'qodercli' };
    expect(await dispatchCommand(ctx, '/status')).toBe(true);
    expect(replies[0]).toContain('后端：qoderclicn');
    expect(replies[0]).toContain('Qoder 会话：（尚未创建）');
    expect(replies[0]).toContain('累计轮次：0');
  });

  it('/model 无参应该列模型', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/model')).toBe(true);
    expect(replies[0]).toContain('Glm 5.3');
  });

  it('/model default 应该恢复默认', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.models.u1 = 'glm-5.3';
    expect(await dispatchCommand(ctx, '/model default')).toBe(true);
    expect(ctx.state.models.u1).toBeUndefined();
    expect(replies[0]).toContain('已恢复默认模型');
  });

  it('/model 名称应该切换', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/model glm-5.3')).toBe(true);
    expect(ctx.state.models.u1).toBe('glm-5.3');
    expect(replies[0]).toContain('已切换模型');
  });

  it('/model 未找到应该提示', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/model 不存在')).toBe(true);
    expect(replies[0]).toContain('未找到模型');
  });
});