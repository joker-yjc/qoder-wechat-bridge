import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import spawn from 'cross-spawn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionError,
  formatSessionList,
  listSessions,
  parseSessionList,
  renameSession,
  resolveSession,
  type SessionEntry,
} from '../../src/bridge/sessions.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const UUID1 = '9a113144-7a3b-432f-b5fb-c6b560ccb43a';
const UUID2 = '3f2c8be1-1111-2222-3333-444455556666';
const UUID3 = '77aa09d2-aaaa-bbbb-cccc-ddddeeeeffff';

const SAMPLE = [
  'Available sessions for this project (3):',
  `  1. 探针新名 (2 分钟前) [${UUID1}]`,
  `  2. 登录页重构 (昨天) [${UUID2}]`,
  `  3. 接口治理 (3 天前) [${UUID3}]`,
].join('\n');

/**
 * 造一个可控的假子进程
 * @returns child 与触发器
 */
function fakeChild() {
  const stdout = new EventEmitter();
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const child = {
    stdout,
    kill: vi.fn(),
    on: (event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = cb;
      return child;
    },
  };
  return {
    child,
    emit: (event: string, arg?: unknown) => handlers[event]?.(arg),
    out: (text: string) => stdout.emit('data', Buffer.from(text)),
  };
}

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(spawn).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('parseSessionList', () => {
  it('应该解析正常多行并保留序号/名称/时间/id', () => {
    const entries = parseSessionList(SAMPLE);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ index: 1, name: '探针新名', lastActive: '2 分钟前', sessionId: UUID1 });
  });

  it('应该允许名称含空格、括号与中文', () => {
    const out = `  1. 重构 (登录页) 方案 (刚刚) [${UUID1}]`;
    const entries = parseSessionList(out);
    expect(entries[0].name).toBe('重构 (登录页) 方案');
    expect(entries[0].lastActive).toBe('刚刚');
  });

  it('应该在空清单（仅表头）时返回空数组', () => {
    expect(parseSessionList('Available sessions for this project (0):')).toEqual([]);
    expect(parseSessionList('')).toEqual([]);
  });

  it('应该把真实 CLI 空清单哨兵识别为空（P0-1）', () => {
    expect(parseSessionList('No previous sessions found for this project.')).toEqual([]);
    expect(parseSessionList('No previous sessions found for this project.\n')).toEqual([]);
  });

  it('应该把非会话提示行视为空而非解析失败（P0-1）', () => {
    expect(parseSessionList('Some warning line without session id')).toEqual([]);
  });

  it('应该在存在疑似会话行却无法解析时才抛 parse（P0-1）', () => {
    const malformed = '  1. 名称 (时间) [aaaaaaaa-0000-0000-0000-000000000000] 额外尾巴导致不匹配';
    expect(() => parseSessionList(malformed)).toThrow(SessionError);
  });

  it('应该忽略坏行但保留可解析行', () => {
    const out = ['garbage line', `  1. 名称 (时间) [${UUID1}]`].join('\n');
    expect(parseSessionList(out)).toHaveLength(1);
  });

  it('应该在疑似会话行全部无法解析时抛 parse 错误', () => {
    const bad = '  x. 名称 (时间) [aaaaaaaa-0000-0000-0000-000000000000] trailing';
    expect(() => parseSessionList(bad)).toThrow(SessionError);
    try {
      parseSessionList(bad);
    } catch (err) {
      expect((err as SessionError).kind).toBe('parse');
    }
  });
});

