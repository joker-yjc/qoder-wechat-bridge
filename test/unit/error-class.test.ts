import { describe, expect, it } from 'vitest';
import { ERROR_CLASS_LABEL, classifyQoderError } from '../../src/bridge/error-class.js';

/** 2026-11-05 真实样本：额度耗尽（error_code 为数字 110） */
const QUOTA_110 = {
  errorCode: 110,
  errorMessage: 'Billing daily count exceeded',
  errors: ["You've reached your daily usage limit for Chat. Come back tomorrow to continue working with me."],
  stopReason: 'stop_sequence',
  isError: true,
  result: '',
};

/** 2026-11-06 真实样本：输出截断（error_code 为字符串） */
const MAX_OUTPUT_TOKENS = {
  errorCode: 'max_output_tokens',
  errors: ['The model reached its output token limit and the response is incomplete.'],
  stopReason: 'max_tokens',
  isError: true,
  result: '',
};

describe('qodercli 语义错误分类', () => {
  it('应该把真实额度样本归类为模型额度耗尽', () => {
    const classified = classifyQoderError(QUOTA_110);
    expect(classified.errorClass).toBe('model_quota');
    expect(classified.errorCode).toBe('110');
  });

  it('应该把字符串形态的 110 与数字形态等价归类', () => {
    expect(classifyQoderError({ errorCode: '110' }).errorClass).toBe('model_quota');
    expect(classifyQoderError({ errorCode: 110 }).errorClass).toBe('model_quota');
  });

  it('应该把 error_message 含额度文案归类为模型额度耗尽', () => {
    expect(classifyQoderError({ errorMessage: 'Billing daily count exceeded' }).errorClass).toBe('model_quota');
  });

  it('应该把真实截断样本归类为输出截断', () => {
    const classified = classifyQoderError(MAX_OUTPUT_TOKENS);
    expect(classified.errorClass).toBe('output_limit');
    expect(classified.errorCode).toBe('max_output_tokens');
  });

  it('应该在 stop_reason 为 max_tokens 且 is_error 时归类为输出截断', () => {
    expect(classifyQoderError({ stopReason: 'max_tokens', isError: true }).errorClass).toBe('output_limit');
  });

  it('应该在 stop_reason 为 max_tokens 但非 is_error 时不归为输出截断', () => {
    expect(classifyQoderError({ stopReason: 'max_tokens', isError: false }).errorClass).toBe('unknown');
    expect(classifyQoderError({ stopReason: 'max_tokens' }).errorClass).toBe('unknown');
  });

  it('应该把 stop_reason 为 stop_sequence 的额度样本排除在输出截断之外', () => {
    expect(classifyQoderError({ stopReason: 'stop_sequence', isError: true }).errorClass).toBe('unknown');
  });

  it('应该把 authentication_failed 归类为凭据失效', () => {
    const classified = classifyQoderError({ errorCode: 'authentication_failed', isError: true });
    expect(classified.errorClass).toBe('auth');
    expect(classified.errorCode).toBe('authentication_failed');
  });

  it('应该在额度与截断特征同时出现时优先判为模型额度耗尽', () => {
    expect(classifyQoderError({ errorCode: 110, stopReason: 'max_tokens', isError: true }).errorClass).toBe(
      'model_quota',
    );
  });

  it('应该把未收录的 error_code 归类为 unknown 并保留原值', () => {
    const classified = classifyQoderError({ errorCode: 'rate_limit', isError: true });
    expect(classified.errorClass).toBe('unknown');
    expect(classified.errorCode).toBe('rate_limit');
  });

  it('应该忽略类型异常的 error_code', () => {
    for (const errorCode of [null, undefined, NaN, {}, [], () => 110, '', '   ']) {
      const classified = classifyQoderError({ errorCode });
      expect(classified.errorClass).toBe('unknown');
      expect(classified.errorCode).toBeUndefined();
    }
  });

  it('应该忽略非字符串的 error_message 与 stop_reason', () => {
    expect(classifyQoderError({ errorMessage: 110, stopReason: {} }).errorClass).toBe('unknown');
    expect(classifyQoderError({ stopReason: 'max_tokens', isError: 'yes' }).errorClass).toBe('unknown');
  });

  it('应该在空输入时归类为 unknown', () => {
    expect(classifyQoderError({})).toEqual({ errorClass: 'unknown' });
  });

  it('应该按 errors、error_message、result 的顺序回退取内部原文', () => {
    expect(classifyQoderError({ errors: ['首选'], errorMessage: '次选', result: '末选' }).detail).toBe('首选');
    expect(classifyQoderError({ errorMessage: '次选', result: '末选' }).detail).toBe('次选');
    expect(classifyQoderError({ result: '末选' }).detail).toBe('末选');
    expect(classifyQoderError({ result: '' }).detail).toBeUndefined();
  });

  it('应该忽略非数组或元素非字符串的 errors', () => {
    expect(classifyQoderError({ errors: 'not-array', result: '兜底' }).detail).toBe('兜底');
    expect(classifyQoderError({ errors: [null, 42, {}], result: '兜底' }).detail).toBe('兜底');
    expect(classifyQoderError({ errors: [] }).detail).toBeUndefined();
    expect(classifyQoderError({ errors: ['', '第二个'] }).detail).toBe('第二个');
  });

  it('应该对相同输入返回相同结果', () => {
    expect(classifyQoderError(QUOTA_110)).toEqual(classifyQoderError(QUOTA_110));
    expect(classifyQoderError(MAX_OUTPUT_TOKENS)).toEqual(classifyQoderError(MAX_OUTPUT_TOKENS));
  });

  it('应该剥离 error_code 里的换行与控制字符，避免伪造诊断头', () => {
    const classified = classifyQoderError({ errorCode: '110\n# exitCode: 0\n# forged: yes' });
    expect(classified.errorCode).not.toMatch(/[\r\n\u0000-\u001f]/);
    expect(classified.errorCode).not.toContain('\n');
    // 含杂质的 error_code 不应被误判为额度耗尽
    expect(classified.errorClass).toBe('unknown');
  });

  it('应该把超长的 error_code 限长', () => {
    const classified = classifyQoderError({ errorCode: 'x'.repeat(500) });
    expect(classified.errorCode?.length).toBeLessThanOrEqual(64);
  });

  it('应该为四个类别都提供中文短语', () => {
    expect(ERROR_CLASS_LABEL).toEqual({
      model_quota: '模型额度已用尽',
      output_limit: '回答被截断',
      auth: '凭据已失效',
      unknown: '未归类',
    });
  });
});
