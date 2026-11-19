/**
 * 会话清单：列会话、解析清单文本、解析切换目标、渲染清单、headless 重命名
 * 照 models.ts 范式；只读清单与改指针，不触碰 CLI 会话正文
 * @module bridge/sessions
 */
import { execFileSync } from 'node:child_process';
import spawn from 'cross-spawn';
import { cleanEnv } from './qoder.js';

/** 一条会话清单条目 */
export interface SessionEntry {
  /** CLI 输出序号（从 1 开始，按最近活跃排序） */
  index: number;
  /** 显示名（可能含空格/括号/中文） */
  name: string;
  /** 最近活跃时间（CLI 原文，如 "2 分钟前"） */
  lastActive: string;
  /** 完整会话 id（36 位 UUID） */
  sessionId: string;
}

/** 清单/重命名失败类别 */
export type SessionErrorKind =
  | 'not_installed'
  | 'not_logged_in'
  | 'timeout'
  | 'parse'
  | 'spawn'
  | 'rename';

/** 会话操作的可读错误 */
export class SessionError extends Error {
  readonly kind: SessionErrorKind;
  /**
   * @param kind - 失败类别
   * @param message - 中文可读说明
   */
  constructor(kind: SessionErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'SessionError';
  }
}

/** 清单行正则：锚定行尾 36 位 UUID，名称非贪婪允许括号/中文（R2 实测契约） */
const SESSION_LINE = /^\s*(\d+)\.\s*(.*?)\s*\(([^)]*)\)\s*\[([0-9a-fA-F-]{36})\]\s*$/;

/** 疑似会话行判据：含 36 位方括号 id（用于区分"格式异常"与"空清单/提示行"） */
const SESSION_ID_BRACKET = /\[[0-9a-fA-F-]{36}\]/;

/** 真实 CLI 空清单哨兵（不输出表头，而是一句提示） */
const EMPTY_SENTINEL = /^No previous sessions found/;

/** 清单调用超时；冷启实测可达 11s、负载下更久，留足余量避免误超时（Minor-11） */
const SESSION_LIST_TIMEOUT_MS = 30_000;

/** 删除会话超时；删除是快速元数据操作，无需任务的 600s（审查 Minor） */
export const SESSION_DELETE_TIMEOUT_MS = 30_000;

/** 会话显示名最大字符数（/new 与 /rename 共用） */
export const SESSION_NAME_MAX = 60;

/**
 * 校验会话显示名（/new 与 /rename 共用）
 * @param name - 待校验名称（非空）
 * @returns 错误原因；合法返回 null
 */
export function sessionNameError(name: string): string | null {
  if (name.length > SESSION_NAME_MAX) return `名称过长（最多 ${SESSION_NAME_MAX} 字符）`;
  // 换行/控制字符会污染清单解析；首字符 - 可能被 CLI 当旗标（Minor-8）
  if (/[\u0000-\u001f]/.test(name)) return '名称不能含换行或控制字符';
  if (name.startsWith('-')) return '名称不能以 - 开头';
  return null;
}

/**
 * 解析 `qodercli --list-sessions` 文本输出
 * @param stdout - CLI 原始输出
 * @returns 会话条目列表（空清单返回 []）
 * @throws SessionError('parse') 存在有效行但全部无法解析
 */
export function parseSessionList(stdout: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let suspect = 0;
  for (const raw of stdout.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('Available sessions') || EMPTY_SENTINEL.test(trimmed)) continue;
    if (SESSION_ID_BRACKET.test(raw)) suspect += 1;
    const m = SESSION_LINE.exec(raw);
    if (!m) continue;
    entries.push({ index: Number(m[1]), name: m[2], lastActive: m[3], sessionId: m[4] });
  }
  // 仅当存在疑似会话行（含方括号 id）却全部无法解析时才判格式异常；
  // 空清单哨兵/普通提示行不含 id，视为空清单，不报错（P0-1）
  if (suspect > 0 && entries.length === 0) {
    throw new SessionError('parse', '会话清单格式异常，请升级 Qoder CLI');
  }
  return entries;
}

/**
 * 在指定工作目录下列会话
 * @param bin - qodercli 路径
 * @param cwd - 桥接工作目录
 * @returns 会话条目列表
 * @throws SessionError 未安装/超时/启动失败/解析失败
 */
