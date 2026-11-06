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

describe('runQoder 语义错误归类', () => {
  it('应该把真实额度样本归类为模型额度耗尽并给出中文提示', async () => {
    const result = await run('quota-110');

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('exit');
    expect(result.errorClass).toBe('model_quota');
    expect(result.errorCode).toBe('110');
    expect(result.error).toBe('模型额度已用尽：今日调用次数达到上限。可稍后重试，或发 /model 切换模型。（退出码 1）');
  });

  it('应该把英文原文留在内部信号里而不出现在用户提示中', async () => {
    const result = await run('quota-110');

    expect(result.errorDetail).toBe(
      "You've reached your daily usage limit for Chat. Come back tomorrow to continue working with me. Report Issue (input /feedback)",
    );
    expect(result.error).not.toContain('daily usage limit');
    expect(result.sessionId).toBe('sess-quota');
    expect(result.modelUsed).toBe('<synthetic>');
  });

  it('应该把真实截断样本判为失败而不是成功', async () => {
    const result = await run('max-output-tokens');

    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe('output_limit');
    expect(result.errorCode).toBe('max_output_tokens');
    expect(result.error).toBe(
      '回答被截断：模型输出达到上限，本次没有完整结果。可发 /model 换输出上限更大的模型，或把任务拆小。（退出码 1）',
    );
    expect(result.error).not.toContain('output token limit');
  });

  it('应该把 authentication_failed 归类为凭据失效', async () => {
    const result = await run('auth-failed');

    expect(result.errorClass).toBe('auth');
    expect(result.errorCode).toBe('authentication_failed');
    expect(result.error).toBe('Qoder 凭据已失效：需在本机重新登录 qodercli 后重试。（退出码 1）');
    expect(result.error).not.toContain('authentication_failed');
  });

  it('应该把未收录的 error_code 归为 unknown 并沿用一期文案', async () => {
    const result = await run('semantic-unknown');

    expect(result.errorClass).toBe('unknown');
    expect(result.errorCode).toBe('rate_limit');
    expect(result.error).toBe('执行失败：qodercli 异常退出（退出码 1）。详见本机日志。');
    expect(result.errorDetail).toBe('Rate limit exceeded, please slow down.');
  });

  it('应该在退出码为 0 的 is_error 分支同样做语义归类', async () => {
    const result = await run('quota-110-exit0');

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('is_error');
    expect(result.errorClass).toBe('model_quota');
    expect(result.error).toContain('模型额度已用尽');
  });

  it('应该为续接降级保留内部原文', async () => {
    const result = await run('resume-failed');

    expect(result.errorDetail).toBe('No such session: resume not found');
    expect(result.errorDetail).toMatch(/session|resume|not found/i);
    expect(result.error).not.toContain('resume not found');
  });

  it('应该把语义字段写进诊断文件头', async () => {
    const result = await run('quota-110');
    const content = fs.readFileSync(result.diagnosticPath as string, 'utf-8');

    expect(content).toContain('# kind: exit');
    expect(content).toContain('# errorClass: model_quota');
    expect(content).toContain('# errorCode: 110');
  });

  it('应该让四类传输层失败归为 unknown 且文案与一期一致', async () => {
    const timeout = await run('timeout', { timeoutMs: 100 });
    expect(timeout.errorClass).toBe('unknown');
    expect(timeout.errorCode).toBeUndefined();
    expect(timeout.error).toContain('被终止');

    const spawn = await run('ok', { bin: path.join(root, 'missing-qodercli') });
    expect(spawn.errorClass).toBe('unknown');
    expect(spawn.error).toContain('无法启动');

    const empty = await run('empty');
    expect(empty.errorClass).toBe('unknown');
    expect(empty.error).toBe('执行失败：qodercli 没有任何输出（退出码 0）。详见本机日志。');

    const parse = await run('parse');
    expect(parse.errorClass).toBe('unknown');
    expect(parse.error).toBe('执行失败：qodercli 输出无法解析（退出码 0）。详见本机日志。');
  });

  it('应该在进程正常退出但 error_code 表明截断时仍判为失败', async () => {
    const result = await run('max-output-tokens-exit0');

    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe('output_limit');
    expect(result.error).toContain('回答被截断');
    expect(result.error).not.toContain('half answer');
  });

  it('应该在成功时不带语义字段', async () => {
    const result = await run('ok');

    expect(result.ok).toBe(true);
    expect(result.errorClass).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
    expect(result.errorDetail).toBeUndefined();
  });
});
