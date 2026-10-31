# Qoder × 个人微信机器人 插件可行性验证

- 日期：2026-10-30
- 类型：Spike（可行性验证，产出为结论，不含留存代码）
- 前提确认：微信通道 = OpenClaw / iLink 个人微信；场景 = 单聊；架构假设 = 外部常驻桥接进程推给 Qoder
- 参照实现：`~/LangBot/src/langbot/pkg/platform/sources/openclaw_weixin.py`（655 行）及其 SDK `~/LangBot/src/langbot/libs/openclaw_weixin_api/`（client.py 835 行）

---

## 一句话结论

**「做一个 Qoder 插件、让外部进程把微信消息塞进 Qoder 桌面（Desktop）会话」不成立** —— Qoder Desktop 没有对外入站接口，插件里的 MCP 只能是「宿主拉起子进程 + agent 主动调用工具」的拉取模型，方向反过来不成立。

**但「把个人微信接到 Qoder agent 上」这件事完全成立，而且有两条正规路径**：外部常驻进程改用 **Qoder Agent SDK / qodercli headless** 作为后端（会话在 CLI 侧，与桌面历史隔离），或者直接用 **Qoder Cloud Agents 官方 Forward Channel 的 `wechat` 通道**（个人微信、仅扫码，官方已内建，几乎零自研）。这台机器当前唯一的硬阻塞是 node v16 让 `qodercli` 跑不起来。

---

## 一、微信侧事实（iLink / OpenClaw 个人微信）

### 1.1 通道是官方开放的，门槛极低

扫码即可拿到 `bot_token` + `baseurl`，**不需要在开放平台建应用、不需要密钥、不需要付费、没有白名单**。微信版本要求 ≥ 8.0.69。官方实现是腾讯的 `@tencent-weixin/openclaw-weixin`（npm，v2.4.10，2026-10-11 更新；仓库 `Tencent/openclaw-weixin`，含 `docs/protocol_zh_CN.md`）。

> 验证状态：`registry.npmjs.org` 本机实测已确认 —— `@tencent-weixin/openclaw-weixin` 存在，`latest = 2.4.10`（发布于 2026-10-11），1.0.0 起 `author = Tencent`、license MIT，维护者 7 人中 6 个是 `@tencent.com` 邮箱（amikara / pumpkinxing / jfengjiang / yubingluo / unixliang / ruiqihong）+ `zengyi1001`。**GitHub 仓库与下面的 issue 编号是子代理经 WebFetch 取到的二手证据**：本机 `curl https://github.com/Tencent/openclaw-weixin` 直连超时，无法一手复核。

### 1.2 协议契约（LangBot `client.py` 行号为证）

| 环节 | 实际调用 |
|---|---|
| 取码 | `GET /ilink/bot/get_bot_qrcode?bot_type=3`（L518） |
| 轮询扫码状态 | `GET /ilink/bot/get_qrcode_status?qrcode=...`（L559），`confirmed` 时返回 token/baseurl/bot_id（L577-583） |
| 收消息 | `POST /ilink/bot/getupdates`，body 仅 `get_updates_buf` + `base_info{channel_version}`（L212、L119-121），长轮询，客户端超时 40s（L55），服务端可用 `longpolling_timeout_ms` 动态改超时 |
| 发消息 | `POST /ilink/bot/sendmessage`，字段 `to_user_id / client_id / message_type=2 / message_state=2 / item_list / context_token`（L240-262） |
| 输入提示 | `getconfig` → `typing_ticket`（L272）、`sendtyping` status 1/2（L286），ticket TTL 600s + 5s keepalive |
| 媒体 | `getuploadurl`（L504）+ CDN `novac2c.cdn.weixin.qq.com/c2c`（L50），AES-128-ECB 加解密 |

本地能力边界：文本按 2000 字符切片且**发送侧无节流**（L64、L264-267）；媒体上限 10 MiB；错误码只实现了 `-14`（L59）；事件转换只产出 `FriendMessage`，`message_type != TYPE_USER` 直接丢弃（adapter L220）；文件/语音/视频的下载分支全被注释掉，只放开了图片。