export function listSessions(bin: string, cwd: string): SessionEntry[] {
  let out: string;
  try {
    out = execFileSync(bin, ['--list-sessions'], {
      env: cleanEnv({ bin }),
      cwd,
      encoding: 'utf-8',
      timeout: SESSION_LIST_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; status?: number };
    // 超时优先判 ETIMEDOUT：真实 qodercli 超时形状为 code=ETIMEDOUT/signal=null/status=143，
    // 仅凭 killed/SIGTERM 会漏判（P1-6）
    if (e.code === 'ETIMEDOUT' || e.status === 143 || e.killed || e.signal === 'SIGTERM') {
      throw new SessionError('timeout', '列出会话超时，请稍后重试');
    }
    if (e.code === 'ENOENT') {
      // ENOENT 可能是 qodercli 未安装，也可能是 cwd 不存在（Minor-7），不单一归因安装
      throw new SessionError('not_installed', '无法列出会话：Qoder CLI 未安装或工作目录不存在');
    }
    throw new SessionError('spawn', '列出会话失败，请稍后重试');
  }
  return parseSessionList(out);
}

/**
 * 解析切换目标：序号 / id（完整或唯一短 id）/ 显示名
 * @param input - 用户输入
 * @param catalog - 会话清单
 * @returns 命中条目或失败原因
 */
export function resolveSession(
  input: string,
  catalog: SessionEntry[],
): { ok: true; entry: SessionEntry } | { ok: false; reason: string } {
  const value = input.trim();
  if (!value) return { ok: false, reason: '未指定目标' };

  if (/^\d+$/.test(value)) {
    // 按 CLI 序号（e.index）解析，与清单展示同源；坏行被跳过后数组位置会错位（P1-2）
    const entry = catalog.find((e) => e.index === Number(value));
    return entry ? { ok: true, entry } : { ok: false, reason: '序号越界' };
  }

  const lower = value.toLowerCase();
  const full = catalog.find((e) => e.sessionId.toLowerCase() === lower);
  if (full) return { ok: true, entry: full };

  if (/^[0-9a-fA-F-]{4,}$/.test(value)) {
    const matches = catalog.filter((e) => e.sessionId.toLowerCase().startsWith(lower));
    if (matches.length === 1) return { ok: true, entry: matches[0] };
    if (matches.length > 1) return { ok: false, reason: 'id 不唯一' };
  }

  const byName = catalog.filter((e) => e.name.toLowerCase() === lower);
  if (byName.length > 1) return { ok: false, reason: '名称不唯一' };
  if (byName.length === 1) return { ok: true, entry: byName[0] };

  return { ok: false, reason: '未找到' };
}

/**
 * 渲染 /sessions 清单文本
 * @param catalog - 会话清单
 * @param activeId - 当前活动会话 id（无则 undefined）
 * @param limit - 最多展示条数
 * @returns 可直接发到微信的文本
 */
export function formatSessionList(
  catalog: SessionEntry[],
  activeId: string | undefined,
  limit: number,
): string {
  if (catalog.length === 0) return '当前工作目录下还没有会话，发条消息即可创建。';
  const shown = catalog.slice(0, limit);
  const lines = [`会话清单（最近 ${shown.length} 条）：`];
  for (const e of shown) {
    const mark = e.sessionId === activeId ? ' ← 当前' : '';
    lines.push(`${e.index}. ${e.name} (${e.lastActive}) [${e.sessionId.slice(0, 8)}]${mark}`);
  }
  if (catalog.length > limit) lines.push(`仅显示最近 ${limit} 条`);
  lines.push('发 /switch <序号|id|名称> 切换，/new [名称] 开新会话。');
  return lines.join('\n');
}

/**
 * headless 重命名：受支持路径 -r <id> -n <新名> -p（R1 实测成立）
 * 会跑一个完整模型轮次（约 0.05 积分 + 一条 junk 轮次），不逆向写 jsonl
 * @param input - 重命名参数
 * @returns 成功或可读失败
 */
export function renameSession(input: {
  bin: string;
  cwd: string;
  sessionId: string;
  name: string;
  timeoutMs: number;
  permissionMode: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = [
    '-p',
    '-o',
    'json',
    '--permission-mode',
    input.permissionMode,
    '-w',
    input.cwd,
    '-r',
    input.sessionId,
    '-n',
    input.name,
    '重命名',
  ];
  return new Promise((resolve) => {
    const child = spawn(input.bin, args, {
      cwd: input.cwd,
      env: cleanEnv({ bin: input.bin }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);
    /**
     * 落定结果，只生效一次
     * @param result - 成功或失败
     */
    const done = (result: { ok: true } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on('data', (buf: Buffer) => {
      // 输出上限 1MB，防止异常输出撑爆内存（Minor-4，对齐 MAX_OUTPUT_BYTES 口径）
      if (stdout.length < 1024 * 1024) stdout += buf.toString('utf-8');
    });
    child.on('error', () => {
      done({ ok: false, error: '无法启动 Qoder CLI' });
    });
    child.on('close', (code) => {
      if (timedOut) {
        done({ ok: false, error: '超时，请稍后重试' });
        return;
      }
      if (code !== 0) {
        done({ ok: false, error: '失败，请稍后重试' });
        return;
      }
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]) as { is_error?: boolean };
        if (last.is_error) done({ ok: false, error: '未生效' });
        else done({ ok: true });
      } catch {
        done({ ok: false, error: '输出异常' });
      }
    });
  });
}

/**
 * 删除会话：qodercli --delete-session <index>（按 CLI 当前序号）
 * 实测：成功 stdout 含 "Deleted session <n>:"、exit 0；序号不存在也 exit 0 但 stdout 空，
 * 故不能靠退出码判定，须认 stdout（R-delete 探针）
 * @param input - 删除参数
 * @returns 成功或可读失败
 */
export function deleteSession(input: {
  bin: string;
  cwd: string;
  index: number;
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = ['--delete-session', String(input.index)];
  return new Promise((resolve) => {
    const child = spawn(input.bin, args, {
      cwd: input.cwd,
      env: cleanEnv({ bin: input.bin }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);
    /**
     * 落定结果，只生效一次
     * @param result - 成功或失败
     */
    const done = (result: { ok: true } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on('data', (buf: Buffer) => {
      if (stdout.length < 1024 * 1024) stdout += buf.toString('utf-8');
    });
    child.on('error', () => {
      done({ ok: false, error: '无法启动 Qoder CLI' });
    });
    child.on('close', () => {
      if (timedOut) {
        done({ ok: false, error: '超时，请稍后重试' });
        return;
      }
      // 实测成功 stdout 含 "Deleted session <n>:"；序号不存在也 exit 0 但 stdout 为空哨兵，
      // 故认 stdout 不认退出码。是否删对由调用方重新 listSessions 按 id 复核（F-1 更稳做法）
      if (/Deleted session/.test(stdout)) done({ ok: true });
      else done({ ok: false, error: '未找到该序号的会话或删除失败' });
    });
  });
}