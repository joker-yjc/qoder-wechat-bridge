# 技术方案可行性：剥离官方微信插件协议层 + 接 Qoder Agent SDK

> 结论先行：**可行**。方案的实质是「复用腾讯官方通道实现 + 换掉 agent 宿主」，
> 不是从零写微信协议，也不是把插件装进 Qoder（后者不成立）。
> 更新：2026-10-30 ｜ 证据等级：包结构/依赖已一手取证；端到端未实跑

## 1. 为什么不是「做一个 Qoder 插件」

- Qoder 插件 = Skills / MCP / Agents / Commands / Rules / Hooks 的组合包，插件内的 MCP 由**宿主拉起子进程**、**agent 主动调工具**（本机 `computer-use/.mcp.json` 即 stdio 子进程）。
- 官方文档未见 MCP server 主动向 agent 推 `notifications/*` 的机制。
- Desktop 无对外入站接口：本机三个 `127.0.0.1` 端口实测 401/401/404；`~/.qoder/ipc` 无 socket；remote-control 只服务同账号官方端；桌面库 `agent_inbox_items` 等入站表存在但 0 行。
- 因此**入口必须在 Qoder 之外**，插件只能作为能力包（skills / MCP）随 CLI 加载。

## 2. 拆包结论（一手取证）

`@tencent-weixin/openclaw-weixin@2.4.10`（MIT，2026-10-11 发布，7 名维护者中 6 名 @tencent.com）

```
dependencies:    { zod, qrcode-terminal }      ← 运行时第三方依赖仅此两个
peerDependencies:{ openclaw: ">=2026.5.12" }   ← 整个包不能脱离 OpenClaw
文件数: 131
```

### 2.1 可直接搬走（纯通道层，与 OpenClaw 无关）

| 模块 | 职责 |
|---|---|
| `src/api/api.js` `types.js` `config-cache.js` | iLink HTTP 契约：getupdates / sendmessage / uploadurl / config |
| `src/api/session-guard.js` | 会话过期保护（-14 触发账号级暂停，避免高频重登） |
| `src/cdn/aes-ecb.js` `cdn-url.js` `cdn-upload.js` `pic-decrypt.js` | 媒体 CDN 加解密与上传下载 |
| `src/media/media-download.js` `mime.js` `silk-transcode.js` | 图片/文件拉取、语音 silk 转码 |
| `src/auth/login-qr.js` `pairing.js` `accounts.js` | 扫码登录、配对、多账号 |
| `src/storage/sync-buf.js` `state-dir.js` | get_updates 游标、状态目录 |
| `src/util/logger.js` `redact.js` `random.js` | 基础工具 |

### 2.2 必须丢弃（OpenClaw 耦合层）

`src/channel.js`（OpenClaw channel 接口实现）、`src/index.js`、`src/compat.js`、`src/config/config-schema.js`、`src/messaging/*` 中与 agent 循环绑定的部分（`dispatch-options` / `process-message` / `reply-progress-sender` / `slash-commands` / `outbound-hooks`）。

其中 `messaging/` 里的**协议侧**子模块（分片、引用、markdown 过滤、进度气泡文案）可参考逻辑重写，但不要直接复用其耦合。

### 2.3 自己写的部分

inbound 归一化 → 会话路由 → Qoder Agent SDK 调用 → 输出聚合与可靠性回传。这一层是方案的主体工作量。

## 3. 架构草案

```
┌──────────── 微信 ────────────┐
│ 单聊好友                       │
└──────────┬───────────────────┘
           │ iLink getupdates（长轮询，服务端可持有 ~35s）
┌──────────▼───────────────────┐
│ wx-transport（剥离自官方包）    │  登录/游标/媒体/typing/-14 保护
└──────────┬───────────────────┘
           │ NormalizedMessage{ wxUserId, items[], contextToken, msgId }
┌──────────▼───────────────────┐
│ session-router               │  wxUserId ↔ qoderSessionId 持久映射
└──────────┬───────────────────┘
           │ prompt（首次 query / 后续 resume）
┌──────────▼───────────────────┐
│ agent-runner                 │  Qoder Agent SDK（TS），每活跃会话一个 qodercli 进程
│  - 权限策略 allow/deny/dontAsk │
│  - 流式输出聚合                │
└──────────┬───────────────────┘
           │ Reply{ text, attachments[] }
┌──────────▼───────────────────┐
│ delivery                     │  ≤2000 字分片 / 条数额度 / typing 保活
│  - 超时 → 落盘 + 下次入站补发   │
└──────────┬───────────────────┘
           │ sendmessage(to_user_id, context_token)
           ▼
        微信用户
```