describe('listSessions', () => {
  it('应该透传 cwd 并解析输出', () => {
    vi.mocked(execFileSync).mockReturnValue(SAMPLE);
    const entries = listSessions('qodercli', '/work');
    expect(entries).toHaveLength(3);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'qodercli',
      ['--list-sessions'],
      expect.objectContaining({ cwd: '/work' }),
    );
  });

  it('应该在 ENOENT 时抛 not_installed', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    });
    expect(() => listSessions('qodercli', '/work')).toThrow(/未安装或工作目录不存在/);
  });

  it('应该在超时时抛 timeout（真实错误形状 ETIMEDOUT/signal:null）', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('spawnSync qodercli ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        signal: null,
        status: 143,
      });
    });
    expect(() => listSessions('qodercli', '/work')).toThrow(/超时/);
  });

  it('应该兼容 killed/SIGTERM 形状的超时', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    });
    expect(() => listSessions('qodercli', '/work')).toThrow(/超时/);
  });

  it('应该在其它启动失败时抛 spawn', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => listSessions('qodercli', '/work')).toThrow(/列出会话失败/);
  });
});

describe('resolveSession', () => {
  const catalog: SessionEntry[] = parseSessionList(SAMPLE);

  it('应该按序号命中', () => {
    const r = resolveSession('2', catalog);
    expect(r.ok && r.entry.sessionId).toBe(UUID2);
  });

  it('应该在序号越界时失败', () => {
    expect(resolveSession('9', catalog)).toEqual({ ok: false, reason: '序号越界' });
  });

  it('应该按 CLI 序号而非数组位置解析（P1-2 坏行错位）', () => {
    const sparse: SessionEntry[] = [
      { index: 1, name: '甲', lastActive: '', sessionId: UUID1 },
      { index: 3, name: '乙', lastActive: '', sessionId: UUID2 },
    ];
    const r3 = resolveSession('3', sparse);
    expect(r3.ok && r3.entry.name).toBe('乙');
    expect(resolveSession('2', sparse)).toEqual({ ok: false, reason: '序号越界' });
  });

  it('应该在显示名重复时报不唯一（P1-3）', () => {
    const dup: SessionEntry[] = [
      { index: 1, name: '你好', lastActive: '', sessionId: UUID1 },
      { index: 2, name: '你好', lastActive: '', sessionId: UUID2 },
    ];
    expect(resolveSession('你好', dup)).toEqual({ ok: false, reason: '名称不唯一' });
  });

  it('应该按完整 id 命中', () => {
    const r = resolveSession(UUID1, catalog);
    expect(r.ok && r.entry.index).toBe(1);
  });

  it('应该按唯一短 id 命中', () => {
    const r = resolveSession('9a11', catalog);
    expect(r.ok && r.entry.sessionId).toBe(UUID1);
  });

  it('应该在短 id 不唯一时失败', () => {
    const dup: SessionEntry[] = [
      { index: 1, name: 'a', lastActive: '', sessionId: 'abcd1111-0000-0000-0000-000000000000' },
      { index: 2, name: 'b', lastActive: '', sessionId: 'abcd2222-0000-0000-0000-000000000000' },
    ];
    expect(resolveSession('abcd', dup)).toEqual({ ok: false, reason: 'id 不唯一' });
  });

  it('应该按名称大小写不敏感命中', () => {
    const r = resolveSession('探针新名', catalog);
    expect(r.ok && r.entry.sessionId).toBe(UUID1);
  });

  it('应该在未找到时失败', () => {
    expect(resolveSession('不存在', catalog)).toEqual({ ok: false, reason: '未找到' });
    expect(resolveSession('', catalog)).toEqual({ ok: false, reason: '未指定目标' });
  });
});

describe('formatSessionList', () => {
  const catalog: SessionEntry[] = parseSessionList(SAMPLE);

  it('应该标记活动会话并截断 id 到 8 位', () => {
    const text = formatSessionList(catalog, UUID2, 10);
    expect(text).toContain(`[${UUID2.slice(0, 8)}] ← 当前`);
    expect(text).toContain('探针新名');
  });

  it('应该在空清单时返回友好提示', () => {
    expect(formatSessionList([], undefined, 10)).toContain('还没有会话');
  });

  it('应该在超过上限时截断并提示', () => {
    const text = formatSessionList(catalog, undefined, 2);
    expect(text).toContain('仅显示最近 2 条');
    expect(text).not.toContain('接口治理');
  });
});

