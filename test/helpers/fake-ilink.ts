/**
 * 本地假 iLink 服务：用于集成测试，不访问真实微信通道
 * @module test/helpers/fake-ilink
 */
import http from 'node:http';

/** 出站消息 */
export interface SentMessage {
  text: string;
  contextToken: string;
}

/** 发送失败配置 */
export interface SendFailure {
  /** 业务 ret */
  ret?: number;
  /** HTTP 状态码 */
  status?: number;
}

/** 假 iLink 服务 */
export interface FakeILink {
  baseUrl: string;
  sent: SentMessage[];
  actions: string[];
  enqueue: (msg: unknown) => void;
  failText: (text: string, failure: SendFailure) => void;
  clearFailure: (text: string) => void;
  close: () => Promise<void>;
}

/**
 * 启动假 iLink 服务
 * @returns 服务句柄
 */
export async function startFakeILink(): Promise<FakeILink> {
  const queue: unknown[] = [];
  const sent: SentMessage[] = [];
  const actions: string[] = [];
  const failures = new Map<string, SendFailure>();

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let json: Record<string, unknown> = {};
      try {
        json = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      } catch {
        json = {};
      }

      const send = (status: number, payload: unknown): void => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname.endsWith('/getupdates')) {
        const messages = queue.splice(0, queue.length);
        const respond = (): void => send(200, { ret: 0, msgs: messages, get_updates_buf: 'buf' });
        if (messages.length > 0) respond();
        else setTimeout(respond, 20);
        return;
      }

      if (url.pathname.endsWith('/sendmessage')) {
        const msg = (json.msg ?? {}) as { item_list?: Array<{ text_item?: { text?: string } }>; context_token?: string };
        const text = msg.item_list?.[0]?.text_item?.text ?? '';
        const failure = failures.get(text);
        if (failure?.status) {
          send(failure.status, {});
          return;
        }
        if (failure && failure.ret !== undefined) {
          send(200, { ret: failure.ret });
          return;
        }
        sent.push({ text, contextToken: msg.context_token ?? '' });
        send(200, { ret: 0, message_id: `m${sent.length}` });
        return;
      }

      if (url.pathname.endsWith('/getconfig')) {
        send(200, { ret: 0, typing_ticket: 'ticket' });
        return;
      }

      if (url.pathname.includes('/msg/notify')) {
        actions.push(url.pathname.split('/').pop() ?? '');
        send(200, { ret: 0 });
        return;
      }

      send(200, { ret: 0 });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sent,
    actions,
    enqueue: (msg: unknown): void => {
      queue.push(msg);
    },
    failText: (text: string, failure: SendFailure): void => {
      failures.set(text, failure);
    },
    clearFailure: (text: string): void => {
      failures.delete(text);
    },
    close: (): Promise<void> =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
