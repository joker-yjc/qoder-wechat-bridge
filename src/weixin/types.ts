/**
 * iLink 微信协议类型（对齐官方 @tencent-weixin/openclaw-weixin@2.4.10 的 JSON 契约）
 * @module weixin/types
 */

/** 消息项类型 */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

/** 消息归属类型：1=用户发来，2=机器人发出 */
export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;

/** 消息状态 */
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

/** typing 状态：1=正在输入，2=取消 */
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

/** 媒体引用（图片/文件/语音/视频共用） */
export interface MediaRef {
  encrypt_query_param?: string;
  aes_key?: string;
}

/** 消息项 */
export interface MessageItem {
  type: number;
  text_item?: { text?: string };
  image_item?: { media?: MediaRef; url?: string };
  voice_item?: { text?: string; media?: MediaRef };
  file_item?: { file_name?: string; len?: number; media?: MediaRef };
  video_item?: { media?: MediaRef };
  /** 被引用的原消息 */
  ref_msg?: { title?: string; message_item?: MessageItem };
}

/** 一条微信消息 */
export interface WeixinMessage {
  message_id?: string;
  seq?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  run_id?: string;
  item_list?: MessageItem[];
}

/** getupdates 响应 */
export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  /** 服务端建议的长轮询时长 */
  longpolling_timeout_ms?: number;
}

/** 取二维码响应 */
export interface QrCodeResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  /** 二维码内容，可直接编码成二维码 */
  qrcode?: string;
  /** 二维码承载的链接（与 qrcode 同源，便于兜底展示） */
  qrcode_img_content?: string;
}

/** 扫码状态响应 */
export interface QrStatusResp {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** sendmessage 响应 */
export interface SendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  message_id?: string;
}

/** getconfig 响应 */
export interface GetConfigResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  typing_ticket?: string;
}
