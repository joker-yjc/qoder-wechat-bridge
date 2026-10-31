/**
 * 出站媒体：AES-128-ECB 加密 → 上传微信 CDN → 发送图片/文件/视频/语音
 * 契约对齐官方 @tencent-weixin/openclaw-weixin@2.4.10
 * @module weixin/send-media
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { log } from '../log.js';
import { getUploadUrl, sendItem } from './client.js';
import { MessageItemType, UploadMediaType } from './types.js';

/** 微信媒体 CDN 基址 */
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** 出站单文件上限（官方适配器限制） */
const MAX_BYTES = 10 * 1024 * 1024;
/** 上传重试次数 */
const UPLOAD_RETRIES = 3;
/** 微信语音建议的最大时长 */
const MAX_VOICE_MS = 60_000;
/** 语音文本上限，避免生成过长音频 */
const MAX_VOICE_CHARS = 300;

/** 出站媒体的种类 */
export type MediaKind = 'image' | 'file' | 'video';

/** 发送结果 */
export interface SendMediaResult {
  kind: MediaKind;
  textSent: boolean;
  bytes: number;
}

/** 语音发送结果 */
export interface SendVoiceResult {
  bytes: number;
  durationMs: number;
}

/** 上传后的媒体引用 */
interface UploadedMedia {
  media: { encrypt_query_param: string; aes_key: string; encrypt_type: number };
  rawsize: number;
  filesize: number;
}

/**
 * AES-ECB 填充后的密文大小
 * @param plainSize - 明文大小
 * @returns 密文大小
 */
function paddedSize(plainSize: number): number {
  return Math.ceil((plainSize + 1) / 16) * 16;
}

/**
 * AES-128-ECB 加密（PKCS7）
 * 注意：ECB 是 iLink 协议固定要求，不是安全选择；仅用于与微信 CDN 互通
 * @param plaintext - 明文
 * @param key - 16 字节密钥
 * @returns 密文
 */
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * 按扩展名判断媒体种类
 * @param filePath - 文件路径
 * @returns 种类
 */
function kindOf(filePath: string): MediaKind {
  const ext = path.extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.m4v'].includes(ext)) return 'video';
  return 'file';
}

/**
 * 上传密文到 CDN，返回下载凭证
 * @param uploadUrl - 上传地址
 * @param ciphertext - 密文
 * @returns x-encrypted-param
 */
async function uploadCiphertext(uploadUrl: string, ciphertext: Buffer): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt += 1) {
    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status >= 400 && res.status < 500) {
        const detail = res.headers.get('x-error-message') ?? (await res.text().catch(() => ''));
        throw new Error(`CDN 客户端错误 ${res.status}: ${detail}`);
      }
      if (res.status !== 200) {
        const detail = res.headers.get('x-error-message') ?? `status ${res.status}`;
        throw new Error(`CDN 服务端错误: ${detail}`);
      }
      const param = res.headers.get('x-encrypted-param');
      if (!param) throw new Error('CDN 响应缺少 x-encrypted-param');
      return param;
    } catch (err) {
      lastError = err;
      if (String(err).includes('客户端错误')) break;
      log.warn('CDN 上传失败，准备重试', { attempt, error: String(err) });
    }
  }
  throw lastError instanceof Error ? lastError : new Error('CDN 上传失败');
}

/**
 * 通用上传：申请地址 → 加密 → 上传 → 返回媒体引用
 * @param buf - 明文
 * @param params - 目标、类型、凭据
 * @returns 媒体引用与大小
 */
async function uploadBinary(
  buf: Buffer,
  params: { baseUrl: string; token: string; toUserId: string; mediaType: number },
): Promise<UploadedMedia> {
  const rawsize = buf.length;
  const rawfilemd5 = crypto.createHash('md5').update(buf).digest('hex');
  const filesize = paddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);

  const upload = await getUploadUrl({
    baseUrl: params.baseUrl,
    token: params.token,
    filekey,
    mediaType: params.mediaType,
    toUserId: params.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskeyHex: aeskey.toString('hex'),
  });
  if ((upload.ret && upload.ret !== 0) || (upload.errcode && upload.errcode !== 0)) {
    throw new Error(`getUploadUrl 失败 ret=${upload.ret} errcode=${upload.errcode} errmsg=${upload.errmsg ?? ''}`);
  }
  const uploadUrl =
    upload.upload_full_url?.trim() ||
    (upload.upload_param
      ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : '');
  if (!uploadUrl) throw new Error('getUploadUrl 未返回上传地址');

  const ciphertext = encryptAesEcb(buf, aeskey);
  const downloadParam = await uploadCiphertext(uploadUrl, ciphertext);
  return {
    media: {
      encrypt_query_param: downloadParam,
      // 协议要求：base64(hex 字符串)，不是 base64(原始 16 字节)
      aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'),
      encrypt_type: 1,
    },
    rawsize,
    filesize,
  };
}