**群聊是官方明确关闭的**：`capabilities.chatTypes:["direct"]`、`groupPolicy:"disabled"`。这与本次「单聊就够」的选择吻合，不需要换通道。

### 1.3 参照对象要换：LangBot 的实现已经和官方协议漂移

LangBot 这份适配器缺官方要求的 `iLink-App-Id: bot` 头、uint32 版 `iLink-App-ClientVersion`、`base_info.bot_agent`；官方 `get_bot_qrcode` 已改成 POST；官方新增 `notifystart/notifystop`、`upload_full_url`、`run_id`、`TOOL_CALL_START/RESULT`(类型 11/12)、uint64 消息 ID 无损解析 —— LangBot 一个都没有。

结论：**流程照 LangBot 读，实现照官方 TS 包写**。真做的时候不该复用 LangBot 的 Python SDK。

### 1.4 对「后端是编程 agent、一次跑几分钟」最致命的三条

这三条决定了产品形态，跟选哪条 Qoder 路径无关：

1. **回复时效挂在 `context_token` 上。** 社区实测：最后一次入站后约 24h 内还能下行，超时后 `sendmessage` 返回 `ret=-2`（issue #202 / #225 / #309）。也就是说**结果迟到就永久丢失**，agent 跑 20 分钟能扛，跑到第二天就没了。`-14` 会话过期时，官方实现会直接暂停该账号 1 小时，LangBot 则退化成需要人工重新扫码。
2. **一次入站大概只有 10 条下行额度。** issue #81 实测同一 `context_token` 连发 10 条后转 `ret=-2`，官方回复是「已催促产品同事重新评估」= 尚未放开。长任务的分片输出 + 过程汇报会很快耗尽额度。
3. **`ret=0` 只代表受理，不保证送达。** 官方协作人明确说过微信可按风控静默过滤（#278）；另有 `errmsg="rate limited"`（#142）。叠合起来最坏情况是：发送调用成功、日志无错、用户手机上什么都没有。反复扫码绑定会被识别为安全风险并封控账号（#278 / #253）。

缓解手段（来自官方协议，非突破限制）：5s typing keepalive 让「正在忙」可见、`TOOL_CALL` 进度气泡、blockStreaming 的 `textChunkLimit:4000`/minChars 200/idle 3s 分块。

---

## 二、Qoder 侧事实

### 2.1 插件（Plugin）能装什么，不能干什么

官方定义：插件是 Skills / MCP Servers / Agents / Commands / Rules / Hooks 的任意组合包，组件在设置里标记 *From Plugin*、不可单独禁用。Desktop 侧走 Extensions → Plugins 市场或 *Upload Plugin* 导入本地 ZIP；CLI 侧是 `.qoder-plugin/plugin.json`（`name` 必填，不能放根目录）+ 约定目录 `commands/ agents/ skills/ hooks/ output-styles/ workflows/ bin/`，MCP 写 `.mcp.json`。

本机已安装插件印证（`~/.qoder/plugins/cache/**`，`installed_plugins_v2.json` 记录 `installPath`），插件内 MCP 的两种形态：

- 远程 HTTP：`context7/1.0.0/.mcp.json` → `{"type":"http","url":"https://mcp.context7.com/mcp"}`
- 本地 stdio 子进程：`computer-use/.mcp.json` → `"command":"./bin/computer-use-client-launcher"`，由宿主进程（pid 47205）拉起并常驻到会话结束

**方向是关键**：Qoder 拉起子进程（宿主 → 本地进程），agent 主动调用工具。官方文档里没有 MCP server 主动向 agent 推 `notifications/*` / sampling / elicitation 的任何描述。所以插件可以「Qoder 被叫醒后去微信拉一把消息」，**不能**「微信来消息时叫醒 Qoder」。

会话钩子（`SessionStart`/`PostToolUse` 执行本地二进制，见 `security-scan/.qoder-plugin/qoder-hooks.json`）同样是宿主驱动的被动触发，不能凭空起会话。

