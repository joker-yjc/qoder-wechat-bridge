import { describe, expect, it } from 'vitest';
import { buildUserErrorReply, truncateGraphemes } from '../../src/bridge/failure.js';

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