describe('renameSession', () => {
  const input = {
    bin: 'qodercli',
    cwd: '/work',
    sessionId: UUID1,
    name: '新名',
    timeoutMs: 5_000,
    permissionMode: 'dont_ask',
  };

  it('应该用 -r -n -p 起子进程并在成功时返回 ok', async () => {
    const fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child as never);
    const promise = renameSession(input);
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('-r');
    expect(args).toContain(UUID1);
    expect(args).toContain('-n');
    expect(args).toContain('新名');
    expect(args).toContain('-p');
    fake.out(JSON.stringify({ is_error: false }));
    fake.emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('应该在 is_error 时返回失败', async () => {
    const fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child as never);
    const promise = renameSession(input);
    fake.out(JSON.stringify({ is_error: true }));
    fake.emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: false, error: '未生效' });
  });

  it('应该在非零退出码时返回失败', async () => {
    const fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child as never);
    const promise = renameSession(input);
    fake.emit('close', 1);
    await expect(promise).resolves.toEqual({ ok: false, error: '失败，请稍后重试' });
  });

  it('应该在 spawn 错误时返回失败', async () => {
    const fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child as never);
    const promise = renameSession(input);
    fake.emit('error', new Error('ENOENT'));
    await expect(promise).resolves.toEqual({ ok: false, error: '无法启动 Qoder CLI' });
  });

  it('应该在输出无法解析时返回失败', async () => {
    const fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child as never);
    const promise = renameSession(input);
    fake.out('not json');
    fake.emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: false, error: '输出异常' });
  });

  it('应该在超时时 kill 并返回失败', async () => {
    vi.useFakeTimers();
    const fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child as never);
    const promise = renameSession({ ...input, timeoutMs: 100 });
    vi.advanceTimersByTime(100);
    expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL');
    fake.emit('close', null);
    await expect(promise).resolves.toEqual({ ok: false, error: '超时，请稍后重试' });
    vi.useRealTimers();
  });
});

describe('deleteSession', () => {
  const input = { bin: 'qodercli', cwd: '/work', index: 1, timeoutMs: 5_000 };

  it('应该用 --delete-session <index> 起子进程并在 stdout 含 Deleted session 时成功', async () => {
    const { deleteSession } = await import('../../src/bridge/sessions.js');
    const fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child as never);
    const promise = deleteSession(input);
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('--delete-session');
    expect(args[args.indexOf('--delete-session') + 1]).toBe('1');
    fake.out('Deleted session 1: 名称 (Just now)');
    fake.emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('应该在 stdout 无 Deleted session（序号不存在）时判失败', async () => {
    const { deleteSession } = await import('../../src/bridge/sessions.js');
    const fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child as never);
    const promise = deleteSession(input);
    fake.out('');
    fake.emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: false, error: '未找到该序号的会话或删除失败' });
  });

  it('应该在 spawn 错误时返回失败', async () => {
    const { deleteSession } = await import('../../src/bridge/sessions.js');
    const fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child as never);
    const promise = deleteSession(input);
    fake.emit('error', new Error('ENOENT'));
    await expect(promise).resolves.toEqual({ ok: false, error: '无法启动 Qoder CLI' });
  });

  it('应该在超时时 kill 并返回失败', async () => {
    const { deleteSession } = await import('../../src/bridge/sessions.js');
    vi.useFakeTimers();
    const fake = fakeChild();
    vi.mocked(spawn).mockReturnValue(fake.child as never);
    const promise = deleteSession({ ...input, timeoutMs: 100 });
    vi.advanceTimersByTime(100);
    expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL');
    fake.emit('close', null);
    await expect(promise).resolves.toEqual({ ok: false, error: '超时，请稍后重试' });
    vi.useRealTimers();
  });
});