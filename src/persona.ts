/**
 * 读取并裁剪人设文件
 * @module persona
 */
import fs from 'node:fs';
import { log } from './log.js';

/** 人设文件最大字节数，避免把超长内容塞进每条请求 */
export const MAX_PERSONA_BYTES = 8 * 1024;

/**
 * 读取人设文本；文件不存在或为空时返回空串
 * @param filePath - 人设文件路径
 * @returns 人设文本
 */
export function loadPersona(filePath: string): string {
  if (!filePath) return '';
  try {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    if (!text) return '';
    if (Buffer.byteLength(text, 'utf-8') > MAX_PERSONA_BYTES) {
      log.warn('人设文件超过上限，已截断', { filePath, maxBytes: MAX_PERSONA_BYTES });
      return Buffer.from(text, 'utf-8').subarray(0, MAX_PERSONA_BYTES).toString('utf-8');
    }
    return text;
  } catch {
    return '';
  }
}
