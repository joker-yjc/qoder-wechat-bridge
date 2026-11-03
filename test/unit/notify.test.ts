import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_STATE, ensureDirs, saveConfig, saveState } from '../../src/config.js';
import { notify, pendingFilePath, takePending } from '../../src/notify.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-notify-'));
  process.env.QWB_CONFIG_DIR = path.join(root, 'config');
  process.env.QWB_STATE_DIR = path.join(root, 'state');
  ensureDirs();
  saveConfig({ ...DEFAULT_CONFIG, token: 't', ownerUserId: 'u', outboxMaxItems: 1, outboxTtlMs: 1000 });
  saveState({ ...DEFAULT_STATE, contextTokens: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.QWB_CONFIG_DIR;
  delete process.env.QWB_STATE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * 构造 JSON 响应
 * @param body - 响应体
 * @returns Response
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/**
 * 准备可发送状态
 */
function withContextToken(): void {
  saveState({ ...DEFAULT_STATE, contextTokens: { u: 'ctx' } });
}

describe('notify 入队', () => {
  it('应该在无 context_token 时排队', async () => {
    const result = await notify('hello');

    expect(result.status).toBe('queued');
    expect(result.queued).toBe(1);
    expect(fs.existsSync(pendingFilePath())).toBe(true);
    expect(takePending()).toHaveLength(1);
  });

  it('应该在队列满时拒绝新增', async () => {
    await notify('first');
    const second = await notify('second');

    expect(second.status).toBe('error');
    expect(second.message).toContain('队列已满');
    expect(fs.readFileSync(pendingFilePath(), 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('应该校验空内容、未登录与未授权目标', async () => {
    expect((await notify('   ')).status).toBe('error');
    expect((await notify('hi', 'stranger')).status).toBe('error');

    saveConfig({ ...DEFAULT_CONFIG, token: '', ownerUserId: 'u' });
    expect((await notify('hi')).status).toBe('error');

    saveConfig({ ...DEFAULT_CONFIG, token: 't', ownerUserId: '' });
    expect((await notify('hi')).message).toContain('授权账号');
  });

  it('应该在存在窗口时直接推送', async () => {
    withContextToken();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ret: 0, message_id: 'm' })));

    const result = await notify('hello');

    expect(result).toMatchObject({ status: 'sent', sent: 1, queued: 0 });
  });

  it('应该在额度耗尽时把剩余提醒排队', async () => {
    withContextToken();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ret: -2 })));

    const result = await notify('hello');

    expect(result.status).toBe('queued');
    expect(result.queued).toBe(1);
    expect(fs.existsSync(pendingFilePath())).toBe(true);
  });

  it('应该在会话过期时排队并提示重新登录', async () => {
    withContextToken();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ret: -14 })));

    const result = await notify('hello');

    expect(result.status).toBe('queued');
    expect(result.message).toContain('过期');
  });

  it('应该在网络失败时排队', async () => {
    withContextToken();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));

    const result = await notify('hello');

    expect(result.status).toBe('queued');
    expect(result.message).toContain('发送失败');
  });

  it('应该在多分片中途失败时保留剩余分片', async () => {
    withContextToken();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ret: 0, message_id: 'm1' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ret: -2 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notify('a'.repeat(2_500));

    expect(result.sent).toBe(1);
    expect(result.queued).toBe(1);
  });
});

describe('takePending', () => {
  it('应该在文件不存在时返回空数组', () => {
    expect(takePending()).toEqual([]);
  });

  it('应该丢弃过期提醒与坏行', () => {
    fs.writeFileSync(
      pendingFilePath(),
      [
        JSON.stringify({ id: 'old', toUserId: 'u', text: 'old', createdAt: Date.now() - 5000 }),
        JSON.stringify({ id: 'new', toUserId: 'u', text: 'new', createdAt: Date.now() }),
        '{bad json',
      ].join('\n'),
    );

    const items = takePending();

    expect(items.map((item) => item.id)).toEqual(['new']);
  });
});
