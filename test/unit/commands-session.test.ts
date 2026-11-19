import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_STATE, type Config, type State } from '../../src/config.js';
import { log } from '../../src/log.js';
import { dispatchCommand, type CommandContext } from '../../src/commands.js';
import { SessionError, type SessionEntry } from '../../src/bridge/sessions.js';

const UUID1 = '9a113144-7a3b-432f-b5fb-c6b560ccb43a';
const UUID2 = '3f2c8be1-1111-2222-3333-444455556666';
const CATALOG: SessionEntry[] = [
  { index: 1, name: '探针新名', lastActive: '2 分钟前', sessionId: UUID1 },
  { index: 2, name: '登录页重构', lastActive: '昨天', sessionId: UUID2 },
];

/**
 * 造测试上下文
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
      listSessions: vi.fn(() => CATALOG),
      renameSession: vi.fn(async () => ({ ok: true as const })),
      deleteSession: vi.fn(async () => ({ ok: true as const })),
      listModels: () => [],
    },
    log,
    ...overrides,
  };
  return { ctx, replies };
}

beforeEach(() => vi.clearAllMocks());

describe('/sessions 处理器', () => {
  it('应该列清单、标活动会话并刷新缓存，且不改指针', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    expect(await dispatchCommand(ctx, '/sessions')).toBe(true);
    expect(replies[0]).toContain('← 当前');
    expect(ctx.catalogs.get('u1')).toEqual(CATALOG);
    expect(ctx.state.sessions.u1.sessionId).toBe(UUID1);
  });

  it('应该在清单失败时回中文错误', async () => {
    const { ctx, replies } = makeCtx();
    ctx.deps.listSessions = vi.fn(() => {
      throw new SessionError('timeout', '列出会话超时，请稍后重试');
    });
    expect(await dispatchCommand(ctx, '/sessions')).toBe(true);
    expect(replies[0]).toContain('无法列出会话');
  });

  it('应该标 requiresIdle=false（只读）', async () => {
    const { ctx } = makeCtx();
    const { findHandler } = await import('../../src/commands.js');
    expect(findHandler('/sessions')?.requiresIdle).toBe(false);
  });
});

describe('/switch 处理器', () => {
  it('应该按序号用缓存切换并改指针', async () => {
    const { ctx, replies } = makeCtx();
    ctx.catalogs.set('u1', CATALOG);
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 2 };
    expect(await dispatchCommand(ctx, '/switch 2')).toBe(true);
    expect(ctx.state.sessions.u1.sessionId).toBe(UUID2);
    expect(ctx.state.sessions.u1.turns).toBe(2);
    expect(ctx.persistState).toHaveBeenCalled();
    expect(replies[0]).toContain('已切换到');
    expect(ctx.deps.listSessions).not.toHaveBeenCalled();
  });

  it('应该在序号无缓存时提示先 /sessions', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/switch 1')).toBe(true);
    expect(replies[0]).toContain('请先发 /sessions');
  });

  it('应该按名称用新鲜清单切换', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/switch 登录页重构')).toBe(true);
    expect(ctx.deps.listSessions).toHaveBeenCalled();
    expect(ctx.state.sessions.u1.sessionId).toBe(UUID2);
    expect(replies[0]).toContain('已切换到');
  });

  it('应该在目标即当前时提示已在该会话', async () => {
    const { ctx, replies } = makeCtx();
    ctx.catalogs.set('u1', CATALOG);
    ctx.state.sessions.u1 = { sessionId: UUID2, updatedAt: 1, turns: 0 };
    expect(await dispatchCommand(ctx, '/switch 2')).toBe(true);
    expect(replies[0]).toContain('已在该会话');
    expect(ctx.persistState).not.toHaveBeenCalled();
  });

  it('应该在无参时给用法不改指针', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/switch')).toBe(true);
    expect(replies[0]).toContain('用法');
    expect(ctx.persistState).not.toHaveBeenCalled();
  });

  it('应该在序号越界时提示', async () => {
    const { ctx, replies } = makeCtx();
    ctx.catalogs.set('u1', CATALOG);
    expect(await dispatchCommand(ctx, '/switch 9')).toBe(true);
    expect(replies[0]).toContain('序号越界');
  });

  it('应该在清单调用抛错时回中文错误', async () => {
    const { ctx, replies } = makeCtx();
    ctx.deps.listSessions = vi.fn(() => {
      throw new SessionError('timeout', '列出会话超时，请稍后重试');
    });
    expect(await dispatchCommand(ctx, '/switch 登录页重构')).toBe(true);
    expect(replies[0]).toContain('无法切换会话');
  });

  it('应该标 requiresIdle=true', async () => {
    const { findHandler } = await import('../../src/commands.js');
    expect(findHandler('/switch')?.requiresIdle).toBe(true);
  });
});

describe('/new 处理器', () => {
  it('应该清指针、无名称时清待用名且不调 CLI', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    ctx.pendingNames.set('u1', '旧名');
    expect(await dispatchCommand(ctx, '/new')).toBe(true);
    expect(ctx.state.sessions.u1).toBeUndefined();
    expect(ctx.pendingNames.has('u1')).toBe(false);
    expect(ctx.deps.listSessions).not.toHaveBeenCalled();
    expect(replies[0]).toContain('已开启新会话');
  });

  it('应该带名称时记待用名', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/new 登录页重构')).toBe(true);
    expect(ctx.pendingNames.get('u1')).toBe('登录页重构');
    expect(replies[0]).toContain('登录页重构');
  });

  it('应该在名称超长时拒绝且不清指针', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    expect(await dispatchCommand(ctx, `/new ${'x'.repeat(61)}`)).toBe(true);
    expect(replies[0]).toContain('名称过长');
    expect(ctx.state.sessions.u1.sessionId).toBe(UUID1);
  });
});

describe('/rename 处理器', () => {
  it('应该在无会话时提示', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/rename 新名')).toBe(true);
    expect(replies[0]).toContain('当前没有会话');
    expect(ctx.deps.renameSession).not.toHaveBeenCalled();
  });

  it('应该在名称为空时给用法', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    expect(await dispatchCommand(ctx, '/rename')).toBe(true);
    expect(replies[0]).toContain('用法');
  });

  it('应该成功时回显新名', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    expect(await dispatchCommand(ctx, '/rename 新名')).toBe(true);
    expect(ctx.deps.renameSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: UUID1, name: '新名' }));
    expect(replies[0]).toContain('已把当前会话重命名为');
  });

  it('应该在 renameSession 失败时回中文错误', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    ctx.deps.renameSession = vi.fn(async () => ({ ok: false as const, error: '未生效' }));
    expect(await dispatchCommand(ctx, '/rename 新名')).toBe(true);
    expect(replies[0]).toContain('重命名失败');
  });

  it('应该在名称超长时拒绝', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    expect(await dispatchCommand(ctx, `/rename ${'x'.repeat(61)}`)).toBe(true);
    expect(replies[0]).toContain('名称过长');
    expect(ctx.deps.renameSession).not.toHaveBeenCalled();
  });

  it('应该在 renameSession 抛错时回中文错误', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    ctx.deps.renameSession = vi.fn(async () => {
      throw new SessionError('rename', '无法启动');
    });
    expect(await dispatchCommand(ctx, '/rename 新名')).toBe(true);
    expect(replies[0]).toContain('重命名失败');
  });

  it('应该拒绝含换行或 - 开头的名称（Minor-8）', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 1 };
    expect(await dispatchCommand(ctx, '/rename 坏\n名')).toBe(true);
    expect(replies[0]).toContain('控制字符');
    expect(await dispatchCommand(ctx, '/rename -flag')).toBe(true);
    expect(replies[1]).toContain('- 开头');
    expect(ctx.deps.renameSession).not.toHaveBeenCalled();
  });
});

describe('待用名生命周期（Minor-5）', () => {
  it('/switch 成功后应该清待用名', async () => {
    const { ctx } = makeCtx();
    ctx.catalogs.set('u1', CATALOG);
    ctx.pendingNames.set('u1', '旧名');
    await dispatchCommand(ctx, '/switch 2');
    expect(ctx.pendingNames.has('u1')).toBe(false);
  });

  it('/reset 应该清待用名', async () => {
    const { ctx } = makeCtx();
    ctx.pendingNames.set('u1', '旧名');
    await dispatchCommand(ctx, '/reset');
    expect(ctx.pendingNames.has('u1')).toBe(false);
  });

  it('/new 应该拒绝含控制字符的名称（Minor-8）', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/new 坏\n名')).toBe(true);
    expect(replies[0]).toContain('控制字符');
    expect(ctx.pendingNames.has('u1')).toBe(false);
  });
});

describe('/delete 两步确认', () => {
  const deletedCatalog = CATALOG.filter((e) => e.sessionId !== UUID2);
  /** 前两次列会话返回完整清单（解析+取序号），之后返回已删 UUID2 的清单（re-list 复核） */
  function listSeq() {
    let n = 0;
    return vi.fn(() => {
      n += 1;
      return n <= 2 ? CATALOG : deletedCatalog;
    });
  }
  /** 造一个成功删除的 deps（re-list 复核会看到 UUID2 消失） */
  function okDeps() {
    return { listSessions: listSeq(), renameSession: vi.fn(), deleteSession: vi.fn(async () => ({ ok: true as const })), listModels: () => [] };
  }

  it('第一步应该记待确认并回确认提示', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/delete 2')).toBe(true);
    expect(ctx.pendingDeletes.get('u1')?.sessionId).toBe(UUID2);
    expect(replies[0]).toContain('/delete yes 2');
    expect(ctx.deps.deleteSession).not.toHaveBeenCalled();
  });

  it('第二步序号匹配应该真删、清待确认并失效缓存（I-1）', async () => {
    const { ctx, replies } = makeCtx({ deps: okDeps() });
    await dispatchCommand(ctx, '/delete 2');
    expect(ctx.catalogs.has('u1')).toBe(true);
    expect(await dispatchCommand(ctx, '/delete yes 2')).toBe(true);
    expect(ctx.deps.deleteSession).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
    expect(ctx.pendingDeletes.has('u1')).toBe(false);
    expect(ctx.catalogs.has('u1')).toBe(false);
    expect(replies[1]).toContain('已删除');
  });

  it('删除活动会话应该清指针', async () => {
    const { ctx } = makeCtx({ deps: okDeps() });
    ctx.state.sessions.u1 = { sessionId: UUID2, updatedAt: 1, turns: 1 };
    await dispatchCommand(ctx, '/delete 2');
    await dispatchCommand(ctx, '/delete yes 2');
    expect(ctx.state.sessions.u1).toBeUndefined();
  });

  it('re-list 仍在应该判未生效且不清活动指针（F-1/F-2）', async () => {
    const { ctx, replies } = makeCtx();
    ctx.state.sessions.u1 = { sessionId: UUID2, updatedAt: 1, turns: 1 };
    await dispatchCommand(ctx, '/delete 2');
    expect(await dispatchCommand(ctx, '/delete yes 2')).toBe(true);
    expect(replies[1]).toContain('删除未生效');
    expect(ctx.state.sessions.u1?.sessionId).toBe(UUID2);
    expect(ctx.catalogs.has('u1')).toBe(false);
  });

  it('序号不匹配应该拒绝', async () => {
    const { ctx, replies } = makeCtx();
    await dispatchCommand(ctx, '/delete 2');
    expect(await dispatchCommand(ctx, '/delete yes 1')).toBe(true);
    expect(replies[1]).toContain('序号不匹配');
    expect(ctx.deps.deleteSession).not.toHaveBeenCalled();
  });

  it('无待确认时 yes 应该提示', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/delete yes 1')).toBe(true);
    expect(replies[0]).toContain('没有待确认');
  });

  it('确认过期应该提示', async () => {
    const { ctx, replies } = makeCtx();
    await dispatchCommand(ctx, '/delete 2');
    const pending = ctx.pendingDeletes.get('u1')!;
    ctx.pendingDeletes.set('u1', { ...pending, expiresAt: Date.now() - 1 });
    expect(await dispatchCommand(ctx, '/delete yes 2')).toBe(true);
    expect(replies[1]).toContain('过期');
  });

  it('无参应该给用法，yes 无序号应该提示', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/delete')).toBe(true);
    expect(replies[0]).toContain('用法');
    expect(await dispatchCommand(ctx, '/delete yes')).toBe(true);
    expect(replies[1]).toContain('请带序号');
  });

  it('目标未找到应该提示', async () => {
    const { ctx, replies } = makeCtx();
    expect(await dispatchCommand(ctx, '/delete 不存在')).toBe(true);
    expect(replies[0]).toContain('没找到会话');
  });

  it('应该标 requiresIdle=true', async () => {
    const { findHandler } = await import('../../src/commands.js');
    expect(findHandler('/delete')?.requiresIdle).toBe(true);
  });

  it('确认阶段清单抛错应该回中文错误并失效缓存（F-3）', async () => {
    const { ctx, replies } = makeCtx();
    ctx.catalogs.set('u1', CATALOG);
    ctx.pendingDeletes.set('u1', { sessionId: UUID2, name: '乙', index: 2, expiresAt: Date.now() + 60000 });
    ctx.deps.listSessions = vi.fn(() => {
      throw new SessionError('timeout', '列出会话超时');
    });
    expect(await dispatchCommand(ctx, '/delete yes 2')).toBe(true);
    expect(replies[0]).toContain('删除失败');
    expect(ctx.catalogs.has('u1')).toBe(false);
  });

  it('确认阶段会话已不存在应该提示', async () => {
    const { ctx, replies } = makeCtx();
    ctx.pendingDeletes.set('u1', { sessionId: 'nonexistent', name: 'X', index: 2, expiresAt: Date.now() + 60000 });
    expect(await dispatchCommand(ctx, '/delete yes 2')).toBe(true);
    expect(replies[0]).toContain('已不存在');
  });

  it('确认阶段 deleteSession 失败应该回错误并失效缓存（F-3）', async () => {
    const { ctx, replies } = makeCtx();
    ctx.catalogs.set('u1', CATALOG);
    ctx.pendingDeletes.set('u1', { sessionId: UUID2, name: '乙', index: 2, expiresAt: Date.now() + 60000 });
    ctx.deps.deleteSession = vi.fn(async () => ({ ok: false as const, error: '未找到该序号的会话或删除失败' }));
    expect(await dispatchCommand(ctx, '/delete yes 2')).toBe(true);
    expect(replies[0]).toContain('删除失败');
    expect(ctx.catalogs.has('u1')).toBe(false);
  });

  it('第一步清单抛错应该回中文错误', async () => {
    const { ctx, replies } = makeCtx();
    ctx.deps.listSessions = vi.fn(() => {
      throw new SessionError('timeout', '列出会话超时');
    });
    expect(await dispatchCommand(ctx, '/delete 2')).toBe(true);
    expect(replies[0]).toContain('无法删除会话');
  });

  it('删除成功后应该失效序号缓存（I-1）', async () => {
    const { ctx } = makeCtx({ deps: okDeps() });
    await dispatchCommand(ctx, '/delete 2');
    expect(ctx.catalogs.has('u1')).toBe(true);
    await dispatchCommand(ctx, '/delete yes 2');
    expect(ctx.catalogs.has('u1')).toBe(false);
  });

  it('/new 与 /reset 应该清待确认删除（Minor）', async () => {
    const { ctx } = makeCtx();
    await dispatchCommand(ctx, '/delete 2');
    expect(ctx.pendingDeletes.has('u1')).toBe(true);
    await dispatchCommand(ctx, '/reset');
    expect(ctx.pendingDeletes.has('u1')).toBe(false);
    await dispatchCommand(ctx, '/delete 2');
    await dispatchCommand(ctx, '/new');
    expect(ctx.pendingDeletes.has('u1')).toBe(false);
  });
});