### 3.1 关键组件职责

| 组件 | 输入 | 输出 | 边界 |
|---|---|---|---|
| wx-transport | token, 游标 | 归一化消息 / 发送 API | 只懂微信，不懂 agent |
| session-router | wxUserId | qoderSessionId | 只懂映射，无业务逻辑 |
| agent-runner | prompt + session | 最终文本 / 附件、流式进度 | 只懂 Qoder，不懂微信 |
| delivery | Reply + contextToken | 成功/失败/待补发 | 只懂额度与时序 |

### 3.2 数据与状态

- 映射表：`wxUserId → { qoderSessionId, lastContextToken, pendingResults[] }`，本地 SQLite 或 JSONL。
- 结果落盘：`~/.qoder-wechat-bridge/outbox/<msgId>.json`，下次入站补发。
- 游标：`get_updates_buf` 持久化，进程重启不丢消息。

## 4. 备选路径与取舍

| 路径 | 可行性 | 代价 | 结论 |
|---|---|---|---|
| **A. 剥离协议层 + Agent SDK**（本方案） | 可行 | 需 node ≥20；会话不在桌面 GUI；要自配权限 | **推荐** |
| B. 官方 Cloud Agents `wechat` 通道 | 官方支持，零自研 | 云运行时不支持本地 MCP/plugins/checkpoint，拿不到本机仓库 | 只在「不需要本机代码库」时选 |
| C. 保留 OpenClaw 当宿主，插件直连 | 官方包即为此设计 | agent 是 OpenClaw 的，不是 Qoder；要做 Qoder 必须再套一层 | 不满足「给 Qoder 用」 |
| D. 桌面 scheduled_tasks 轮询 | 结构存在（本机 5 行/2 enabled） | 分钟级延迟、需 App 常驻、写内部 SQLite 无契约 | hack，仅兜底 |
| E. wechat-bot 类 Web 协议方案 | 技术可行，且能进群 | Web 协议风控、封号、违反微信条款 | 本轮不需要群聊，**不采用** |

## 5. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 个人号封控 | 号被封 | 先用小号；控制发送频率；避免反复扫码绑定 |
| 下行额度 ≈10 条 | 长任务结果丢失 | 过程不回微信，只回最终结果；≤2000 字分片；超限落盘 |
| `context_token` ≈24h | 迟到结果无法送达 | outbox + 下次入站补发 |
| `ret=0` 不保证送达 | 用户收不到且无报错 | 记录投递状态；关键结果要求用户回执/重发 |
| 官包与 LangBot 实现漂移 | 照 LangBot 写会缺头部字段/新能力 | 只以官方包为准，LangBot 仅作流程参考 |
| node 版本 | 当前完全跑不起来 | 先装 node ≥20（免安装二进制） |

## 6. 未验证项（开工前必须先证）

1. **端到端未跑**：本次只做静态取证与文档，没有真实扫码、没有真实收发。
2. **协议层剥离可编译**：131 文件是 `dist/` 编译产物，TS 源码结构未一手核对（本机 GitHub 直连超时）；剥离后与原 OpenClaw 类型解耦的工作量未估。
3. **SDK 输出契约**：`stream-json` 真实字段、resume 语义、并发上限未实测。
4. **通道额度数值**：10 条 / 24h 来自社区 issue，需一手复现。
5. **silk 语音 / 视频**：官方包有能力，但剥离后在本机可用性未测。
6. **权限模型**：无人值守时 `dontAsk` + allowlist 的实际行为未测。

## 7. 建议的下一步（最小验证顺序）

1. 装 node ≥20，确认 `qodercli --version` 与 `-p --output-format json "echo hi"` 可用。
2. 只搬 `auth + api + storage`，写 80 行脚本：扫码登录 → 收到一条真实消息 → 原样回一条文本。**这一步过了，方案就算成立。**
3. 再把 `messaging` 层接上 Agent SDK，跑一条真实任务（如「列出当前目录下最近修改的三个文件」）。
4. 才谈媒体、多会话、可靠性与插件包。

## 8. 来源

- 今日调研全文：[research/2026-10-30-feasibility.md](research/2026-10-30-feasibility.md)（含 Qoder 官方文档链接与 issue 编号）
- 官方通道包：`@tencent-weixin/openclaw-weixin@2.4.10`（本机经 registry 实测；包结构由 tarball 直接解析）
- 本机取证路径：`~/.qoder/plugins/cache/**`、`~/.qoder/mcp-router.json`、`~/Library/Application Support/com.qoder.app.stable/main.sqlite`
