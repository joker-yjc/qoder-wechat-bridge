import { EventEmitter } from 'node:events';
import spawn from 'cross-spawn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runQoder, type QoderRunInput } from '../../src/bridge/qoder.js';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

/**
 * 造一个假子进程，捕获 args 并模拟成功结果
 * @returns child 与触发器
 */
function fakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const child = {
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(),
    on: (event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = cb;
      return child;
    },
  };
  return { child, emit: (e: string, a?: unknown) => handlers[e]?.(a), out: (t: string) => stdout.emit('data', Buffer.from(t)) };
}

/**
 * 跑一次 runQoder 并返回捕获的 args
 * @param overrides - 覆盖输入
 * @returns args
 */
async function captureArgs(overrides: Partial<QoderRunInput> = {}): Promise<string[]> {
  const fake = fakeChild();
  vi.mocked(spawn).mockReturnValue(fake.child as never);
  const promise = runQoder({
    prompt: 'hi',
    timeoutMs: 2_000,
    bin: 'qodercli',
    permissionMode: 'dont_ask',
    taskId: 't1',
    ...overrides,
  });
  const args = vi.mocked(spawn).mock.calls[0][1] as string[];
  fake.out(JSON.stringify({ result: 'ok', is_error: false, session_id: 's1' }));
  fake.emit('close', 0);
  await promise;
  return args;
}

beforeEach(() => vi.mocked(spawn).mockReset());
afterEach(() => vi.clearAllMocks());

describe('runQoder name 入参', () => {
  it('应该在传 name 时追加 -n', async () => {
    const args = await captureArgs({ name: '登录页重构' });
    const i = args.indexOf('-n');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('登录页重构');
  });

  it('应该在不传 name 时不含 -n', async () => {
    const args = await captureArgs();
    expect(args).not.toContain('-n');
  });

  it('应该在空白 name 时不追加 -n', async () => {
    const args = await captureArgs({ name: '   ' });
    expect(args).not.toContain('-n');
  });

  it('应该允许 name 与 sessionId 共存', async () => {
    const args = await captureArgs({ name: '新名', sessionId: 'sess-1' });
    expect(args).toContain('-n');
    expect(args).toContain('-r');
    expect(args[args.indexOf('-r') + 1]).toBe('sess-1');
  });
});