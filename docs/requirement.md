# 需求：个人微信 → 本机 Qoder（单聊）

> 状态：待开工 ｜ 更新：2026-10-30

## 1. 背景

用户日常在手机微信里，但希望干活的是本机 Qoder（能访问本机代码库、本机 MCP / skills / 配置）。官方 Qoder Cloud Agents 虽已内建 `wechat` 个人微信通道，但云运行时不支持本地 MCP / settings / hooks / plugins / checkpoint，拿不到本机仓库，因此不能替代本机 agent。

## 2. 目标

在**个人微信单聊**里给 Qoder 发任务，由本机常驻进程把消息投递给 Qoder agent 会话，处理结果回到微信。

### 用户故事

- 作为用户，我在手机上给机器人发一条任务（如「把 my-app 的 X 接口加上鉴权」），电脑上的 Qoder 执行，我在微信收到结果。
- 作为用户，我和机器人的多轮对话能保持上下文（同一人对应同一会话）。
- 作为用户，任务要跑几分钟时，我能看到「正在处理」而不是以为它死了。

## 3. 范围

**In scope**

- 单聊（好友消息）收发
- 文本为主；图片 / 文件 / 语音 / 视频按官方通道能力尽量支持
- 每个微信用户独立会话，多轮上下文延续
- 长任务的进度可见与最终结果可靠回传

**Out of scope**

- 群聊（官方 iLink 通道 `groupPolicy: "disabled"`，不支持）
- 多租户 / 云端部署 / 公网服务
- 替代 Qoder Desktop GUI（会话在 CLI 侧，桌面历史不可见）
- 修改 Qoder Desktop 内部数据库或调用其内部端口

## 4. 硬约束（已实测或已取证）

| # | 约束 | 依据 |
|---|---|---|
| C1 | 微信通道仅单聊，群聊官方关闭 | 官方包 `capabilities.chatTypes:["direct"]`、`groupPolicy:"disabled"` |
| C2 | 扫码登录拿 token，无需开放平台建应用/白名单/付费 | 官方包 + 协议文档；微信 ≥ 8.0.69 |
| C3 | 单条入站消息约 10 条下行额度；`context_token` 约 24h 时效；`ret=0` 不保证送达 | 社区 issue 实测，**无官方文档数值**，需一手复现 |
| C4 | Qoder Desktop 无对外入站 API；程序化入口只有 CLI / Agent SDK / ACP / Cloud API | 官方文档 + 本机端口与服务取证 |
| C5 | `qodercli` 要求 node ≥ 20；本机为 v16.18.0，当前不可用 | `package.json engines` + 实跑报错 |
| C6 | 官方微信插件 `peerDependencies: openclaw >= 2026.5.12`，不能脱离 OpenClaw 运行，但协议层可剥离 | 包元数据 + 131 文件结构 |
| C7 | 无人值守需显式权限策略（allow/deny + `dontAsk`） | Qoder Agent SDK 文档 |
| C8 | 个人号被机器人接管有封控风险 | 官方协作人说明 + issue；建议小号先行 |

## 5. 验收标准（EARS）

- **R1** WHEN 已授权微信好友发送文本消息 THEN THE 桥接服务 SHALL 在 10 秒内将消息路由到该好友对应的 Qoder 会话。
- **R2** WHEN 某微信好友首次发消息 THEN THE 桥接服务 SHALL 为其创建独立会话，不得与其他人共享上下文。
- **R3** WHILE Qoder 会话处理中 THE 桥接服务 SHALL 保持「正在输入」指示可见（typing 5s keepalive），不得静默无反馈。
- **R4** WHEN Qoder 会话产出最终结果 THEN THE 桥接服务 SHALL 按 ≤2000 字符分片回传，且单个 `context_token` 下的下行条数不超过通道额度。
- **R5** IF 处理耗时可能超过 `context_token` 有效期 THEN THE 桥接服务 SHALL 将结果落盘并在下一次入站时补发，而非丢弃。
- **R6** IF 通道返回 `-14`（会话过期） THEN THE 桥接服务 SHALL 停止使用该 token 并提示重新扫码，不得静默重试或高频重登。
- **R7** WHEN 发送接口返回 `ret=0` THEN THE 桥接服务 SHALL 按「仅受理、不保证送达」处理（记录投递状态，不假设成功）。
- **R8** IF 微信消息非文本 THEN THE 桥接服务 SHALL 复用官方协议层的媒体下载/转码能力，失败时降级为文本占位，不阻塞后续消息。

## 6. 待用户确认

- 授权范围：白名单好友，还是任意好友？
- 权限模式：`bypassPermissions`（省事、风险高）还是允许清单？
- 是否接受「会话不在桌面 GUI 里可见」这一代价？
- 用个人主号还是小号做验证？
