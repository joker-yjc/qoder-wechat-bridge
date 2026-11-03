import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  clearRunInfo,
  configDir,
  configPath,
  ensureDirs,
  loadConfig,
  loadState,
  migrateLegacyConfig,
  normalizeState,
  readRunInfo,
  runInfoPath,
  saveConfig,
  saveState,
  stateDir,
  statePath,
  writeRunInfo,
} from '../../src/config.js';

let root = '';
const touchedEnv = [
  'QWB_CONFIG_DIR',
  'QWB_STATE_DIR',
  'QWB_OUTBOX_MAX',
  'QWB_POISON_ATTEMPTS',
  'QWB_USER_ERROR_CHARS',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-config-'));
  process.env.QWB_CONFIG_DIR = path.join(root, 'config');
  process.env.QWB_STATE_DIR = path.join(root, 'state');
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('QWB_') || key.startsWith('XDG_')) delete process.env[key];
  }
  for (const key of touchedEnv) delete process.env[key];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('配置默认值与路径', () => {
  it('应该包含队列与诊断的默认配置', () => {
    expect(DEFAULT_CONFIG.outboxMaxItems).toBe(200);
    expect(DEFAULT_CONFIG.outboxTtlMs).toBe(86_400_000);
    expect(DEFAULT_CONFIG.poisonMaxAttempts).toBe(3);
    expect(DEFAULT_CONFIG.transientMaxAttempts).toBe(10);
    expect(DEFAULT_CONFIG.quarantineMaxItems).toBe(500);
    expect(DEFAULT_CONFIG.quarantineTtlMs).toBe(604_800_000);
    expect(DEFAULT_CONFIG.userErrorMaxChars).toBe(300);
    expect(DEFAULT_CONFIG.diagnosticMaxBytes).toBe(65_536);
    expect(DEFAULT_CONFIG.diagnosticRetentionDays).toBe(7);
    expect(DEFAULT_CONFIG.preflightVersionTimeoutMs).toBe(5_000);
  });

  it('应该按 QWB_* 与 XDG 规则解析目录', () => {
    expect(configDir()).toBe(path.join(root, 'config'));
    expect(stateDir()).toBe(path.join(root, 'state'));
    expect(configPath()).toBe(path.join(root, 'config', 'config.json'));
    expect(statePath()).toBe(path.join(root, 'state', 'state.json'));
    expect(runInfoPath()).toBe(path.join(root, 'state', 'run.json'));

    delete process.env.QWB_CONFIG_DIR;
    delete process.env.QWB_STATE_DIR;
    process.env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
    process.env.XDG_STATE_HOME = path.join(root, 'xdg-state');
    expect(configDir()).toBe(path.join(root, 'xdg-config', 'qoder-wechat-bridge'));
    expect(stateDir()).toBe(path.join(root, 'xdg-state', 'qoder-wechat-bridge'));
  });
});

describe('配置加载与保存', () => {
  it('应该按默认值、文件、环境变量的顺序合并', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ maxReplyChars: 1234, outboxMaxItems: 7 }));
    process.env.QWB_POISON_ATTEMPTS = '9';

    const config = loadConfig();

    expect(config.maxReplyChars).toBe(1234);
    expect(config.outboxMaxItems).toBe(7);
    expect(config.poisonMaxAttempts).toBe(9);
    expect(config.maxRepliesPerTurn).toBe(DEFAULT_CONFIG.maxRepliesPerTurn);
  });

  it('应该支持全部 QWB_* 覆盖', () => {
    process.env.QWB_BASE_URL = 'https://example.test';
    process.env.QWB_TOKEN = 'token';
    process.env.QWB_BOT_ID = 'bot';
    process.env.QWB_OWNER_ID = 'owner';
    process.env.QWB_ALLOW_FROM = 'a, b';
    process.env.QWB_ALLOW_FIRST_SENDER = 'true';
    process.env.QWB_CWD = '/tmp';
    process.env.QWB_PERMISSION_MODE = 'auto';
    process.env.QWB_QODER_BIN = '/bin/qodercli';
    process.env.QWB_MODEL = 'model-x';
    process.env.QWB_MEMORY = 'off';
    process.env.QWB_PERSONA_FILE = '/tmp/persona.md';
    process.env.QWB_INBOX_DIR = '/tmp/inbox';
    process.env.QWB_TTS_VOICE = 'Voice';
    process.env.QWB_TIMEOUT_MS = '1234';
    process.env.QWB_MAX_REPLY_CHARS = '111';
    process.env.QWB_MAX_REPLIES = '5';
    process.env.QWB_OUTBOX_MAX = '10';
    process.env.QWB_OUTBOX_TTL_MS = '2000';
    process.env.QWB_POISON_ATTEMPTS = '4';
    process.env.QWB_TRANSIENT_ATTEMPTS = '6';
    process.env.QWB_QUARANTINE_MAX = '20';
    process.env.QWB_QUARANTINE_TTL_MS = '3000';
    process.env.QWB_USER_ERROR_CHARS = '200';
    process.env.QWB_DIAG_MAX_BYTES = '4096';
    process.env.QWB_DIAG_RETENTION_DAYS = '3';
    process.env.QWB_PREFLIGHT_VERSION_TIMEOUT_MS = '1500';

    const config = loadConfig();

    expect(config).toMatchObject({
      baseUrl: 'https://example.test',
      token: 'token',
      botId: 'bot',
      ownerUserId: 'owner',
      allowFrom: ['a', 'b'],
      allowFirstSender: true,
      cwd: '/tmp',
      permissionMode: 'auto',
      qoderBin: '/bin/qodercli',
      qoderModel: 'model-x',
      memoryEnabled: false,
      personaFile: '/tmp/persona.md',
      inboxDir: '/tmp/inbox',
      ttsVoice: 'Voice',
      qoderTimeoutMs: 1234,
      maxReplyChars: 111,
      maxRepliesPerTurn: 5,
      outboxMaxItems: 10,
      outboxTtlMs: 2000,
      poisonMaxAttempts: 4,
      transientMaxAttempts: 6,
      quarantineMaxItems: 20,
      quarantineTtlMs: 3000,
      userErrorMaxChars: 200,
      diagnosticMaxBytes: 4096,
      diagnosticRetentionDays: 3,
      preflightVersionTimeoutMs: 1500,
    });
  });

  it('应该以 0600 权限保存配置', () => {
    saveConfig({ ...DEFAULT_CONFIG, token: 'secret' });

    const mode = fs.statSync(configPath()).mode & 0o777;
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf-8')).token).toBe('secret');
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });

  it('应该在目标配置不存在时迁移旧配置', () => {
    const legacy = path.join(root, 'legacy-config.json');
    fs.writeFileSync(legacy, JSON.stringify({ maxReplyChars: 1500 }));

    expect(migrateLegacyConfig(legacy)).toBe(true);
    expect(loadConfig().maxReplyChars).toBe(1500);
    expect(migrateLegacyConfig(legacy)).toBe(false);
  });

  it('应该在旧配置损坏时保持目标配置不变', () => {
    const legacy = path.join(root, 'legacy-config.json');
    fs.writeFileSync(legacy, '{bad json');

    expect(migrateLegacyConfig(legacy)).toBe(false);
    expect(fs.existsSync(configPath())).toBe(false);
  });
});

