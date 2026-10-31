/**
 * 入站媒体：从微信 CDN 下载、AES-128-ECB 解密、落盘待用
 * 契约对齐官方 @tencent-weixin/openclaw-weixin@2.4.10
 * @module weixin/media
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { MessageItemType, type MediaRef, type MessageItem } from './types.js';

/** 微信媒体 CDN 基址 */
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** 单个附件大小上限 */
const MAX_BYTES = 20 * 1024 * 1024;
/** 下载超时 */
const FETCH_TIMEOUT_MS = 30_000;
/** 收件箱保留天数 */
const INBOX_TTL_DAYS = 7;

/** 落盘后的附件 */
export interface SavedMedia {
  path: string;
  name: string;
  kind: 'image' | 'file' | 'video' | 'voice';
  bytes: number;
}

/**
 * 解析 CDN 的 aes_key：支持 base64(16 字节) 与 base64(32 字符 hex)
 * @param keyBase64 - CDN 下发的 key
 * @returns 16 字节密钥
 */
function parseAesKey(keyBase64: string): Buffer {
  const decoded = Buffer.from(keyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`aes_key 格式不支持（解码后 ${decoded.length} 字节）`);
}

/**
 * AES-128-ECB 解密（PKCS7）
 * @param ciphertext - 密文
 * @param key - 16 字节密钥
 * @returns 明文
 */
function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 构造下载地址：优先 full_url，否则用 CDN 回退拼接
 * @param media - 媒体引用
 * @returns 下载地址
 */
function buildDownloadUrl(media: MediaRef): string {
  if (media.full_url) return media.full_url;
  if (!media.encrypt_query_param) throw new Error('媒体缺少下载参数');
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
}

/**
 * 根据文件头推断图片扩展名
 * @param buf - 文件内容
 * @returns 扩展名，未知返回 .jpg
 */
function sniffImageExt(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) return '.gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return '.jpg';
}

/**
 * 清洗文件名，去掉路径分隔符与控制字符
 * @param name - 原始文件名
 * @param fallback - 兜底名
 * @returns 安全文件名
 */
function safeName(name: string | undefined, fallback: string): string {
  const base = path.basename(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return base || fallback;
}

/**
 * 下载并解密一个媒体项
 * @param media - 媒体引用
 * @returns 明文
 */
async function fetchMedia(media: MediaRef): Promise<Buffer> {
  const url = buildDownloadUrl(media);
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CDN 下载失败 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`附件超过 ${MAX_BYTES / 1024 / 1024}MB`);
  return buf;
}

/**
 * 下载一条消息里的媒体并落盘
 * 语音不在这里处理（优先用微信转写文本）
 * @param item - 消息项
 * @param messageId - 消息 id，用于建目录
 * @param index - 同一条消息内的序号
 * @param inboxDir - 附件根目录
 * @returns 落盘结果；不支持的项返回 null
 */
export async function downloadItemMedia(
  item: MessageItem,
  messageId: string,
  index: number,
  inboxDir: string,
): Promise<SavedMedia | null> {
  let media: MediaRef | undefined;
  let kind: SavedMedia['kind'] | null = null;
  let name = '';
  let key: Buffer | undefined;

  if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
    media = item.image_item.media;
    kind = 'image';
    // 图片偶尔带 item 级 aeskey（hex），优先级高于 media.aes_key
    key = item.image_item.aeskey
      ? Buffer.from(item.image_item.aeskey, 'hex')
      : media.aes_key
        ? parseAesKey(media.aes_key)
        : undefined;
    name = '';
  } else if (item.type === MessageItemType.FILE && item.file_item?.media) {
    media = item.file_item.media;
    kind = 'file';
    key = media.aes_key ? parseAesKey(media.aes_key) : undefined;
    name = safeName(item.file_item.file_name, `file-${index}.bin`);
  } else if (item.type === MessageItemType.VIDEO && item.video_item?.media) {
    media = item.video_item.media;
    kind = 'video';
    key = media.aes_key ? parseAesKey(media.aes_key) : undefined;
    name = `video-${index}.mp4`;
  } else if (item.type === MessageItemType.VOICE && item.voice_item?.media) {
    media = item.voice_item.media;
    kind = 'voice';
    key = media.aes_key ? parseAesKey(media.aes_key) : undefined;
    name = `voice-${index}.silk`;
  }

  if (!media || !kind) return null;

  const raw = await fetchMedia(media);
  const plain = key ? decryptAesEcb(raw, key) : raw;
  if (kind === 'image' && !name) name = `image-${index}${sniffImageExt(plain)}`;

  const dir = path.join(inboxDir, safeName(messageId, `msg-${Date.now()}`));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${index}-${name}`);
  fs.writeFileSync(filePath, plain, { mode: 0o600 });
  log.info('附件已保存', { messageId, kind, name, bytes: plain.length, path: filePath });
  return { path: filePath, name, kind, bytes: plain.length };
}

/**
 * 统计一个目录/文件的字节数与文件数
 * @param target - 路径
 * @returns 统计结果
 */
function measure(target: string): { bytes: number; files: number } {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return { bytes: stat.size, files: 1 };
    let bytes = 0;
    let files = 0;
    for (const entry of fs.readdirSync(target)) {
      const child = measure(path.join(target, entry));
      bytes += child.bytes;
      files += child.files;
    }
    return { bytes, files };
  } catch {
    return { bytes: 0, files: 0 };
  }
}

/**
 * 统计附件目录占用
 * @param inboxDir - 附件根目录
 * @returns 字节数与文件数
 */
export function inboxUsage(inboxDir: string): { bytes: number; files: number } {
  return measure(inboxDir);
}

/**
 * 清理过期的收件箱文件
 * @param inboxDir - 附件根目录
 * @param maxAgeDays - 保留天数
 */
export function pruneInbox(inboxDir: string, maxAgeDays = INBOX_TTL_DAYS): void {
  if (!fs.existsSync(inboxDir)) return;
  const deadline = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(inboxDir)) {
    const dir = path.join(inboxDir, entry);
    try {
      const stat = fs.statSync(dir);
      if (stat.mtimeMs < deadline) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // 忽略单个条目的失败
    }
  }
}

/**
 * 清理附件目录
 * @param inboxDir - 附件根目录
 * @param opts - all=true 全删；否则只删早于 days 天的条目
 * @returns 删除的文件数与字节数
 */
export function cleanInbox(
  inboxDir: string,
  opts: { all?: boolean; days?: number } = {},
): { removed: number; bytes: number } {
  if (!fs.existsSync(inboxDir)) return { removed: 0, bytes: 0 };
  const days = opts.days ?? INBOX_TTL_DAYS;
  const deadline = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(inboxDir)) {
    const target = path.join(inboxDir, entry);
    try {
      const stat = fs.statSync(target);
      if (opts.all || stat.mtimeMs < deadline) {
        const size = measure(target);
        fs.rmSync(target, { recursive: true, force: true });
        removed += size.files;
        bytes += size.bytes;
      }
    } catch {
      // 忽略单个条目的失败
    }
  }
  return { removed, bytes };
}
