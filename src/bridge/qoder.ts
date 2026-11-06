/**
 * Qoder agent 调用层：通过 qodercli headless 执行一次任务
 * @module bridge/qoder
 */
import spawn from 'cross-spawn';
import os from 'node:os';
import { log } from '../log.js';
import { writeDiagnostic } from '../diagnostics.js';
import { buildUserErrorReply, type QoderErrorKind } from './failure.js';
import { classifyQoderError, type QoderErrorClass, type QoderSemanticFields } from './error-class.js';

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
  /** 是否加载 Qoder 长期记忆（默认 false，由调用方显式开启） */
  memory?: boolean;
  /** 追加到默认 system prompt 的人设文本 */
  appendSystemPrompt?: string;
  /** 随任务附带的本地文件路径（--attachment） */
  attachments?: string[];
  /** 关联任务 id，用于诊断文件 */
  taskId: string;
  /** 用户错误提示最大字符数 */
  errorMaxChars?: number;
  /** 诊断目录，测试可注入 */
  diagnosticDir?: string;
  /** 子进程启动后回调一个取消函数，用于 /stop */
  onStart?: (cancel: () => void) => void;
}

/** 一次调用的结果 */
export interface QoderRunResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  /** 实际使用的模型（取自 modelUsage 的键，用于验证切换是否生效） */
  modelUsed?: string;
  errorKind?: QoderErrorKind;
  /** 业务语义类别；失败时必有值 */
  errorClass?: QoderErrorClass;
  /** 归一化后的 error_code，用于日志、诊断与 status */
  errorCode?: string;
  /** 短错误提示，不超过 errorMaxChars */
  error?: string;
  /** 内部信号原文（errors[0] / error_message / result），仅供续接降级匹配，永不直达用户 */
  errorDetail?: string;
  exitCode?: number | null;
  diagnosticPath?: string;
  durationMs: number;
}

/** 解析后的 result 对象 */
interface ParsedResult {
  result: string;
  is_error: boolean;
  session_id?: string;
  model?: string;
  /** 以下语义字段原样透传，类型归一交给 classifyQoderError */
  stop_reason?: unknown;
  error_code?: unknown;
  error_message?: unknown;
  errors?: unknown;
}

/** 输出上限，防止异常输出撑爆内存 */
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/** 子进程退出后等待 stdio 管道关闭的宽限期，超时则强制落定并销毁管道 */
const PIPE_DRAIN_GRACE_MS = 2_000;

/** 整段解析的最大长度，超过则只解析尾部行 */
const PARSE_WHOLE_MAX = 1_000_000;

/** 尾部解析行数 */
const PARSE_TAIL_LINES = 200;

/** 默认错误提示字符数 */
const DEFAULT_ERROR_MAX_CHARS = 300;

/**
 * 构造干净的环境变量
 * 关键：从 Qoder Desktop 的 shell 启动时，继承的 QODER_* 会让 qodercli 误判为 SDK worker
 * 记忆开关 QODER_MEMORY_HEADLESS 是唯一需要补回来的一个
 * @param opts - memory=true 时打开 headless 长期记忆
 * @returns 清理后的环境变量
 */
export function cleanEnv(opts: { memory?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('QODER_') || key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
      delete env[key];
    }
  }
  if (opts.memory) env.QODER_MEMORY_HEADLESS = '1';
  return env;
}

/**
 * 从输出里解析 result 对象
 * @param raw - qodercli 的 stdout
 * @returns 解析结果或 null
 */
function parseResult(raw: string): ParsedResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates: string[] = [];
  if (trimmed.length <= PARSE_WHOLE_MAX) candidates.push(trimmed);
  const lines = trimmed.split('\n');
  const start = Math.max(0, lines.length - PARSE_TAIL_LINES);
  for (let index = lines.length - 1; index >= start; index -= 1) {
    candidates.push(lines[index]!);
  }

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
          stop_reason: parsed.stop_reason,
          error_code: parsed.error_code,
          error_message: parsed.error_message,
          errors: parsed.errors,
        };
      }
    } catch {
      // 继续尝试下一行
    }
  }
  return null;
}

/**
 * 从解析结果里取出业务语义字段
 * @param parsed - 解析后的 result 对象
 * @returns 交给 classifyQoderError 归一的语义字段
 */
function semanticFields(parsed: ParsedResult): QoderSemanticFields {
  return {
    errorCode: parsed.error_code,
    errorMessage: parsed.error_message,
    errors: parsed.errors,
    stopReason: parsed.stop_reason,
    isError: parsed.is_error,
    result: parsed.result,
  };
}

/**
 * 追加输出并遵守字节上限
 * @param chunks - 已收集的块
 * @param currentBytes - 已收集字节数
 * @param buf - 新数据
 * @returns 新的字节数
 */
function appendChunk(chunks: Buffer[], currentBytes: number, buf: Buffer): number {
  if (currentBytes >= MAX_OUTPUT_BYTES) return currentBytes;
  const remaining = MAX_OUTPUT_BYTES - currentBytes;
  const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
  chunks.push(slice);
  return currentBytes + slice.length;
}

/**
 * 执行一次 qodercli headless 调用
 * @param input - 调用输入
 * @returns 执行结果
 */