describe('状态归一化', () => {
  it('应该把旧 attempts 迁移为 failures 并补齐字段', () => {
    const state = normalizeState({
      outbox: [{ id: 'a', toUserId: 'u', text: '中文', createdAt: 1, attempts: 2 }],
    });

    expect(state.version).toBe(2);
    expect(state.outbox[0]).toMatchObject({
      id: 'a',
      toUserId: 'u',
      kind: 'reply',
      createdAt: 1,
      failures: 2,
      transientFailures: 0,
    });
    expect(state.outbox[0]?.bytes).toBe(Buffer.byteLength('中文', 'utf8'));
  });

  it('应该保留隔离区、额度与未知字段', () => {
    const state = normalizeState({
      quarantine: [{ id: 'q', text: 'bad', createdAt: 2, failures: 3, reason: 'permanent', preview: 'bad' }],
      quota: { streak: 2, lastAt: 99 },
      custom: 'kept',
    });

    expect(state.quarantine[0]).toMatchObject({ id: 'q', failures: 3, reason: 'permanent', preview: 'bad' });
    expect(state.quota).toEqual({ streak: 2, lastAt: 99 });
    expect((state as unknown as Record<string, unknown>).custom).toBe('kept');
  });

  it('应该过滤非法条目并对错误类型回退', () => {
    const state = normalizeState({
      outbox: [null, { text: 42 }],
      quarantine: [{}],
      quota: { streak: 'x', lastAt: null },
      sessions: [],
      seenMessageIds: [1, 'ok'],
      models: [],
      contextTokens: null,
    });

    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.text).toBe('');
    expect(state.quarantine).toHaveLength(1);
    expect(state.quota).toEqual({ streak: 0, lastAt: 0 });
    expect(state.sessions).toEqual({});
    expect(state.seenMessageIds).toEqual(['ok']);
    expect(state.models).toEqual({});
    expect(state.contextTokens).toEqual({});
  });
});

describe('状态读写', () => {
  it('应该读取旧状态文件并完成迁移', () => {
    ensureDirs();
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ outbox: [{ id: 'a', toUserId: 'u', text: 'x', createdAt: 1, attempts: 1 }] }),
    );

    const state = loadState();

    expect(state.version).toBe(2);
    expect(state.outbox[0]?.failures).toBe(1);
    expect(state.quarantine).toEqual([]);
  });

  it('应该在状态文件损坏或非对象时回退默认值', () => {
    ensureDirs();
    fs.writeFileSync(statePath(), '{bad');
    expect(loadState()).toEqual(DEFAULT_STATE);

    fs.writeFileSync(statePath(), '[]');
    expect(loadState()).toEqual(DEFAULT_STATE);
  });

  it('应该以 0600 权限原子保存状态', () => {
    saveState({ ...DEFAULT_STATE, seenMessageIds: ['m1'] });

    const mode = fs.statSync(statePath()).mode & 0o777;
    expect(JSON.parse(fs.readFileSync(statePath(), 'utf-8')).seenMessageIds).toEqual(['m1']);
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });
});

describe('运行记录', () => {
  it('应该写入、读取并按 pid 清理运行记录', () => {
    ensureDirs();
    writeRunInfo();

    const info = readRunInfo();
    expect(info?.pid).toBe(process.pid);
    expect(info?.cwd).toBe(process.cwd());

    clearRunInfo(process.pid + 1);
    expect(readRunInfo()?.pid).toBe(process.pid);

    clearRunInfo(process.pid);
    expect(readRunInfo()).toBeNull();
  });
});