### 2.2 Desktop 无对外编程入口 —— 官方口径 + 本机取证一致

- 本机 `127.0.0.1` 上属于 Qoder 进程的三个监听端口（51349 MCP 路由 / 51329 browser-use / 52765）实测只读 GET 全部 401 / 401 / 404 —— 有 token 门禁的内部服务；`~/.qoder/mcp-router.json` 里那个 `apiKey` 是 Qoder **消费外部 MCP** 的路由凭据，不是外部驱动会话的入口。`~/.qoder/ipc` 只有一个 json，无 unix socket。
- `~/.qoder/mcp.json` 是 5 个出站 server 的登记表，无 inbound 通道。
- Remote Control（也就是我这次会话工作目录 `.../remote-control/sessions/<uuid>/<uuid>` 那套）只服务**同账号**的 Qoder Mobile 或 qoder.com/agents H5，经官方云同步，本地不提供 API。主进程 `remoteControlProcess.js` 用 node:sqlite 读会话库、把事件 JSONL 写进目录 —— 是内部落盘，不是对外契约。
- 桌面库里 `agent_inbox_items`（`trigger_reason ∈ {mention,reply}`、`delivery_mode ∈ {started,queued,steered}`）、`qoder_daemon_remote_session_launches`、`rc_channel_admissions` 这些**入站表结构已经存在但全部 0 行** —— 说明官方正在长这个能力，目前没有可用的对外语义。

### 2.3 真正可程序化的入口在 CLI / SDK / Cloud

| 入口 | 能力 | 对本方案的意义 |
|---|---|---|
| `qodercli -p/--print` | `--output-format text\|json\|stream-json`、`-c` 续上次、`-r <id>` 恢复指定会话 | 桥接进程一次一发，输出可机器解析，`-r` 用来按微信用户保上下文 |
| Agent SDK（TS/Python/Java） | 自带 qodercli 运行时，one-shot `query()` + 多轮 session、resume/fork/checkpoint/外部会话存储；官方文档直接给了「HTTP 请求 / 队列消息 → Agent 会话」的后端形态；每个活跃会话一个 qodercli 进程；无人值守需 allow/deny + `dontAsk` | **最贴合「外部常驻桥接」的正解** |
| ACP | `qoder --acp` 作为 stdio Agent Server，任意 ACP 客户端可拉起；登录态与 CLI 共享或 `QODER_PERSONAL_ACCESS_TOKEN` | 想复用现成 ACP 客户端生态时走这条 |
| Cloud Agents API | `POST /api/v1/{cloud\|forward}/sessions` + `.../events` 送消息 + `GET .../events/stream` SSE + `.../cancel`；同一会话单轮（running 时再发 409）、请求体 4MB；Schedules 支持手动 `POST /forward/schedules/{id}/run`；Webhook 仅出站（36 事件 + signing_secret） | 云端会话驱动，可 SSE 读回 |
| **Forward Channel `wechat`** | channel_type 官方含 `dingtalk / feishu / wecom / wechat / teams`；**个人微信仅 QR-code 绑定，不需要在任何开放平台建应用、无直接凭证**；`fixed` 模式（所有入站消息走同一 identity+template）与 `pairing` 模式（先发配对码，管理员调 pair API 绑 identity+template） | **官方已经替你做完「微信 → agent 会话」这一整段** |
| Desktop Automations / 定时任务 | 本机 `scheduled_tasks` 表 5 行、2 条 enabled，`trigger ∈ {scheduled, manual, missed-recovery}`，字段含 `cwd / prompt / permission_mode / execution_policy_json({"permissionMode":"bypassPermissions"}) / merged_session_id / output_mode`，每次运行生成真实会话 | 能落到 Desktop，但外部无触发入口；官方要求 App 开着 + Keep device awake；CLI 侧定时需进程常驻、上限 50 条、周期任务 7 天过期、最小 1 分钟、同目录文件锁 |

> `wechat` 通道那条我亲自抓过官方页面正文确认（不是转述），原文：*Personal WeChat only supports QR-code binding — no need to create an app on any open platform, and no direct credentials are required.*

