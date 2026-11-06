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

  it('应该在无失败记录时显示最近失败为无', () => {
    const lines = buildStatusLines(makeConfig(), makeState(), context);

    expect(lines).toContain('最近失败：无');
  });

  it('应该展示最近失败的类别、error_code、退出码、时间与任务 id', () => {
    const state = makeState({
      lastFailure: {
        kind: 'exit',
        errorClass: 'model_quota',
        errorCode: '110',
        exitCode: 1,
        at: new Date(2026, 10, 5, 23, 27, 51).getTime(),
        taskId: 'mw3p970m-bt2wwl',
      },
    });
    const line = buildStatusLines(makeConfig(), state, context).find((item) => item.startsWith('最近失败：'));

    expect(line).toContain('模型额度已用尽');
    expect(line).toContain('model_quota');
    expect(line).toContain('error_code=110');
    expect(line).toContain('退出码 1');
    expect(line).toContain('任务 mw3p970m-bt2wwl');
    expect(line).toMatch(/于 \d{4}\/11\/5 23:27:51/);
  });

  it('应该在 error_code 缺失时整段省略且不留下多余分隔符', () => {
    const state = makeState({
      lastFailure: { kind: 'timeout', errorClass: 'unknown', exitCode: null, at: Date.now(), taskId: 't1' },
    });
    const line = buildStatusLines(makeConfig(), state, context).find((item) => item.startsWith('最近失败：'));

    expect(line).not.toContain('error_code=');
    expect(line).not.toContain('｜｜');
    expect(line).toContain('未归类');
    expect(line).toContain('退出码 未知');
  });

  it('应该让四个语义类别各自映射到中文短语', () => {
    const labels = {
      model_quota: '模型额度已用尽',
      output_limit: '回答被截断',
      auth: '凭据已失效',
      unknown: '未归类',
    } as const;

    for (const [errorClass, label] of Object.entries(labels)) {
      const state = makeState({
        lastFailure: { kind: 'exit', errorClass, exitCode: 1, at: Date.now(), taskId: 't' },
      });
      const line = buildStatusLines(makeConfig(), state, context).find((item) => item.startsWith('最近失败：'));
      expect(line).toContain(label);
    }
  });

  it('应该让最近失败与下行额度分成两行且字面可区分', () => {
    const state = makeState({
      quota: { streak: 2, lastAt: Date.now() },
      lastFailure: {
        kind: 'exit',
        errorClass: 'model_quota',
        errorCode: '110',
        exitCode: 1,
        at: Date.now(),
        taskId: 't1',
      },
    });
    const lines = buildStatusLines(makeConfig(), state, context);
    const quotaIndex = lines.findIndex((item) => item.startsWith('下行额度：'));
    const failureIndex = lines.findIndex((item) => item.startsWith('最近失败：'));

    expect(quotaIndex).toBeGreaterThanOrEqual(0);
    expect(failureIndex).toBe(quotaIndex + 1);
    expect(lines[quotaIndex]).toContain('ret=-2');
    expect(lines[quotaIndex]).not.toContain('model_quota');
    expect(lines[failureIndex]).not.toContain('ret=-2');
  });

  it('应该保留一期既有的全部状态行', () => {
    const lines = buildStatusLines(makeConfig(), makeState(), context).join('\n');

    for (const prefix of ['配置：', '状态：', 'iLink：', 'Token：', '机器人 ID：', '授权账号：', '会话数：', '隔离区：']) {
      expect(lines).toContain(prefix);
    }
  });
});