describe('命令处理器后端适配', () => {
  /** CN 后端上下文 */
  function cnCtx() {
    return makeCtx({ config: { ...DEFAULT_CONFIG, qoderBin: 'qoderclicn' } });
  }

  it('/switch 写指针应该带当前 bin', async () => {
    const { ctx } = cnCtx();
    ctx.catalogs.set('u1', CATALOG);
    expect(await dispatchCommand(ctx, '/switch 1')).toBe(true);
    expect(ctx.state.sessions.u1?.bin).toBe('qoderclicn');
    expect(ctx.state.sessions.u1?.sessionId).toBe(UUID1);
  });

  it('/switch 跨后端旧指针 turns 不串后端', async () => {
    const { ctx } = cnCtx();
    ctx.state.sessions.u1 = { sessionId: 'old', updatedAt: 1, turns: 9, bin: 'qodercli' };
    ctx.catalogs.set('u1', CATALOG);
    expect(await dispatchCommand(ctx, '/switch 1')).toBe(true);
    expect(ctx.state.sessions.u1?.turns).toBe(0);
    expect(ctx.state.sessions.u1?.bin).toBe('qoderclicn');
  });

  it('/rename 跨后端旧指针应该提示当前没有会话且不调 CLI', async () => {
    const { ctx, replies } = cnCtx();
    ctx.state.sessions.u1 = { sessionId: 'old', updatedAt: 1, turns: 1, bin: 'qodercli' };
    expect(await dispatchCommand(ctx, '/rename 新名')).toBe(true);
    expect(replies[0]).toContain('当前没有会话');
    expect(ctx.deps.renameSession).not.toHaveBeenCalled();
  });

  it('/sessions 跨后端旧指针不标当前', async () => {
    const { ctx, replies } = cnCtx();
    ctx.state.sessions.u1 = { sessionId: UUID1, updatedAt: 1, turns: 1, bin: 'qodercli' };
    expect(await dispatchCommand(ctx, '/sessions')).toBe(true);
    expect(replies[0]).not.toContain('← 当前');
  });
});