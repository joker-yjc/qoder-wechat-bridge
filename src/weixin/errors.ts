/**
 * iLink 发送错误：把 HTTP / 业务错误码归类为桥接层可判定的语义
 * @module weixin/errors
 */

/** 发送失败的语义分类 */
export type SendFailureKind = 'quota' | 'session_expired' | 'transient' | 'permanent' | 'unknown';

/** 发送失败错误，携带原始错误码 */
export class BridgeSendError extends Error {
  readonly kind: SendFailureKind;
  readonly ret?: number;
  readonly errcode?: number;
  readonly httpStatus?: number;

  /**
   * @param message - 错误描述
   * @param kind - 语义分类
   * @param meta - 原始错误码
   */
  constructor(
    message: string,
    kind: SendFailureKind,
    meta: { ret?: number; errcode?: number; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = 'BridgeSendError';
    this.kind = kind;
    this.ret = meta.ret;
    this.errcode = meta.errcode;
    this.httpStatus = meta.httpStatus;
  }
}

/** HTTP 层错误，供 sendItem 统一分类 */
export class HttpError extends Error {
  readonly status: number;

  /**
   * @param status - HTTP 状态码
   * @param body - 响应体（截断）
   */
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * 把 HTTP 状态码归类
 * @param status - HTTP 状态码
 * @returns 发送错误
 */
function fromHttpStatus(status: number): BridgeSendError {
  if (status === 401 || status === 403) {
    return new BridgeSendError('微信会话过期', 'session_expired', { httpStatus: status });
  }
  if (status === 429) {
    return new BridgeSendError('下行额度受限', 'quota', { httpStatus: status });
  }
  if (status === 408 || status >= 500) {
    return new BridgeSendError('通道暂时不可用', 'transient', { httpStatus: status });
  }
  if (status >= 400 && status < 500) {
    return new BridgeSendError('消息被通道拒绝', 'permanent', { httpStatus: status });
  }
  return new BridgeSendError('未知 HTTP 错误', 'unknown', { httpStatus: status });
}

/**
 * 把未知异常归类为发送失败
 * @param err - 原始异常
 * @returns 带分类的错误
 */
export function classifySendError(err: unknown): BridgeSendError {
  if (err instanceof BridgeSendError) return err;
  if (err instanceof HttpError) return fromHttpStatus(err.status);
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError') {
      return new BridgeSendError(err.message, 'transient');
    }
    return new BridgeSendError(err.message, 'unknown');
  }
  return new BridgeSendError(String(err), 'unknown');
}
