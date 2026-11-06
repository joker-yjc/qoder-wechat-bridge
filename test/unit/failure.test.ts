import { describe, expect, it } from 'vitest';
import { ACK_MAX_CHARS, buildAckText, buildUserErrorReply, truncateGraphemes } from '../../src/bridge/failure.js';

describe('truncateGraphemes', () => {
  it('应该在字符上限内原样返回', () => {
    expect(truncateGraphemes('abc', 10)).toBe('abc');
  });

  it('应该在超长时截断且不切断 emoji', () => {
    const result = truncateGraphemes('😀😀😀', 3);
    expect(result).toBe('😀');
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('应该在非正上限时返回空串', () => {
    expect(truncateGraphemes('abc', 0)).toBe('');
    expect(truncateGraphemes('abc', -1)).toBe('');
  });
});

describe('buildUserErrorReply', () => {
  it('应该生成超时提示并带上秒数', () => {
    const text = buildUserErrorReply({ kind: 'timeout', timeoutMs: 120_000, maxChars: 300 });
    expect(text).toContain('超过 120 秒');
    expect(text).toContain('详见本机日志');
  });

  it('应该生成无法启动提示并只取错误首行', () => {
    const text = buildUserErrorReply({
      kind: 'spawn',
      detail: 'ENOENT: not found\n    at spawn',
      exitCode: 1,
      maxChars: 300,
    });
    expect(text).toContain('无法启动 qodercli');
    expect(text).toContain('ENOENT: not found');
    expect(text).not.toContain('at spawn');
  });

  it('应该在无法启动且无详情时使用通用文案', () => {
    const text = buildUserErrorReply({ kind: 'spawn', maxChars: 300 });
    expect(text).toContain('请检查 QWB_QODER_BIN');
  });

  it('应该生成空输出、解析失败与异常退出提示', () => {
    expect(buildUserErrorReply({ kind: 'empty', exitCode: 1, maxChars: 300 })).toContain('没有任何输出');
    expect(buildUserErrorReply({ kind: 'parse', exitCode: 2, maxChars: 300 })).toContain('无法解析');
    expect(buildUserErrorReply({ kind: 'exit', exitCode: 3, maxChars: 300 })).toContain('异常退出');
  });

  it('应该在退出码缺失时显示未知', () => {
    expect(buildUserErrorReply({ kind: 'exit', maxChars: 300 })).toContain('退出码 未知');
    expect(buildUserErrorReply({ kind: 'empty', exitCode: null, maxChars: 300 })).toContain('退出码 未知');
  });

  it('应该把 is_error 的内容限制在首行并带退出码', () => {
    const text = buildUserErrorReply({
      kind: 'is_error',
      detail: '第一行错误\n第二行堆栈',
      exitCode: 1,
      maxChars: 300,
    });
    expect(text).toBe('执行失败：第一行错误（退出码 1）');
  });

  it('应该在 is_error 无详情时使用通用文案', () => {
    const text = buildUserErrorReply({ kind: 'is_error', exitCode: 1, maxChars: 300 });
    expect(text).toContain('qodercli 返回错误');
    expect(text).toContain('详见本机日志');
  });

  it('应该把 is_error 内容限制在 300 字以内且不换行', () => {
    const text = buildUserErrorReply({ kind: 'is_error', detail: 'a'.repeat(1000), exitCode: 1, maxChars: 300 });
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).not.toContain('\n');
    expect(text).toContain('退出码 1');
  });

  it('应该在更小上限下截断并保留日志提示', () => {
    const text = buildUserErrorReply({ kind: 'is_error', detail: 'a'.repeat(200), exitCode: 1, maxChars: 100 });
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.endsWith('…详见本机日志。')).toBe(true);
  });

  it('应该在极小上限下仍不超过上限', () => {
    const text = buildUserErrorReply({ kind: 'exit', exitCode: 1, maxChars: 5 });
    expect(text.length).toBeLessThanOrEqual(5);
  });
});