**重要边界**：Cloud / SDK 的会话**不驱动桌面 GUI 会话**，官方文档明确桌面与 CLI 数据分开；云运行时**不支持本地 MCP、settings、hooks、plugins、checkpoint**，也就是拿不到你本机的代码库。

### 2.4 本机现状：唯一但彻底的阻塞

- `qodercli` 在 PATH：`/usr/local/bin/qodercli -> ../lib/node_modules/@qoder-ai/qodercli/bundle/qodercli.js`，v1.0.0（2026-05-20），`engines.node: ">=20.0.0"`。
- 本机 `node -v` = **v16.18.0**，实测 `qodercli --version` 直接 `SyntaxError: Invalid regular expression flags`。未找到任何 node 20+（`~/.nvm/versions/node` 不存在，`/usr/local/Cellar/node*` 与 `/opt/homebrew/Cellar/node*` 均无）。
- `/usr/local/bin/qoder` 是**悬空符号链接**：目标 `/Applications/Qoder.app/Contents/Resources/app/bin/code` 不存在 —— 连 IDE 命令行启动器都不可用。
- 连 `npm view` 本身都在 node16 上崩（`npm v11.19.0 does not support Node.js v16.18.0`）。
- 好消息：桥接宿主现成 —— LangBot 正在跑（python3.1 pid 61706，监听 `*:5300`，`curl http://127.0.0.1:5300/` → 200，`~/LangBot/data/langbot.db` 存在）。

---

## 三、推荐路径（按正规程度排序）

### 路径 A —— 本机仓库 + 微信（如果目的是「在微信里指挥我电脑上的 Qoder 干活」）

外部常驻桥接进程（Node）：用官方 `@tencent-weixin/openclaw-weixin` 做 `getUpdates` 长轮询收消息 → 内嵌 **Qoder Agent SDK** 起会话（`微信 from_user_id ↔ Qoder session id` 做映射，靠 resume 保上下文）→ 结果 `sendmessage` 回微信。**Qoder 插件只用来承载 skills/MCP 能力包，不承担消息入口。**

前置动作只有一个：装 node ≥ 20（当前 v16 是唯一硬阻塞，且按你的偏好可以用免安装的二进制包而不是 brew 编译）。

代价：这条链路的会话只在 CLI 侧，桌面 GUI 历史里看不到；无人值守要自己配权限（allow/deny + `dontAsk`）。

### 路径 B —— 官方云端（如果只要「微信里有个 Qoder agent」，不吃本机代码库）

Cloud Agents Forward Channel `wechat`：扫码绑个人微信号 → fixed 模式配 `identity_id` + `template_id` → 官方把入站消息路由到会话。几乎零自研代码。限制：云运行时不支持本地 MCP/plugins/checkpoint，拿不到本机仓库。

### 路径 C —— 必须发生在桌面 GUI 里

只剩 `scheduled_tasks` 轮询式兜底：桥接进程把待办写进本地文件，定时任务 prompt 里让 agent 读取并回复，输出从 `~/.qoder/projects/<slug>/<session-id>.jsonl` tail 回来。分钟级延迟、需 App 常驻，且直接往内部 SQLite 插 `manual` 行属于无契约 hack —— **不建议当架构用**，只作为「非桌面不可」时的临时验证手段。

---

## 四、跟选哪条路无关的产品瓶颈

微信侧「≈10 条下行额度 + ≈24h 时效 + `ret=0` 不保证送达」对上「agent 动辄几分钟、中间输出几十条」是使用层面的真瓶颈。落地必须按这三条设计：中间过程不回微信（用 typing 提示 / 官方 `TOOL_CALL` 进度气泡）；只回最终结果、按 ≤2000 字分片且总量控制在额度内；把「结果迟到即丢」当前提 —— 超时降级为写文件 + 下一条入站时补发。

另外，个人微信号一旦被机器人接管，封控风险由这个号承担（反复扫码绑定即触发识别，官方协作人明确说明）。建议先拿小号验证。

---

## 五、未验证 / 无法验证清单