export function runQoder(input: QoderRunInput): Promise<QoderRunResult> {
  const startedAt = Date.now();
  const args = ['-p', '-o', 'json', '--permission-mode', input.permissionMode];
  if (input.appendSystemPrompt?.trim()) {
    args.push('--append-system-prompt', input.appendSystemPrompt.trim());
  }
  const workdir = input.cwd?.trim() || os.homedir();
  // 不限定目录时不传 -w，让 qodercli 以全局会话方式运行
  if (input.cwd?.trim()) args.push('-w', input.cwd.trim());
  if (input.model) args.push('-m', input.model);
  if (input.sessionId) args.push('-r', input.sessionId);
  for (const file of input.attachments ?? []) {
    args.push('--attachment', file);
  }
  args.push(input.prompt);

  return new Promise((resolve) => {
    const child = spawn(input.bin, args, {
      cwd: workdir,
      env: cleanEnv({ memory: input.memory }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    input.onStart?.(() => {
      if (!child.killed) child.kill('SIGKILL');
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedByTimeout = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const readStdout = (): string => Buffer.concat(stdoutChunks).toString('utf-8');
    const readStderr = (): string => Buffer.concat(stderrChunks).toString('utf-8');

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);

    child.stdout?.on('data', (buf: Buffer) => {
      stdoutBytes = appendChunk(stdoutChunks, stdoutBytes, buf);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderrBytes = appendChunk(stderrChunks, stderrBytes, buf);
    });

    /**
     * 落定失败结果，只允许生效一次
     * @param kind - 传输层失败类别
     * @param opts - 诊断与结果字段；semantic 为 result 行里的业务语义字段
     */
    const settleFailure = (
      kind: QoderErrorKind,
      opts: {
        exitCode?: number | null;
        detail?: string;
        sessionId?: string;
        modelUsed?: string;
        semantic?: QoderSemanticFields;
      } = {},
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      const durationMs = Date.now() - startedAt;
      const stdout = readStdout();
      const stderr = readStderr();
      const exitCode = opts.exitCode ?? null;
      // 命名避开 opts.detail：后者是传输层错误原文，前者是语义信号，混用会直接把原文送进用户提示
      const { errorClass, errorCode, detail: errorDetail } = classifyQoderError(opts.semantic ?? {});
      const diagnostic = writeDiagnostic(
        {
          taskId: input.taskId,
          sessionId: opts.sessionId ?? input.sessionId,
          kind,
          errorClass,
          errorCode,
          exitCode,
          durationMs,
          stdout,
          stderr,
        },
        { dir: input.diagnosticDir },
      );
      const error = buildUserErrorReply({
        kind,
        errorClass,
        exitCode,
        detail: opts.detail,
        timeoutMs: input.timeoutMs,
        maxChars: input.errorMaxChars ?? DEFAULT_ERROR_MAX_CHARS,
      });
      resolve({
        ok: false,
        text: '',
        sessionId: opts.sessionId ?? input.sessionId,
        modelUsed: opts.modelUsed,
        errorKind: kind,
        errorClass,
        errorCode,
        error,
        errorDetail,
        exitCode,
        diagnosticPath: diagnostic.path || undefined,
        durationMs,
      });
    };

    child.on('error', (err) => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settleFailure('spawn', { exitCode: null, detail: err.message });
    });

    /**
     * 落定任务结果，只允许生效一次
     * @param code - 退出码；宽限期强制落定时为 null
     * @param destroyPipes - 是否销毁 stdio 管道，用于把被后代进程握着的管道释放掉
     */
    const finalize = (code: number | null, destroyPipes: boolean): void => {
      if (settled) return;
      if (destroyPipes) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      const stdout = readStdout();
      const stderr = readStderr();
      const parsed = parseResult(stdout);

      if (killedByTimeout) {
        settleFailure('timeout', { exitCode: null, detail: undefined });
        return;
      }
      if (!stdout.trim() && !stderr.trim()) {
        settleFailure('empty', {
          exitCode: code,
          sessionId: parsed?.session_id,
          modelUsed: parsed?.model,
        });
        return;
      }
      if (!parsed) {
        log.error('qodercli 输出无法解析', { code, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) });
        settleFailure('parse', { exitCode: code });
        return;
      }
      const semantic = semanticFields(parsed);
      if (code !== 0) {
        settleFailure('exit', {
          exitCode: code,
          sessionId: parsed.session_id,
          modelUsed: parsed.model,
          semantic,
        });
        return;
      }
      if (parsed.is_error) {
        settleFailure('is_error', {
          exitCode: code,
          detail: parsed.result,
          sessionId: parsed.session_id,
          modelUsed: parsed.model,
          semantic,
        });
        return;
      }
      // 进程正常退出且 is_error 为假，但 error_code 表明输出被截断：
      // 半截答案一旦按成功下发，用户会当成完整回答，因此仍判失败（需求 2.1）
      if (classifyQoderError(semantic).errorClass === 'output_limit') {
        settleFailure('is_error', {
          exitCode: code,
          detail: parsed.result,
          sessionId: parsed.session_id,
          modelUsed: parsed.model,
          semantic,
        });
        return;
      }

      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({
        ok: true,
        text: parsed.result,
        sessionId: parsed.session_id,
        modelUsed: parsed.model,
        exitCode: code,
        durationMs: Date.now() - startedAt,
      });
    };

    // 子进程退出后，它派生的后代进程可能仍持有 stdio 管道，导致 close 永不触发；
    // 宽限期到了就用已有输出落定并销毁管道，否则桥接进程会卡在 await 上退不出去
    child.on('exit', () => {
      graceTimer = setTimeout(() => finalize(null, true), PIPE_DRAIN_GRACE_MS);
    });
    child.on('close', (code) => finalize(code, false));
  });
}
