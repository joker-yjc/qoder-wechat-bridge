import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_STATE, type Config, type State } from '../../src/config.js';
import { buildStatusLines, formatAge, formatBytes } from '../../src/status.js';

const context = {
  configFile: '/c/config.json',
  stateFile: '/s/state.json',
  personaInfo: '未设置',
  inbox: { bytes: 2048, files: 2 },
  home: '/home/u',
};

/**
 * 构造配置
 * @param overrides - 覆盖项
 * @returns 配置
 */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ownerUserId: 'u', token: 't', botId: 'bot', ...overrides };
}

/**
 * 构造状态
 * @param overrides - 覆盖项
 * @returns 状态
 */
function makeState(overrides: Partial<State> = {}): State {
  return {
    ...DEFAULT_STATE,
    sessions: {},
    outbox: [],
    quarantine: [],
    quota: { streak: 0, lastAt: 0 },
    seenMessageIds: [],
    models: {},
    contextTokens: {},
    ...overrides,
  };
}

describe('格式化工具', () => {
  it('应该格式化字节数', () => {
    expect(formatBytes(0)).toBe('0B');
    expect(formatBytes(1024)).toBe('1.0KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00GB');
  });

  it('应该格式化时长', () => {
    expect(formatAge(0)).toBe('0 秒');
    expect(formatAge(90_000)).toBe('1 分钟');
    expect(formatAge(2 * 60 * 60_000)).toBe('2 小时');
    expect(formatAge(2 * 24 * 60 * 60_000)).toBe('2 天');
    expect(formatAge(-1)).toBe('0 秒');
  });
});

describe('buildStatusLines', () => {
  it('应该在空队列时显示 0 与正常额度', () => {
    const lines = buildStatusLines(makeConfig(), makeState(), context).join('\n');

    expect(lines).toContain('待补发：0 条');
    expect(lines).toContain('隔离区：0 条');
    expect(lines).toContain('下行额度：正常');
    expect(lines).toContain('附件目录：');
    expect(lines).toContain('工作目录：/home/u（全局）');
  });

  it('应该展示最旧消息年龄、字节、隔离区与额度告警', () => {
    const now = Date.now();
    const state = makeState({
      outbox: [
        {
          id: 'a',
          toUserId: 'u',
          text: 'a',
          kind: 'reply',
          createdAt: now - 2 * 60 * 60_000,
          bytes: 1000,
          failures: 0,
          transientFailures: 0,
        },
        {
          id: 'b',
          toUserId: 'u',
          text: 'b',
          kind: 'reply',
          createdAt: now - 60 * 60_000,
          bytes: 24,
          failures: 0,
          transientFailures: 0,
        },
      ],
      quarantine: [
        {
          id: 'q',
          toUserId: 'u',
          text: 'q',
          kind: 'reply',
          createdAt: now,
          bytes: 1,
          failures: 3,
          transientFailures: 0,
          quarantinedAt: now,
          reason: 'permanent',
          preview: 'q',
        },
      ],
      quota: { streak: 2, lastAt: now },
    });
    const lines = buildStatusLines(makeConfig({ cwd: '/work', allowFrom: ['x'] }), state, context).join('\n');

    expect(lines).toContain('待补发：2 条（最旧 2 小时前，共 1.0KB）');
    expect(lines).toContain('隔离区：1 条');
    expect(lines).toContain('连续 2 个窗口');
    expect(lines).toContain('工作目录：/work');
    expect(lines).toContain('白名单');
  });
});
