/**
 * Qoder agent 调用层：通过 qodercli headless 执行一次任务
 * @module bridge/qoder
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { log } from '../log.js';

/** 一次调用的输入 */
export interface QoderRunInput {
  prompt: string;
  /** 工作目录；不传表示不限定（在用户主目录下运行全局会话） */
  cwd?: string;
  /** 已有会话 id，传入则用 -r 续接 */
  sessionId?: string;
  timeoutMs: number;
  bin: string;
  permissionMode: string;
  model?: string;
}

/** 一次调用的结果 */
export interface QoderRunResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  /** 实际使用的模型（取自 modelUsage 的键，用于验证切换是否生效） */
  modelUsed?: string;
  error?: string;
  durationMs: number;
}

/** 输出上限，防止异常输出撑爆内存 */
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/**
 * 构造干净的环境变量
 * 关键：从 Qoder Desktop 的 shell 启动时，继承的 QODER_* 会让 qodercli 误判为 SDK worker
 * @returns 清理后的环境变量
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('QODER_') || key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
      delete env[key];
    }
  }
  return env;
}

/**
 * 从输出里解析 result 对象
 * @param raw - qodercli 的 stdout
 * @returns 解析结果或 null
 */
function parseResult(raw: string): { result?: string; is_error?: boolean; session_id?: string; model?: string } | null {
  const candidates = [raw.trim(), ...raw.trim().split('\n').reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed.type === 'result') {
        const usage = parsed.modelUsage;
        const model = usage && typeof usage === 'object' ? Object.keys(usage)[0] : undefined;
        return {
          result: typeof parsed.result === 'string' ? parsed.result : '',
          is_error: parsed.is_error === true,
          session_id: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
          model,
        };
      }
    } catch {
      // 继续尝试下一行
    }
  }
  return null;
}

/**
 * 执行一次 qodercli headless 调用
 * @param input - 调用输入
 * @returns 执行结果
 */
export function runQoder(input: QoderRunInput): Promise<QoderRunResult> {
  const startedAt = Date.now();
  const args = ['-p', '-o', 'json', '--permission-mode', input.permissionMode];
  const workdir = input.cwd?.trim() || os.homedir();
  // 不限定目录时不传 -w，让 qodercli 以全局会话方式运行
  if (input.cwd?.trim()) args.push('-w', input.cwd.trim());
  if (input.model) args.push('-m', input.model);
  if (input.sessionId) args.push('-r', input.sessionId);
  args.push(input.prompt);

  return new Promise((resolve) => {
    const child = spawn(input.bin, args, {
      cwd: workdir,
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);

    child.stdout.on('data', (buf: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += buf.toString('utf-8');
    });
    child.stderr.on('data', (buf: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += buf.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        text: '',
        error: `无法启动 ${input.bin}：${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const parsed = parseResult(stdout);
      if (killedByTimeout) {
        resolve({
          ok: false,
          text: '',
          error: `任务超过 ${Math.round(input.timeoutMs / 1000)} 秒被终止`,
          durationMs,
        });
        return;
      }
      if (!parsed) {
        log.error('qodercli 输出无法解析', { code, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) });
        resolve({
          ok: false,
          text: '',
          error: stderr.trim() || stdout.trim() || `qodercli 退出码 ${code}`,
          durationMs,
        });
        return;
      }
      if (parsed.is_error) {
        resolve({ ok: false, text: parsed.result ?? '', error: parsed.result || 'qodercli 返回错误', sessionId: parsed.session_id, modelUsed: parsed.model, durationMs });
        return;
      }
      resolve({ ok: true, text: parsed.result ?? '', sessionId: parsed.session_id, modelUsed: parsed.model, durationMs });
    });
  });
}
