import { describe, expect, it } from 'vitest';
import { chunkText } from '../../src/bridge/reply.js';

describe('测试基础设施', () => {
  it('应该返回单条片段，当文本长度在字符上限内', () => {
    expect(chunkText('abc', 10)).toEqual(['abc']);
  });
});
