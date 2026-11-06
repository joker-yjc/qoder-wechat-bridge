import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneDiagnostics, redactSensitive, writeDiagnostic } from '../../src/diagnostics.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-diag-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('redactSensitive', () => {
  it('应该脱敏 Bearer、token、cookie 与 sk- 密钥', () => {
    const text = [
      'Authorization: Bearer abcdefghijklmnop',
      'token=supersecretvalue',
      'cookie: sessionid=abcdef',
      'key sk-1234567890abcdef',
    ].join('\n');
    const redacted = redactSensitive(text);

    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(redacted).not.toContain('supersecretvalue');
    expect(redacted).not.toContain('sessionid=abcdef');
    expect(redacted).not.toContain('sk-1234567890abcdef');
    expect(redacted).toContain('[REDACTED]');
  });
});

describe('writeDiagnostic', () => {
  it('应该写入诊断文件并带上任务信息', () => {
    const result = writeDiagnostic(
      {
        taskId: 'task/1',
        sessionId: 'session-1',
        kind: 'parse',
        exitCode: 1,
        durationMs: 12,
        stdout: 'stdout-body',
        stderr: 'stderr-body',
      },
      { dir: root, now: () => Date.UTC(2026, 10, 3, 12) },
    );

    expect(result.path).not.toBe('');
    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('# taskId: task/1');
    expect(content).toContain('# sessionId: session-1');
    expect(content).toContain('stdout-body');
    expect(content).toContain('stderr-body');
    expect(content).toContain('## stdout');
    expect(content).toContain('## stderr');
    if (process.platform !== 'win32') expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it('应该在 header 里紧随 kind 记录语义类别与 error_code', () => {
    const result = writeDiagnostic(
      {
        taskId: 'semantic',
        kind: 'exit',
        errorClass: 'model_quota',
        errorCode: '110',
        exitCode: 1,
        stdout: 'body',
        stderr: '',
      },
      { dir: root },
    );

    const lines = fs.readFileSync(result.path, 'utf-8').split('\n');
    expect(lines).toContain('# errorClass: model_quota');
    expect(lines).toContain('# errorCode: 110');
    expect(lines.indexOf('# errorClass: model_quota')).toBe(lines.indexOf('# kind: exit') + 1);
    expect(lines.indexOf('# errorCode: 110')).toBe(lines.indexOf('# errorClass: model_quota') + 1);
  });

  it('应该在语义字段缺失时写出空值行而不出现 undefined', () => {
    const result = writeDiagnostic({ taskId: 'plain', kind: 'timeout', stdout: '', stderr: 'boom' }, { dir: root });

    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('# errorClass: \n');
    expect(content).toContain('# errorCode: \n');
    expect(content).not.toContain('undefined');
  });

  it('应该在 header 变长后仍把总字节数控制在预算内', () => {
    const maxBytes = 512;
    const result = writeDiagnostic(
      {
        taskId: 'budget',
        kind: 'exit',
        errorClass: 'output_limit',
        errorCode: 'max_output_tokens',
        stdout: 'a'.repeat(100_000),
        stderr: 'b'.repeat(100_000),
      },
      { dir: root, maxBytes },
    );

    expect(result.bytes).toBeLessThanOrEqual(maxBytes);
    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('# errorClass: output_limit');
    expect(content).toContain('# errorCode: max_output_tokens');
  });

  it('应该把 stdout 与 stderr 限制在总字节预算内', () => {
    const maxBytes = 1024;
    const result = writeDiagnostic(
      {
        taskId: 'big',
        kind: 'exit',
        stdout: 'a'.repeat(100_000),
        stderr: 'b'.repeat(100_000),
      },
      { dir: root, maxBytes },
    );

    expect(result.bytes).toBeLessThanOrEqual(maxBytes);
    expect(fs.statSync(result.path).size).toBeLessThanOrEqual(maxBytes);
    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('[truncated');
  });

  it('应该在单侧为空时把预算全部给另一侧', () => {
    const maxBytes = 1024;
    const result = writeDiagnostic(
      { taskId: 'one-side', kind: 'exit', stdout: 'a'.repeat(5000), stderr: '' },
      { dir: root, maxBytes },
    );

    expect(result.bytes).toBeLessThanOrEqual(maxBytes);
    const content = fs.readFileSync(result.path, 'utf-8');
    expect(content).toContain('## stdout');
    expect(content).not.toContain('## stderr');
  });

  it('应该在极小预算下仍不超限', () => {
    const result = writeDiagnostic(
      { taskId: 'tiny', kind: 'exit', stdout: 'a'.repeat(5000), stderr: 'b'.repeat(5000) },
      { dir: root, maxBytes: 256 },
    );

    expect(result.bytes).toBeLessThanOrEqual(256);
  });

  it('应该在目录不可写时返回空路径', () => {
    const file = path.join(root, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const result = writeDiagnostic(
      { taskId: 'fail', kind: 'exit', stdout: '', stderr: '' },
      { dir: file },
    );
    expect(result).toEqual({ path: '', bytes: 0 });
  });
});

describe('pruneDiagnostics', () => {
  it('应该删除超过保留天数的诊断文件', () => {
    const dayOld = path.join(root, '2026-10-20');
    const dayNew = path.join(root, '2026-11-03');
    fs.mkdirSync(dayOld, { recursive: true });
    fs.mkdirSync(dayNew, { recursive: true });
    const oldFile = path.join(dayOld, 'old.log');
    const newFile = path.join(dayNew, 'new.log');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(newFile, 'new');
    const oldDate = new Date('2026-10-20T00:00:00Z');
    fs.utimesSync(oldFile, oldDate, oldDate);

    const removed = pruneDiagnostics(7, root, Date.UTC(2026, 10, 3, 12));

    expect(removed).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(dayOld)).toBe(false);
  });

  it('应该在目录不存在时返回 0', () => {
    expect(pruneDiagnostics(7, path.join(root, 'missing'), Date.now())).toBe(0);
  });
});