1. 24h 时效与 10 条额度**没有官方文档数值**，仅 issue 实测；服务端文本/媒体硬上限、QPS 配额、封号阈值、SLA、独立客户端接入申请入口（#265 至今无官方回复）均无法验证。
2. 官方 npm 包 `@tencent-weixin/openclaw-weixin` 的存在、版本、维护者归属已在本机经 `registry.npmjs.org` 实测确认；但**协议文档 `docs/protocol_zh_CN.md` 与全部 issue 编号（#81/#142/#202/#225/#253/#265/#278/#309）来自子代理 WebFetch，本机 GitHub 直连超时未能一手复核**——把 1.4 那三条约束当结论用之前，建议先手动打开仓库确认一次。
3. Agent SDK / ACP 的安装体积、PAT 登录流程、`stream-json` 输出的真实字段，未在本机跑过（本次约定不写代码）。
4. `agent_inbox_items` 等入站表是否会成为官方对外契约，未知。
5. 三条路径的端到端时延与稳定性均未实测。

---

## Sources

- [Plugins – Qoder](https://docs.qoder.com/extensions/plugins)
- [Qoder Plugins (Desktop)](https://docs.qoder.com/qoder/plugins)
- [Qoder CLI Plugins Reference](https://docs.qoder.cn/en/cli/plugins-reference)
- [Qoder CLI MCP Reference](https://docs.qoder.com/cli/mcp-reference) / [MCP Servers](https://docs.qoder.com/cli/mcp-servers)
- [Qoder CLI Run Tasks](https://docs.qoder.com/cli/run-tasks)
- [Qoder Agent SDK Overview](https://docs.qoder.com/cli/sdk/overview) / [Integration Scenarios](https://docs.qoder.com/cli/sdk/integration-scenarios) / [Cloud Agent](https://docs.qoder.com/cli/sdk/cloud-agent)
- [Qoder CLI ACP](https://docs.qoder.com/cli/acp)
- [Qoder CLI Scheduled Tasks](https://docs.qoder.com/cli/scheduled-tasks) / [Qoder Automations](https://docs.qoder.com/qoder/automations)
- [Cloud Agents Sessions API](https://docs.qoder.com/cloud-agents/sessions) / [API Conventions](https://docs.qoder.com/cloud-agents/api/conventions/overview) / [Run a Schedule](https://docs.qoder.com/cloud-agents/api/forward/schedules/run) / [Webhooks Overview](https://docs.qoder.com/cloud-agents/api/webhooks/overview)
- [Message Channel Integration（含 Personal WeChat）](https://docs.qoder.com/cloud-agents/api/forward/channels/message-channel-integration)
- [Qoder Remote Control (Desktop)](https://docs.qoder.com/qoder/remote-control) / [CLI Remote Control](https://docs.qoder.com/cli/remote-control)
- [Tencent/openclaw-weixin 官方仓库](https://github.com/Tencent/openclaw-weixin) / [protocol_zh_CN.md](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md) / [npm @tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
- 通道限制 issue：[#202 会话时效与主动消息条数](https://github.com/Tencent/openclaw-weixin/issues/202)、[#81 同一 context_token 10 条后 ret=-2](https://github.com/Tencent/openclaw-weixin/issues/81)、[#142 rate limited](https://github.com/Tencent/openclaw-weixin/issues/142)、[#225 token 过期](https://github.com/Tencent/openclaw-weixin/issues/225)、[#278 ret=0 不保证送达/封控](https://github.com/Tencent/openclaw-weixin/issues/278)、[#253 是否会封号](https://github.com/Tencent/openclaw-weixin/issues/253)、[#265 个人开发者接入申请](https://github.com/Tencent/openclaw-weixin/issues/265)
- [epiral/weixin-bot（社区逆向 SDK）](https://github.com/epiral/weixin-bot)
- [LangBot 个人微信文档](https://langbot.app/docs/zh/usage/platforms/wechat/weixin) / [OpenClaw Channels 文档](https://docs.openclaw.ai/channels/openclaw-weixin)
