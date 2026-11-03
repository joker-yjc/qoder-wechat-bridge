import { describe, expect, it } from 'vitest';
import { BridgeSendError, HttpError, classifySendError } from '../../src/weixin/errors.js';

describe('发送错误分类', () => {
  it('应该原样返回 BridgeSendError', () => {
    const original = new BridgeSendError('x', 'quota', { ret: -2 });
    expect(classifySendError(original)).toBe(original);
  });

  it('应该把 401/403 归类为会话过期', () => {
    expect(classifySendError(new HttpError(401, 'no')).kind).toBe('session_expired');
    expect(classifySendError(new HttpError(403, 'no')).kind).toBe('session_expired');
  });

  it('应该把 429 归类为额度耗尽', () => {
    expect(classifySendError(new HttpError(429, 'slow')).kind).toBe('quota');
  });

  it('应该把 408 与 5xx 归类为瞬时失败', () => {
    expect(classifySendError(new HttpError(408, 'timeout')).kind).toBe('transient');
    expect(classifySendError(new HttpError(500, 'boom')).kind).toBe('transient');
    expect(classifySendError(new HttpError(503, 'busy')).kind).toBe('transient');
  });

  it('应该把其它 4xx 归类为永久失败', () => {
    expect(classifySendError(new HttpError(400, 'bad')).kind).toBe('permanent');
    expect(classifySendError(new HttpError(413, 'large')).kind).toBe('permanent');
    expect(classifySendError(new HttpError(422, 'invalid')).kind).toBe('permanent');
  });

  it('应该把非 4xx/5xx 状态归类为未知', () => {
    expect(classifySendError(new HttpError(302, 'redirect')).kind).toBe('unknown');
  });

  it('应该把超时、中止与网络 TypeError 归类为瞬时失败', () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const abort = Object.assign(new Error('abort'), { name: 'AbortError' });
    expect(classifySendError(timeout).kind).toBe('transient');
    expect(classifySendError(abort).kind).toBe('transient');
    expect(classifySendError(new TypeError('fetch failed')).kind).toBe('transient');
  });

  it('应该把普通错误与非 Error 归类为未知', () => {
    expect(classifySendError(new Error('whoops')).kind).toBe('unknown');
    expect(classifySendError('whoops').kind).toBe('unknown');
  });
});