/**
 * 发送一个本地文件（图片/文件/视频）到微信
 * 若有文案，官方约定文案与媒体各发一条
 * @param params - 文件、目标用户、文案、context_token
 * @returns 发送结果
 */
export async function sendMediaFile(params: {
  filePath: string;
  toUserId: string;
  contextToken: string;
  text?: string;
  baseUrl: string;
  token: string;
}): Promise<SendMediaResult> {
  const resolved = path.resolve(params.filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`不是文件：${resolved}`);
  if (stat.size > MAX_BYTES) throw new Error(`文件超过 ${MAX_BYTES / 1024 / 1024}MB 限制`);
  if (stat.size === 0) throw new Error('文件为空');

  const plain = fs.readFileSync(resolved);
  const kind = kindOf(resolved);
  const mediaType =
    kind === 'image' ? UploadMediaType.IMAGE : kind === 'video' ? UploadMediaType.VIDEO : UploadMediaType.FILE;
  const uploaded = await uploadBinary(plain, {
    baseUrl: params.baseUrl,
    token: params.token,
    toUserId: params.toUserId,
    mediaType,
  });

  let item: Record<string, unknown>;
  if (kind === 'image') {
    item = { type: MessageItemType.IMAGE, image_item: { media: uploaded.media, mid_size: uploaded.filesize } };
  } else if (kind === 'video') {
    item = { type: MessageItemType.VIDEO, video_item: { media: uploaded.media, video_size: uploaded.filesize } };
  } else {
    item = {
      type: MessageItemType.FILE,
      file_item: { media: uploaded.media, file_name: path.basename(resolved), len: String(uploaded.rawsize) },
    };
  }

  let textSent = false;
  if (params.text?.trim()) {
    await sendItem({
      baseUrl: params.baseUrl,
      token: params.token,
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      item: { type: MessageItemType.TEXT, text_item: { text: params.text.trim() } },
    });
    textSent = true;
  }
  await sendItem({
    baseUrl: params.baseUrl,
    token: params.token,
    toUserId: params.toUserId,
    contextToken: params.contextToken,
    item,
  });
  log.info('媒体已发送', { kind, rawsize: uploaded.rawsize, filesize: uploaded.filesize, textSent, name: path.basename(resolved) });
  return { kind, textSent, bytes: uploaded.rawsize };
}

/**
 * 用 macOS 内置 TTS 把文字合成为微信语音并发送
 * 原型实现：say → afconvert → silk-wasm → CDN
 * @param params - 文本、发音人、目标用户、context_token
 * @returns 发送结果
 */
export async function sendVoiceFromText(params: {
  text: string;
  toUserId: string;
  contextToken: string;
  baseUrl: string;
  token: string;
  voice?: string;
}): Promise<SendVoiceResult> {
  if (process.platform !== 'darwin') {
    throw new Error('当前语音合成为原型实现，只支持 macOS（say + afconvert）');
  }
  const text = params.text.trim();
  if (!text) throw new Error('语音文本为空');
  if (text.length > MAX_VOICE_CHARS) {
    throw new Error(`语音文本超过 ${MAX_VOICE_CHARS} 字，请缩短后再发`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-voice-'));
  const aiffPath = path.join(workDir, 'voice.aiff');
  const wavPath = path.join(workDir, 'voice.wav');
  try {
    execFileSync('say', ['-v', params.voice ?? 'Tingting', '-o', aiffPath, text], { timeout: 30_000 });
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiffPath, wavPath], {
      timeout: 30_000,
    });
    const wav = fs.readFileSync(wavPath);

    // silk-wasm 直接接受 WAV，sampleRate 传 0 让它从文件头读取
    const { encode } = await import('silk-wasm');
    const silk = await encode(wav, 0);
    if (silk.duration > MAX_VOICE_MS) {
      throw new Error(`语音时长 ${Math.round(silk.duration / 1000)} 秒，超过 ${MAX_VOICE_MS / 1000} 秒上限`);
    }

    const uploaded = await uploadBinary(Buffer.from(silk.data), {
      baseUrl: params.baseUrl,
      token: params.token,
      toUserId: params.toUserId,
      mediaType: UploadMediaType.VOICE,
    });
    const voiceItem = {
      type: MessageItemType.VOICE,
      voice_item: {
        media: uploaded.media,
        // 平台实测：入站语音为 encode_type=4、16kHz、16bit，按客户端实际值镜像
        encode_type: 4,
        bits_per_sample: 16,
        sample_rate: 16_000,
        playtime: Math.round(silk.duration),
      },
    };
    log.info('发送语音项', {
      encode_type: 4,
      bits_per_sample: 16,
      sample_rate: 16_000,
      playtime: Math.round(silk.duration),
      silkBytes: silk.data.length,
    });
    await sendItem({
      baseUrl: params.baseUrl,
      token: params.token,
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      item: voiceItem,
    });
    log.info('语音已发送', { durationMs: silk.duration, silkBytes: silk.data.length, voice: params.voice ?? 'Tingting' });
    return { bytes: silk.data.length, durationMs: silk.duration };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
