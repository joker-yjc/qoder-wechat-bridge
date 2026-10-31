/**
 * iLink 微信通道客户端：只实现 v1 需要的收发文本、typing、扫码登录
 * 契约对齐官方 @tencent-weixin/openclaw-weixin@2.4.10
 * @module weixin/client
 */
import crypto from 'node:crypto';
import { log } from '../log.js';
import type {
  GetConfigResp,
  GetUpdatesResp,
  QrCodeResp,
  QrStatusResp,
  SendMessageResp,
  UploadUrlResp,
  WeixinMessage,
} from './types.js';
import { MessageItemType, MessageState, MessageType, TypingStatus } from './types.js';

/** 官方插件的 ilink_appid，服务端按此识别客户端 */
const ILINK_APP_ID = 'bot';
/** 我们实现的协议版本（用于 iLink-App-ClientVersion 与 base_info.channel_version） */
const PROTOCOL_VERSION = '2.4.10';
/** bot_agent 遵循 UA 语法：name/version */
const BOT_AGENT = 'QoderWechatBridge/0.1.0';
/** 会话过期错误码 */
export const SESSION_EXPIRED_ERRCODE = -14;
/** 下行额度不足 / 上下文失效的常见错误码 */
export const CONTEXT_INVALID_RET = -2;

/**
 * 把 "2.4.10" 编码成 uint32：0x00MMNNPP
 * @param version - 版本字符串
 * @returns uint32 数值
 */
function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((p) => parseInt(p, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_CLIENT_VERSION = buildClientVersion(PROTOCOL_VERSION);

/** 请求基础信息 */
interface RequestOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  label: string;
}

/**
 * 生成本次请求的公共头
 * @param token - Bearer token，登录接口不需要
 * @returns 请求头
 */
function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
    'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64'),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

/** base_info 里需要的不带业务字段的公共信息 */
function buildBaseInfo(): Record<string, string> {
  return { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT };
}

/**
 * 统一 POST，返回原始文本
 * @param opts - 请求参数
 * @param endpoint - 相对路径
 * @param body - 请求体对象
 * @returns 响应文本
 */
async function postJson(opts: RequestOptions, endpoint: string, body: unknown, externalSignal?: AbortSignal): Promise<string> {
  const base = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
  const url = new URL(endpoint, base);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(opts.token),
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.label} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

/**
 * 统一 GET，返回原始文本
 * @param opts - 请求参数
 * @param endpoint - 相对路径（含 query）
 * @returns 响应文本
 */
async function getJson(opts: RequestOptions, endpoint: string): Promise<string> {
  const base = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
  const url = new URL(endpoint, base);
  const headers = buildHeaders(opts.token);
  delete headers['Content-Type'];
  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.label} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

/** 需要按字符串保留的 uint64 字段，避免 JSON 精度丢失 */
const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

/**
 * 解析响应 JSON，并把 uint64 id 字段包成字符串
 * 逐字符扫描，跳过字符串字面量，避免把正文里的同名片段改坏
 * @param rawText - 原始响应文本
 * @returns 解析结果
 */
export function parseWeixinJson<T>(rawText: string): T {
  let out = '';
  let i = 0;
  while (i < rawText.length) {
    if (rawText[i] !== '"') {
      out += rawText[i++];
      continue;
    }
    const start = i;
    i += 1;
    let escaped = false;
    while (i < rawText.length) {
      const ch = rawText[i++];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') break;
    }
    const strToken = rawText.slice(start, i);
    out += strToken;
    let cursor = i;
    while (/\s/.test(rawText[cursor] ?? '')) cursor += 1;
    if (rawText[cursor] !== ':') continue;
    let key: unknown;
    try {
      key = JSON.parse(strToken);
    } catch {
      continue;
    }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue;
    out += rawText.slice(i, cursor + 1);
    cursor += 1;
    while (/\s/.test(rawText[cursor] ?? '')) out += rawText[cursor++];
    const numStart = cursor;
    if (rawText[cursor] === '-') cursor += 1;
    while (/\d/.test(rawText[cursor] ?? '')) cursor += 1;
    if (cursor > numStart) {
      out += `"${rawText.slice(numStart, cursor)}"`;
      i = cursor;
    } else {
      i = numStart;
    }
  }
  return JSON.parse(out) as T;
}

/**
 * 取登录二维码（注意是 POST，且带 bot_type）
 * @param botType - 官方默认 "3"
 * @returns 二维码内容
 */
export async function getBotQrcode(botType = '3'): Promise<QrCodeResp> {
  const text = await postJson(
    { baseUrl: 'https://ilinkai.weixin.qq.com', label: 'getBotQrcode', timeoutMs: 20_000 },
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    {},
  );
  return JSON.parse(text) as QrCodeResp;
}

/**
 * 查询扫码状态（长轮询，超时视为 wait）
 * @param baseUrl - 查询地址，可能被 IDC 重定向替换
 * @param qrcode - 二维码标识
 * @param verifyCode - 手机端提示的校验数字
 * @returns 状态响应
 */
export async function pollQrStatus(baseUrl: string, qrcode: string, verifyCode?: string): Promise<QrStatusResp> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    const text = await getJson({ baseUrl, label: 'pollQrStatus', timeoutMs: 35_000 }, endpoint);
    return JSON.parse(text) as QrStatusResp;
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { status: 'wait' };
    }
    log.warn('pollQrStatus 失败，继续等待', { error: String(err) });
    return { status: 'wait' };
  }
}

/**
 * 长轮询收消息；客户端超时返回空响应（长轮询的正常控制流）
 * @param params - 基础地址、token、游标、超时
 * @returns 消息批次
 */
