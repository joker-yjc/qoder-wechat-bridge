/**
 * 失败诊断落盘：保存有界、脱敏、仅当前用户可读的诊断文件
 * @module diagnostics
 */
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './config.js';
import type { QoderErrorKind } from './bridge/failure.js';

/** 诊断输入 */
export interface DiagnosticInput {
  taskId: string;
  sessionId?: string;
  kind: QoderErrorKind | 'send';
  exitCode?: number | null;
  durationMs?: number;
  stdout: string;
  stderr: string;
}

/** 诊断写入选项 */
export interface DiagnosticOptions {
  /** 单文件最大字节数 */
  maxBytes?: number;
  /** 诊断根目录 */
  dir?: string;
  /** 当前时间 */
  now?: () => number;
}

/**
 * 脱敏敏感信息
 * @param text - 原始文本
 * @returns 脱敏后的文本
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(token|access_token|refresh_token|secret|cookie|password|authorization)\b\s*[:=]\s*["']?[^\s"',}]{4,}/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]');
}

/**
 * 按字节上限截断文本，不产生无效 UTF-8
 * @param text - 原始文本
 * @param maxBytes - 最大字节数
 * @returns 截断后的文本
 */
function truncateBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * 构造一个不超过预算的诊断分段
 * @param label - 分段标题（含换行）
 * @param text - 分段正文
 * @param budget - 分段字节预算
 * @returns 分段文本
 */
function buildSection(label: string, text: string, budget: number): string {
  if (budget <= 0) return '';
  const labelBytes = Buffer.byteLength(label, 'utf8');
  if (budget <= labelBytes) return truncateBytes(label, budget);
  const bodyBudget = budget - labelBytes;
  if (Buffer.byteLength(text, 'utf8') <= bodyBudget) return `${label}${text}`;
  const originalBytes = Buffer.byteLength(text, 'utf8');
  const marker = `…[truncated ${originalBytes - bodyBudget} bytes]`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (bodyBudget <= markerBytes) return `${label}${truncateBytes(marker, bodyBudget)}`;
  const kept = truncateBytes(text, bodyBudget - markerBytes);
  return `${label}${kept}${marker}`;
}

/**
 * 写入一份诊断文件
 * @param input - 诊断内容
 * @param opts - 上限、目录与时钟
 * @returns 文件路径与写入字节数；写失败时路径为空
 */
export function writeDiagnostic(input: DiagnosticInput, opts: DiagnosticOptions = {}): { path: string; bytes: number } {
  const now = opts.now?.() ?? Date.now();
  const maxBytes = Math.max(256, opts.maxBytes ?? 64 * 1024);
  const root = opts.dir ?? path.join(stateDir(), 'logs', 'diagnostics');
  const day = new Date(now).toISOString().slice(0, 10);
  const dir = path.join(root, day);
  const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, '_');

  const header = [
    `# taskId: ${input.taskId}`,
    `# sessionId: ${input.sessionId ?? ''}`,
    `# kind: ${input.kind}`,
    `# exitCode: ${input.exitCode ?? ''}`,
    `# durationMs: ${input.durationMs ?? ''}`,
    `# at: ${new Date(now).toISOString()}`,
    '',
  ].join('\n');

  const remaining = Math.max(0, maxBytes - Buffer.byteLength(header, 'utf8'));
  let stdoutSection = '';
  let stderrSection = '';
  const stdoutText = redactSensitive(input.stdout);
  const stderrText = redactSensitive(input.stderr);

  if (remaining > 0 && stdoutText && stderrText) {
    const half = Math.floor(remaining / 2);
    stdoutSection = buildSection('## stdout\n', stdoutText, half);
    stderrSection = buildSection('## stderr\n', stderrText, remaining - Buffer.byteLength(stdoutSection, 'utf8'));
    const unused =
      remaining - Buffer.byteLength(stdoutSection, 'utf8') - Buffer.byteLength(stderrSection, 'utf8');
    if (unused > 0) {
      if (stdoutSection.includes('[truncated')) {
        stdoutSection = buildSection(
          '## stdout\n',
          stdoutText,
          Buffer.byteLength(stdoutSection, 'utf8') + unused,
        );
      } else if (stderrSection.includes('[truncated')) {
        stderrSection = buildSection(
          '## stderr\n',
          stderrText,
          Buffer.byteLength(stderrSection, 'utf8') + unused,
        );
      }
    }
  } else if (remaining > 0 && stdoutText) {
    stdoutSection = buildSection('## stdout\n', stdoutText, remaining);
  } else if (remaining > 0 && stderrText) {
    stderrSection = buildSection('## stderr\n', stderrText, remaining);
  }

  const content = `${header}${stdoutSection}${stderrSection}`;

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${now}-${safeTaskId}.log`);
    fs.writeFileSync(file, content, { encoding: 'utf-8', mode: 0o600 });
    return { path: file, bytes: Buffer.byteLength(content, 'utf8') };
  } catch {
    return { path: '', bytes: 0 };
  }
}

/**
 * 清理超过保留天数的诊断文件
 * @param retentionDays - 保留天数
 * @param dir - 诊断根目录
 * @param now - 当前时间
 * @returns 删除的文件数
 */
export function pruneDiagnostics(retentionDays: number, dir?: string, now = Date.now()): number {
  const root = dir ?? path.join(stateDir(), 'logs', 'diagnostics');
  if (!fs.existsSync(root)) return 0;
  const cutoff = now - retentionDays * 24 * 60 * 60_000;
  let removed = 0;
  for (const day of fs.readdirSync(root)) {
    const dayDir = path.join(root, day);
    if (!fs.statSync(dayDir).isDirectory()) continue;
    for (const file of fs.readdirSync(dayDir)) {
      const filePath = path.join(dayDir, file);
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.rmSync(filePath, { force: true });
        removed += 1;
      }
    }
    if (fs.readdirSync(dayDir).length === 0) fs.rmdirSync(dayDir);
  }
  return removed;
}
