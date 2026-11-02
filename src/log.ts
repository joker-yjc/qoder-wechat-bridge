/**
 * 结构化日志：控制台可读输出 + 状态目录下 JSONL 留档
 * @module log
 */
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 当前日志级别，可用 LOG_LEVEL 环境变量覆盖 */
let currentLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';

/**
 * 设置日志级别
 * @param level - debug/info/warn/error
 */
export function setLevel(level: Level): void {
  currentLevel = level;
}

/**
 * 当前日期的日志文件路径
 * @returns 绝对路径
 */
function logFile(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(stateDir(), 'logs', `bridge-${day}.jsonl`);
}

/**
 * 写一条日志
 * @param level - 级别
 * @param msg - 消息
 * @param fields - 附加结构化字段
 */
function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const record = { ts: new Date().toISOString(), level, msg, ...fields };
  const line = `[${record.ts}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logFile(), JSON.stringify(record) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // 日志落盘失败不影响主流程
  }
}

/** 日志接口 */
export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
