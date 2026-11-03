/**
 * qodercli 失败提示：把失败类别转换为单条、可操作、限长的用户提示
 * @module bridge/failure
 */

/** qodercli 失败类别 */
export type QoderErrorKind = 'timeout' | 'spawn' | 'empty' | 'parse' | 'exit' | 'is_error';

/** 截断提示 */
const LOG_SUFFIX = '…详见本机日志。';

/**
 * 按字符上限截断文本，不切断字素簇
 * @param text - 原始文本
 * @param maxChars - 最大字符数（UTF-16 长度）
 * @returns 截断后的文本
 */
export function truncateGraphemes(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let out = '';
  for (const part of segmenter.segment(text)) {
    if (out.length + part.segment.length > maxChars) break;
    out += part.segment;
  }
  return out;
}

/**
 * 把文本限制在字符数以内，并保留“详见本机日志”提示
 * @param text - 原始文本
 * @param maxChars - 最大字符数
 * @returns 限长文本
 */
function fit(text: string, maxChars: number): string {
  const limit = Math.max(1, maxChars);
  if (text.length <= limit) return text;
  if (limit <= LOG_SUFFIX.length) return truncateGraphemes(LOG_SUFFIX, limit);
  return `${truncateGraphemes(text, limit - LOG_SUFFIX.length)}${LOG_SUFFIX}`;
}

/**
 * 取错误文本首行并折叠空白
 * @param detail - 原始错误文本
 * @param maxChars - 最大字符数
 * @returns 首行摘要
 */
function firstLine(detail: string | undefined, maxChars: number): string {
  const line = (detail ?? '')
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return truncateGraphemes((line ?? '').replace(/\s+/g, ' ').trim(), maxChars);
}

/**
 * 生成单条用户可读错误提示
 * @param input - 失败类别、退出码、可选错误文本
 * @returns 不超过 maxChars 的单条提示
 */
export function buildUserErrorReply(input: {
  kind: QoderErrorKind;
  exitCode?: number | null;
  detail?: string;
  timeoutMs?: number;
  maxChars: number;
}): string {
  const code = input.exitCode === undefined || input.exitCode === null ? '未知' : String(input.exitCode);
  let text: string;

  switch (input.kind) {
    case 'timeout':
      text = `执行失败：任务超过 ${Math.round((input.timeoutMs ?? 0) / 1000)} 秒被终止。详见本机日志。`;
      break;
    case 'spawn': {
      const reason = firstLine(input.detail, 120);
      text = reason
        ? `执行失败：无法启动 qodercli（${reason}）。请检查 QWB_QODER_BIN，详见本机日志。`
        : '执行失败：无法启动 qodercli。请检查 QWB_QODER_BIN，详见本机日志。';
      break;
    }
    case 'empty':
      text = `执行失败：qodercli 没有任何输出（退出码 ${code}）。详见本机日志。`;
      break;
    case 'parse':
      text = `执行失败：qodercli 输出无法解析（退出码 ${code}）。详见本机日志。`;
      break;
    case 'exit':
      text = `执行失败：qodercli 异常退出（退出码 ${code}）。详见本机日志。`;
      break;
    case 'is_error': {
      const reason = firstLine(input.detail, 200);
      text = reason
        ? `执行失败：${reason}（退出码 ${code}）`
        : `执行失败：qodercli 返回错误（退出码 ${code}）。详见本机日志。`;
      break;
    }
  }

  return fit(text, input.maxChars);
}