export async function getUpdates(params: {
  baseUrl: string;
  token: string;
  getUpdatesBuf: string;
  timeoutMs: number;
  /** 外部中断信号，用于优雅停机 */
  signal?: AbortSignal;
}): Promise<GetUpdatesResp> {
  try {
    const text = await postJson(
      { baseUrl: params.baseUrl, token: params.token, label: 'getUpdates', timeoutMs: params.timeoutMs },
      'ilink/bot/getupdates',
      { get_updates_buf: params.getUpdatesBuf, base_info: buildBaseInfo() },
      params.signal,
    );
    return parseWeixinJson<GetUpdatesResp>(text);
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
    }
    throw err;
  }
}

/**
 * 发送单条消息项（官方约定 item_list 只放一个元素）
 * @param params - 目标用户、消息项、context_token
 * @returns 服务端回执
 */
export async function sendItem(params: {
  baseUrl: string;
  token: string;
  toUserId: string;
  item: unknown;
  contextToken: string;
}): Promise<SendMessageResp> {
  const text = await postJson(
    { baseUrl: params.baseUrl, token: params.token, label: 'sendMessage', timeoutMs: 15_000 },
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: params.toUserId,
        client_id: `qoder-bridge-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [params.item],
        context_token: params.contextToken,
      },
      base_info: buildBaseInfo(),
    },
  );
  const resp = parseWeixinJson<SendMessageResp>(text);
  log.debug('sendMessage 回执', {
    ret: resp.ret,
    errcode: resp.errcode,
    errmsg: resp.errmsg,
    messageId: resp.message_id,
  });
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`);
  }
  if (resp.errcode && resp.errcode !== 0) {
    throw new Error(`sendMessage errcode=${resp.errcode} errmsg=${resp.errmsg ?? '(none)'}`);
  }
  return resp;
}

/**
 * 发送一条纯文本消息
 * @param params - 目标用户、正文、context_token
 * @returns 服务端回执
 */
export async function sendText(params: {
  baseUrl: string;
  token: string;
  toUserId: string;
  text: string;
  contextToken: string;
}): Promise<SendMessageResp> {
  return sendItem({
    baseUrl: params.baseUrl,
    token: params.token,
    toUserId: params.toUserId,
    contextToken: params.contextToken,
    item: { type: MessageItemType.TEXT, text_item: { text: params.text } },
  });
}

/**
 * 申请媒体上传地址
 * @param params - 文件元数据与目标用户
 * @returns upload_param / upload_full_url
 */
export async function getUploadUrl(params: {
  baseUrl: string;
  token: string;
  filekey: string;
  mediaType: number;
  toUserId: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  aeskeyHex: string;
}): Promise<UploadUrlResp> {
  const text = await postJson(
    { baseUrl: params.baseUrl, token: params.token, label: 'getUploadUrl', timeoutMs: 15_000 },
    'ilink/bot/getuploadurl',
    {
      filekey: params.filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      no_need_thumb: true,
      aeskey: params.aeskeyHex,
      base_info: buildBaseInfo(),
    },
  );
  return JSON.parse(text) as UploadUrlResp;
}

/**
 * 取 typing_ticket
 * @param params - 目标用户与 context_token
 * @returns typing ticket，失败返回空串
 */
export async function getTypingTicket(params: {
  baseUrl: string;
  token: string;
  userId: string;
  contextToken: string;
}): Promise<string> {
  try {
    const text = await postJson(
      { baseUrl: params.baseUrl, token: params.token, label: 'getConfig', timeoutMs: 10_000 },
      'ilink/bot/getconfig',
      { ilink_user_id: params.userId, context_token: params.contextToken, base_info: buildBaseInfo() },
    );
    return (JSON.parse(text) as GetConfigResp).typing_ticket ?? '';
  } catch (err) {
    log.warn('getConfig 取 typing_ticket 失败', { error: String(err) });
    return '';
  }
}

/**
 * 发送 typing 状态
 * @param params - 目标用户、ticket、状态
 */
export async function sendTyping(params: {
  baseUrl: string;
  token: string;
  userId: string;
  typingTicket: string;
  status: number;
}): Promise<void> {
  try {
    await postJson(
      { baseUrl: params.baseUrl, token: params.token, label: 'sendTyping', timeoutMs: 10_000 },
      'ilink/bot/sendtyping',
      {
        ilink_user_id: params.userId,
        typing_ticket: params.typingTicket,
        status: params.status,
        base_info: buildBaseInfo(),
      },
    );
  } catch (err) {
    log.debug('sendTyping 失败（忽略）', { error: String(err) });
  }
}

/**
 * 通知服务端客户端启动/停止（用于让微信侧正确显示在线状态）
 * @param params - 基础地址、token、动作
 */
export async function notifyClient(params: { baseUrl: string; token: string; action: 'start' | 'stop' }): Promise<void> {
  try {
    await postJson(
      { baseUrl: params.baseUrl, token: params.token, label: `notify${params.action}`, timeoutMs: 10_000 },
      `ilink/bot/msg/notify${params.action}`,
      { base_info: buildBaseInfo() },
    );
  } catch (err) {
    log.debug('notify 失败（忽略）', { error: String(err) });
  }
}

/**
 * 提取消息里的文本
 * 图片/文件/视频由 media 模块下载后作为附件传给 Qoder；语音只取微信转写
 * 没有转写的语音返回空串，由上层给出提示，避免把占位文本当成任务
 * @param msg - 微信消息
 * @returns 归一化文本
 */
export function extractText(msg: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      if (item.ref_msg?.title) parts.push(`[引用] ${item.ref_msg.title}`);
      parts.push(item.text_item.text);
    } else if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      parts.push(item.voice_item.text);
    }
  }
  return parts.join('\n').trim();
}

/** 导出供外部判断 typing 常量 */
export { TypingStatus };
