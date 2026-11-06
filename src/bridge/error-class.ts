/**
 * qodercli 业务语义错误分类：把 result 行里的语义字段归一到四类之一
 * @module bridge/error-class
 */

/** qodercli 业务语义失败类别 */
export type QoderErrorClass = 'model_quota' | 'output_limit' | 'auth' | 'unknown';

/** 类别的中文短语，供用户文案与 status 输出复用 */
export const ERROR_CLASS_LABEL: Record<QoderErrorClass, string> = {
  model_quota: '模型额度已用尽',
  output_limit: '回答被截断',
  auth: '凭据已失效',
  unknown: '未归类',
};

/**
 * 从 result 行提取的语义字段
 * 全部来自外部进程，类型不受本项目控制，故一律以 unknown 收下并在本模块内归一
 */
export interface QoderSemanticFields {
  /** 语义错误码；实测同时存在 number（110）与 string（"max_output_tokens"）两种形态 */
  errorCode?: unknown;
  /** 语义错误描述 */
  errorMessage?: unknown;
  /** 错误消息数组 */
  errors?: unknown;
  /** 停因；实测取值 max_tokens / stop_sequence */
  stopReason?: unknown;
  /** result 行的 is_error */
  isError?: unknown;
  /** result 正文 */
  result?: string;
}

/** 分类结果 */
export interface QoderErrorClassification {
  /** 业务语义类别 */
  errorClass: QoderErrorClass;
  /** 归一化为字符串的 error_code，用于日志、诊断与 status */
  errorCode?: string;
  /** 内部匹配用原文，永不直达用户 */
  detail?: string;
}

/** 额度耗尽的错误码，实测为数字 110 */
const QUOTA_ERROR_CODE = '110';

/** 额度耗尽的错误描述特征 */
const QUOTA_ERROR_MESSAGE = 'Billing daily count exceeded';

/** 输出截断的错误码 */
const OUTPUT_LIMIT_ERROR_CODE = 'max_output_tokens';

/** 输出截断的停因 */
const OUTPUT_LIMIT_STOP_REASON = 'max_tokens';

/** 凭据失效的错误码，取自 qodercli 自身枚举 */
const AUTH_ERROR_CODE = 'authentication_failed';

/** error_code 归一化后的长度上限，防止异常值撑爆诊断头与 status 行 */
export const ERROR_CODE_MAX_CHARS = 64;

/**
 * 把不可信文本压成安全的单行
 *
 * 用于会写进纯文本载体（诊断文件 header、status 行）的字段：一个换行就能伪造整行，
 * 故剥掉控制字符、折叠空白并限长。日志侧走 JSON.stringify，不需要本函数
 * @param value - 原始值；有限数字会先转成字符串
 * @param maxChars - 长度上限
 * @returns 安全的单行文本；不可用或结果为空时为 undefined
 */
export function sanitizeSingleLine(value: unknown, maxChars: number): string | undefined {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return undefined;
  const cleaned = text
    .replace(/[\r\n\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  return cleaned ? cleaned : undefined;
}

/**
 * 把 error_code 归一化为字符串
 * @param value - 原始 error_code
 * @returns 归一化后的字符串；不可用时为 undefined
 */
function normalizeErrorCode(value: unknown): string | undefined {
  return sanitizeSingleLine(value, ERROR_CODE_MAX_CHARS);
}

/**
 * 把字段归一化为非空字符串
 * @param value - 原始值
 * @returns 非空字符串；否则 undefined
 */
function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 从 errors 数组里取第一条非空字符串
 * @param value - 原始 errors
 * @returns 首条非空消息；否则 undefined
 */
function firstErrorMessage(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const text = normalizeText(item);
    if (text) return text;
  }
  return undefined;
}

/**
 * 判断停因是否表示输出被截断
 * @param stopReason - 归一化后的停因
 * @param isError - result 行的 is_error 原值
 * @returns 是否构成截断信号
 */
function isOutputLimitStopReason(stopReason: string | undefined, isError: unknown): boolean {
  return stopReason === OUTPUT_LIMIT_STOP_REASON && isError === true;
}

/**
 * 把 qodercli 语义字段归类
 *
 * 只认三条有实测或上游枚举支撑的特征，其余一律 unknown，
 * 未识别的 error_code 会由调用方落日志，攒够样本再收敛规则
 * @param fields - result 行提取的语义字段
 * @returns 类别、归一化后的 error_code 与内部原文
 */
export function classifyQoderError(fields: QoderSemanticFields): QoderErrorClassification {
  const errorCode = normalizeErrorCode(fields.errorCode);
  const errorMessage = normalizeText(fields.errorMessage);
  const stopReason = normalizeText(fields.stopReason);
  const detail = firstErrorMessage(fields.errors) ?? errorMessage ?? normalizeText(fields.result);

  let errorClass: QoderErrorClass = 'unknown';
  if (errorCode === QUOTA_ERROR_CODE || errorMessage?.includes(QUOTA_ERROR_MESSAGE)) {
    errorClass = 'model_quota';
  } else if (errorCode === OUTPUT_LIMIT_ERROR_CODE || isOutputLimitStopReason(stopReason, fields.isError)) {
    errorClass = 'output_limit';
  } else if (errorCode === AUTH_ERROR_CODE) {
    errorClass = 'auth';
  }

  return { errorClass, errorCode, detail };
}