describe('buildUserErrorReply 语义类别', () => {
  it('应该在模型额度耗尽时给出中文模板与可执行建议', () => {
    const text = buildUserErrorReply({ kind: 'exit', errorClass: 'model_quota', exitCode: 1, maxChars: 300 });
    expect(text).toBe('模型额度已用尽：今日调用次数达到上限。可稍后重试，或发 /model 切换模型。（退出码 1）');
  });

  it('应该在输出截断时给出中文模板与换模型或拆小任务的建议', () => {
    const text = buildUserErrorReply({ kind: 'exit', errorClass: 'output_limit', exitCode: 1, maxChars: 300 });
    expect(text).toBe(
      '回答被截断：模型输出达到上限，本次没有完整结果。可发 /model 换输出上限更大的模型，或把任务拆小。（退出码 1）',
    );
  });

  it('应该在凭据失效时说明需在本机重新登录', () => {
    const text = buildUserErrorReply({ kind: 'exit', errorClass: 'auth', exitCode: 1, maxChars: 300 });
    expect(text).toBe('Qoder 凭据已失效：需在本机重新登录 qodercli 后重试。（退出码 1）');
  });

  it('应该让三个语义模板完全不含英文原文，即使 detail 传了原文', () => {
    const detail = 'The model reached its output token limit and the response is incomplete.';
    for (const errorClass of ['model_quota', 'output_limit', 'auth'] as const) {
      const text = buildUserErrorReply({ kind: 'exit', errorClass, detail, exitCode: 1, maxChars: 300 });
      expect(text).not.toContain('model reached');
      expect(text).not.toContain('incomplete');
      expect(text).not.toMatch(/[A-Za-z]{4,}\s+[A-Za-z]{4,}/);
    }
  });

  it('应该在退出码缺失时把语义模板的退出码显示为未知', () => {
    expect(buildUserErrorReply({ kind: 'exit', errorClass: 'auth', maxChars: 300 })).toContain('退出码 未知');
  });

  it('应该在 unknown 与缺省时逐字保留一期传输层文案', () => {
    const cases = [
      { input: { kind: 'timeout', timeoutMs: 120_000 }, expected: '执行失败：任务超过 120 秒被终止。详见本机日志。' },
      {
        input: { kind: 'spawn', detail: 'ENOENT: not found' },
        expected: '执行失败：无法启动 qodercli（ENOENT: not found）。请检查 QWB_QODER_BIN，详见本机日志。',
      },
      { input: { kind: 'empty', exitCode: 1 }, expected: '执行失败：qodercli 没有任何输出（退出码 1）。详见本机日志。' },
      { input: { kind: 'parse', exitCode: 2 }, expected: '执行失败：qodercli 输出无法解析（退出码 2）。详见本机日志。' },
      { input: { kind: 'exit', exitCode: 1 }, expected: '执行失败：qodercli 异常退出（退出码 1）。详见本机日志。' },
      {
        input: { kind: 'is_error', detail: '第一行错误', exitCode: 1 },
        expected: '执行失败：第一行错误（退出码 1）',
      },
    ] as const;

    for (const { input, expected } of cases) {
      expect(buildUserErrorReply({ ...input, maxChars: 300 })).toBe(expected);
      expect(buildUserErrorReply({ ...input, errorClass: 'unknown', maxChars: 300 })).toBe(expected);
    }
  });

  it('应该在极小上限下让语义模板也不超过上限', () => {
    const text = buildUserErrorReply({ kind: 'exit', errorClass: 'model_quota', exitCode: 1, maxChars: 20 });
    expect(text.length).toBeLessThanOrEqual(20);
    expect(text.endsWith('…详见本机日志。')).toBe(true);
  });
});

describe('buildAckText', () => {
  /** 用本地时区的时与分独立算出 HH:mm，避免与实现同源 */
  const localHourMinute = (timestamp: number): string => {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  it('应该带上类别短语、首次提示时间与含本次的抑制次数', () => {
    const firstAt = new Date(2026, 10, 5, 23, 13, 0).getTime();
    expect(buildAckText({ errorClass: 'model_quota', firstAt, suppressed: 4 })).toBe(
      `（模型额度已用尽同 ${localHourMinute(firstAt)} 那条，本次为第 4 次，已略）`,
    );
  });

  it('应该用 HH:mm 格式呈现首次提示时间', () => {
    const text = buildAckText({ errorClass: 'auth', firstAt: Date.now(), suppressed: 1 });
    expect(text).toMatch(/^（.+同 \d{2}:\d{2} 那条，本次为第 \d+ 次，已略）$/);
  });

  it('应该对四个类别与各种抑制次数都不超过 ack 上限', () => {
    const firstAt = Date.now();
    for (const errorClass of ['model_quota', 'output_limit', 'auth', 'unknown'] as const) {
      for (const suppressed of [1, 2, 99, 9999]) {
        const text = buildAckText({ errorClass, firstAt, suppressed });
        expect(text.length).toBeLessThanOrEqual(ACK_MAX_CHARS);
        expect(text).not.toContain('\n');
      }
    }
  });

  it('应该把 ack 上限固定为 60 字符', () => {
    expect(ACK_MAX_CHARS).toBe(60);
  });
});
