import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractText,
  getBotQrcode,
  getTypingTicket,
  getUpdates,
  getUploadUrl,
  notifyClient,
  parseWeixinJson,
  pollQrStatus,
  sendItem,
  sendText,
  sendTyping,
} from '../../src/weixin/client.js';
import { HttpError } from '../../src/weixin/errors.js';
import { MessageItemType } from '../../src/weixin/types.js';

/**
 * 构造 JSON 响应
 * @param body - 响应体
 * @param status - 状态码
 * @returns Response
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * 按顺序 mock fetch
 * @param responses - 响应或异常
 * @returns mock 函数
 */
function mockFetch(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) fn.mockRejectedValueOnce(response);
    else fn.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseParams = { baseUrl: 'https://example.test', token: 't', toUserId: 'u', contextToken: 'c' };

describe('JSON 解析', () => {
  it('应该把大整数 id 保留为字符串且不改坏正文', () => {
    const raw = '{"message_id": 12345678901234567890, "text": "{\\"message_id\\":1}", "n": -12}';
    const parsed = parseWeixinJson<Record<string, unknown>>(raw);

    expect(parsed.message_id).toBe('12345678901234567890');
    expect(parsed.text).toBe('{"message_id":1}');
    expect(parsed.n).toBe(-12);
  });
});

describe('sendText', () => {
  it('应该返回服务端回执', async () => {
    const fetchMock = mockFetch(jsonResponse({ ret: 0, message_id: 'm1' }));

    const resp = await sendText({ ...baseParams, text: 'hi' });

    expect(resp.message_id).toBe('m1');
    expect(fetchMock.mock.calls[0]?.[0].toString()).toContain('ilink/bot/sendmessage');
  });

  it('应该把 ret=-2 归类为额度耗尽', async () => {
    mockFetch(jsonResponse({ ret: -2, errmsg: 'quota' }));
    await expect(sendText({ ...baseParams, text: 'hi' })).rejects.toMatchObject({ kind: 'quota', ret: -2 });
  });

  it('应该把 ret=-14 与 errcode=-14 归类为会话过期', async () => {
    mockFetch(jsonResponse({ ret: -14 }), jsonResponse({ ret: 0, errcode: -14 }));
    await expect(sendText({ ...baseParams, text: 'hi' })).rejects.toMatchObject({ kind: 'session_expired' });
    await expect(sendText({ ...baseParams, text: 'hi' })).rejects.toMatchObject({ kind: 'session_expired' });
  });

  it('应该把未知 ret / errcode 归类为 unknown', async () => {
    mockFetch(jsonResponse({ ret: 7 }), jsonResponse({ ret: 0, errcode: 8 }));
    await expect(sendText({ ...baseParams, text: 'hi' })).rejects.toMatchObject({ kind: 'unknown', ret: 7 });
    await expect(sendText({ ...baseParams, text: 'hi' })).rejects.toMatchObject({ kind: 'unknown', errcode: 8 });
  });

  it('应该把 HTTP 错误映射为对应分类', async () => {
    mockFetch(
      jsonResponse({}, 429),
      jsonResponse({}, 401),
      jsonResponse({}, 500),
      jsonResponse({}, 400),
    );
    await expect(sendText({ ...baseParams, text: 'hi' })).rejects.toMatchObject({ kind: 'quota', httpStatus: 429 });
    await expect(sendText({ ...baseParams, text: 'hi' })).rejects.toMatchObject({
      kind: 'session_expired',
      httpStatus: 401,
    });
    await expect(sendText({ ...baseParams, text: 'hi' })).rejects.toMatchObject({ kind: 'transient', httpStatus: 500 });
    await expect(sendText({ ...baseParams, text: 'hi' })).rejects.toMatchObject({ kind: 'permanent', httpStatus: 400 });
  });

  it('应该把网络异常归类为瞬时失败', async () => {
    mockFetch(new TypeError('fetch failed'));
    await expect(sendText({ ...baseParams, text: 'hi' })).rejects.toMatchObject({ kind: 'transient' });
  });
});

