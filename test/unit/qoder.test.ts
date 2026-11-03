import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanEnv, runQoder, type QoderRunInput } from '../../src/bridge/qoder.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-qodercli.mjs', import.meta.url));
let root = '';

beforeAll(() => {
  if (process.platform !== 'win32') fs.chmodSync(fixture, 0o755);
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-qoder-'));
});

afterEach(() => {
  delete process.env.FAKE_QODER_MODE;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * 用假 qodercli 跑一次
 * @param mode - 假 CLI 模式
 * @param overrides - 覆盖输入
 * @returns 执行结果
 */
function run(mode: string, overrides: Partial<QoderRunInput> = {}): ReturnType<typeof runQoder> {
  process.env.FAKE_QODER_MODE = mode;
  return runQoder({
    prompt: 'hi',
    timeoutMs: 2_000,
    bin: fixture,
    permissionMode: 'dont_ask',
    taskId: 'task-1',
    diagnosticDir: root,
    ...overrides,
  });
}

describe('cleanEnv', () => {
  it('应该移除 QODER / CLAUDE SDK 变量并回填记忆开关', () => {
    const saved = {
      QODER_FOO: process.env.QODER_FOO,
      CLAUDECODE: process.env.CLAUDECODE,
      CLAUDE_CODE_X: process.env.CLAUDE_CODE_X,
      KEEP_ME: process.env.KEEP_ME,
    };
    process.env.QODER_FOO = '1';
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_X = '1';
    process.env.KEEP_ME = '1';

    const env = cleanEnv({ memory: true });

    expect(env.QODER_FOO).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_X).toBeUndefined();
    expect(env.KEEP_ME).toBe('1');
    expect(env.QODER_MEMORY_HEADLESS).toBe('1');

    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('应该在关闭记忆时不设置记忆开关', () => {
    expect(cleanEnv({ memory: false }).QODER_MEMORY_HEADLESS).toBeUndefined();
  });
});

describe('runQoder 结果解析', () => {
  it('应该在成功时返回文本、会话与模型', async () => {
    const result = await run('ok');

    expect(result.ok).toBe(true);
    expect(result.text).toBe('hello');
    expect(result.sessionId).toBe('s1');
    expect(result.modelUsed).toBe('model-x');
    expect(result.exitCode).toBe(0);
  });

  it('应该在退出码非 0 时按失败处理', async () => {
    const result = await run('exit1');

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('exit');
    expect(result.exitCode).toBe(1);
    expect(result.error?.length).toBeLessThanOrEqual(300);
    expect(fs.readFileSync(result.diagnosticPath as string, 'utf-8')).toContain('partial');
  });

  it('应该在 is_error 时只返回错误首行', async () => {
    const result = await run('is_error');

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('is_error');
    expect(result.error).toContain('boom');
    expect(result.error).not.toContain('stack');
    expect(fs.readFileSync(result.diagnosticPath as string, 'utf-8')).toContain('stack');
  });

  it('应该在输出无法解析时返回 parse', async () => {
    const result = await run('parse');

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('parse');
    expect(result.error).toContain('无法解析');
  });

  it('应该在空输出时返回 empty', async () => {
    const result = await run('empty');
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('empty');

    const failed = await run('empty-fail');
    expect(failed.errorKind).toBe('empty');
    expect(failed.exitCode).toBe(1);
  });

  it('应该在 261KB stderr 时不把原文放进错误提示', async () => {
    const result = await run('stderr-261k');

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('parse');
    expect(result.error?.length).toBeLessThanOrEqual(300);
    expect(result.error).not.toContain('xxxxx');
    expect(fs.statSync(result.diagnosticPath as string).size).toBeLessThanOrEqual(64 * 1024);
  });

  it('应该在超时时返回 timeout', async () => {
    const result = await run('timeout', { timeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('timeout');
    expect(result.error).toContain('被终止');
  });

  it('应该在无法启动时返回 spawn', async () => {
    const result = await run('ok', { bin: path.join(root, 'missing-qodercli') });

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('spawn');
    expect(result.error).toContain('无法启动');
  });
});