describe('sendItem', () => {
  it('应该把非消息项也按同一规则发送', async () => {
    mockFetch(jsonResponse({ ret: 0, message_id: 'm2' }));
    const resp = await sendItem({ ...baseParams, item: { type: 1 } });
    expect(resp.message_id).toBe('m2');
  });
});

describe('getUpdates', () => {
  it('应该返回消息批次', async () => {
    mockFetch(jsonResponse({ ret: 0, msgs: [], get_updates_buf: 'next' }));
    const resp = await getUpdates({ ...baseParams, getUpdatesBuf: 'cur', timeoutMs: 1000 });
    expect(resp.get_updates_buf).toBe('next');
  });

  it('应该在超时时返回空批次', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    mockFetch(timeout);
    const resp = await getUpdates({ ...baseParams, getUpdatesBuf: 'cur', timeoutMs: 1000 });
    expect(resp).toEqual({ ret: 0, msgs: [], get_updates_buf: 'cur' });
  });

  it('应该在 HTTP 错误时抛出 HttpError', async () => {
    mockFetch(jsonResponse({}, 500));
    await expect(getUpdates({ ...baseParams, getUpdatesBuf: 'cur', timeoutMs: 1000 })).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});

describe('登录与配置接口', () => {
  it('应该获取二维码', async () => {
    mockFetch(jsonResponse({ qrcode: 'qr' }));
    await expect(getBotQrcode()).resolves.toEqual({ qrcode: 'qr' });
  });

  it('应该轮询扫码状态并在超时/异常时返回 wait', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    mockFetch(jsonResponse({ status: 'confirmed' }), timeout, new Error('boom'));
    await expect(pollQrStatus('https://example.test', 'qr')).resolves.toEqual({ status: 'confirmed' });
    await expect(pollQrStatus('https://example.test', 'qr')).resolves.toEqual({ status: 'wait' });
    await expect(pollQrStatus('https://example.test', 'qr')).resolves.toEqual({ status: 'wait' });
  });

  it('应该获取上传地址', async () => {
    mockFetch(jsonResponse({ upload_full_url: 'https://upload' }));
    const resp = await getUploadUrl({
      baseUrl: 'https://example.test',
      token: 't',
      filekey: 'k',
      mediaType: 1,
      toUserId: 'u',
      rawsize: 1,
      rawfilemd5: 'm',
      filesize: 1,
      aeskeyHex: 'a',
    });
    expect(resp.upload_full_url).toBe('https://upload');
  });

  it('应该获取 typing ticket，失败时返回空串', async () => {
    mockFetch(jsonResponse({ typing_ticket: 'ticket' }), new Error('boom'));
    await expect(getTypingTicket({ ...baseParams, userId: 'u' })).resolves.toBe('ticket');
    await expect(getTypingTicket({ ...baseParams, userId: 'u' })).resolves.toBe('');
  });

  it('应该在 typing / notify 失败时静默', async () => {
    mockFetch(new Error('boom'), new Error('boom'));
    await expect(
      sendTyping({ baseUrl: 'https://example.test', token: 't', userId: 'u', typingTicket: 'x', status: 1 }),
    ).resolves.toBeUndefined();
    await expect(notifyClient({ baseUrl: 'https://example.test', token: 't', action: 'start' })).resolves.toBeUndefined();
  });
});

describe('extractText', () => {
  it('应该提取文本、语音与引用标题', () => {
    const msg = {
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: 'hello' }, ref_msg: { title: 'ref' } },
        { type: MessageItemType.VOICE, voice_item: { text: 'voice' } },
      ],
    };
    expect(extractText(msg)).toBe('[引用] ref\nhello\nvoice');
  });

  it('应该在无可用内容时返回空串', () => {
    expect(extractText({})).toBe('');
  });
});
