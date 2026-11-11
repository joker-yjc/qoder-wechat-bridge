# RUNBOOK

面向本机部署的运维手册。通用安装说明见 [README.md](README.md)。

## 1. 环境要求

| 项 | 要求 | 备注 |
|---|---|---|
| Node | `>= 20` | 低于 20 时用 `n 22` 或安装 LTS |
| qodercli | `>= 1.1.80`，且已 `qodercli login` | 未登录时执行浏览器授权 |
| 微信 | `>= 8.0.69` | 官方 iLink 通道，仅单聊；建议先用小号验证 |

如需切换 Node 版本：`n 22`。

## 2. 目录

| 用途 | 路径 |
|---|---|
| 配置（含 token，600） | `~/.config/qoder-wechat-bridge/config.json` |
| 人设文件（可选） | `~/.config/qoder-wechat-bridge/persona.md` |
| 状态（游标、会话映射、补发队列） | `~/.local/state/qoder-wechat-bridge/state.json` |
| 实例锁（同状态目录互斥，600） | `~/.local/state/qoder-wechat-bridge/run.lock` |
| bot 级锁（跨状态目录同 bot 互斥，600） | `~/.local/state/qoder-wechat-bridge/instances/<sha1(botId) 前 16 位>.lock` |
| 待补发提醒（notify 排队） | `~/.local/state/qoder-wechat-bridge/pending-notifications.jsonl` |
| 日志 | `~/.local/state/qoder-wechat-bridge/logs/bridge-YYYY-MM-DD.jsonl` |
| 失败诊断（qodercli 输出，7 天） | `~/.local/state/qoder-wechat-bridge/logs/diagnostics/YYYY-MM-DD/` |
| 登录二维码 | `~/.local/state/qoder-wechat-bridge/wechat-qr.png` |
| 入站附件缓存（7 天） | `~/.local/state/qoder-wechat-bridge/inbox/` |
| 无 TTY 时的校验码 | `~/.local/state/qoder-wechat-bridge/verify-code.txt` |

## 3. 启动 / 停止

```bash
cd <项目目录>
./启动桥接.command          # 双击也可以
# 或（默认不限定目录，按配置里的模型运行）
node dist/cli.js run
# 临时指定目录
node dist/cli.js run --cwd ~/projects/my-app
```

停止：`Ctrl+C`，或另开终端执行 `node dist/cli.js stop`。手动实例会收到 SIGTERM，`stop` 会取消正在执行的 qodercli 任务并等它落定（正常退出 0，超时 1）；launchd 托管时不发信号（发了会被 KeepAlive 重新拉起），而是打印 `launchctl bootout`、验证、恢复和兜底命令，并返回 2。运行记录失效时会继续扫进程和 launchd 标签；多实例只报告冲突并列出每个 pid 的 `kill -TERM` 命令。

### 实例互斥与重启重叠

`run` 在开始长轮询之前先占两把锁：`stateDir/run.lock`（同一状态目录只允许一个实例）与 `~/.local/state/qoder-wechat-bridge/instances/<sha1(botId) 前 16 位>.lock`（跨状态目录跑同一个 bot 也会被拦）。已有存活实例时拒绝启动并退出码 1，打印对方 pid、状态目录、启动时间、工作目录与处置命令；launchd 在跑而你想手动起，就是这个提示，不是启动失败。

停服时的顺序是：停止入站 → 取消已启动的 qodercli 任务 → 等队列排空（上限 3 秒）→ 清 `run.json` 并释放锁。排空超时则**保留锁**，等任务落定后补释放；此时立刻再起会被拒绝，最长要等到在途任务结束（上界 `QWB_TIMEOUT_MS`，默认 10 分钟）。launchd 场景由 KeepAlive 的 30s 节流自然重试，不需要人工干预。

锁内 pid 仍存活但命令行看起来不像桥接进程时（pid 被无关进程占用、或变成僵尸进程），实现**不会删别人的锁**，只会拒绝启动。确认无实例后按提示执行 `rm "<锁文件>"` 即可恢复——这是唯一的人工出口。

**停止窗口内已拉到的消息会被丢弃**：`get_updates_buf` 在轮询阶段就已推进，而 iLink 不再重投，所以正在下载附件、或还排在队列里没起跑的消息不会再被处理，只留一条 info 日志。这属于设计取舍：宁可少回一条，也不允许两个实例同时写状态。要让停服期间的消息不丢，需要入站队列持久化（未排期）。

### Windows

```bat
cd /d <项目目录>
启动桥接.cmd            rem 双击也可以
node dist\cli.js run    rem 或直接前台运行
```

停止（前台 `Ctrl+C`；后台运行时）：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*dist\cli.js run*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

日志与进程：

```powershell
Get-Content "$env:USERPROFILE\.local\state\qoder-wechat-bridge\logs\bridge-$(Get-Date -Format yyyy-MM-dd).jsonl" -Tail 20
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*dist\cli.js run*" }
```

> Windows 下配置文件在 `%USERPROFILE%\.config\qoder-wechat-bridge\`，状态与附件在 `%USERPROFILE%\.local\state\qoder-wechat-bridge\`（沿用 XDG 目录，功能正常，只是不符合 Windows 惯例）。

## 4. 常用命令

```bash
node dist/cli.js status                      # 查看配置与会话
node dist/cli.js login                       # 重新扫码（token 过期/换号）
node dist/cli.js notify "需要你确认一下"       # 主动提醒（无窗口时排队）
node dist/cli.js send-file ./chart.png        # 发图片/文件/视频（≤10MB）
node dist/cli.js send-voice "构建完成了"       # [实验性] 语音，客户端可能不显示；发音频请用 send-file
node dist/cli.js stop                         # 停止服务（取消进行中的任务）
node dist/cli.js clean [--days N|--all]       # 清理入站附件（默认 7 天前）
node dist/cli.js run --inbox-dir ~/qwb-inbox  # 自定义附件目录
node dist/cli.js run --permission-mode dont_ask
```

微信内置命令：`/help`（命令总览）、`/status`、`/reset`、`/stop`（停止当前任务）、`/model`（列出模型）、`/model <序号|名称>`（切换）、`/model default`（恢复 Auto）。

> 自定义 provider 的模型必须写成 `<providerId>/<model>`（如 `qoder-custom-xxxx/glm-5.3`），只写短名会被 Qoder 静默回落到 `auto`；`/model` 内部已做这层映射。

## 5. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `sdk_worker_removed` | 从 Qoder 桌面终端启动，继承了 `QODER_*` | 本包已在拉起 qodercli 时剥离；若仍出现，用 `.command` 从 Finder 启动 |
| `Not logged in · Please run /login` | qodercli 未登录 | `qodercli login`，浏览器授权 |
| `SyntaxError: Invalid regular expression flags` | node 仍是 v16 | `n 22` |
| 扫码后 `binded_redirect` | 该微信号已绑过其它 OpenClaw 形态机器人 | 先解绑，或换号 |
| 收消息正常但回复失败 `ret=-2` | 下行额度耗尽 / context_token 失效 | 消息保留在 outbox，下一次入站优先补发；不计数、不隔离。连续出现时看 `status` 的额度告警 |
| qodercli 异常退出 / 输出无法解析 | 子进程崩溃、输出不是 JSON、或语义错误码未收录 | 只回一条短错误；诊断在 `logs/diagnostics/`，单文件 ≤64KB，头部含 `errorClass` / `errorCode`。语义分类见 5.1 |
| 反复收到同一类错误 | `model_quota` / `output_limit` / `auth` 在去重窗口内只发一条完整提示，其余发短回执；`unknown` 不去重 | 属预期行为；被抑制次数看日志 `category=suppressed`。窗口用 `QWB_ERROR_DEDUP_WINDOW_MS` 调整 |
| 错误提示一条都没收到 | 下行额度耗尽 / 会话过期时错误提示被丢弃（不入队，只写日志） | 看日志 `错误提示未送达，不推进去重窗口`；正常回复仍在 outbox 等下个窗口补发 |
| 隔离区有消息 | 某条消息连续永久失败，已停止自动补发 | `status` 查看数量；手动恢复需停服编辑 `state.json` 的 `quarantine`，或等 7 天过期 |
| outbox 超限 / 过期 | 补发队列达到 200 条或 24 小时 | 查看日志中的 `outbox 超限` / `消息已过期`，旧消息会被丢弃 |
| `stop` 退出码 2 | launchd 托管，未真正停止 | 执行它打印的 `launchctl bootout gui/<uid>/<label>` |
| 启动即提示「已在运行：pid …」 | 已有存活实例持有 `run.lock` / bot 锁；或旧版实例（0.3.0 及更早不写锁）仍在跑，被 `run.json` 兜底拦下 | 按输出先停旧实例（launchd 用 `bootout`）再起新版；反复出现时用 `pgrep -fl "qoder-wechat run"` 确认 |
| 执行 `stop` 后新实例一时起不来 | 在途任务 3 秒内没排空，锁按设计保留，等任务落定才补释放 | 属预期。等任务结束（上界 `QWB_TIMEOUT_MS`，默认 10 分钟）；急用时再发一次停止信号，第二次会立即退出 |
| 拒绝启动且对方 pid 看着像无关进程 | pid 被复用或已成僵尸；实现不删别人的锁 | 确认机器上没有桥接实例后，执行提示里给出的 `rm "<锁文件>"` |
| 刚重启过，某条消息没回复 | 停止窗口内已拉取但未起跑的消息被丢弃（游标已推进，iLink 不再重投） | 属预期行为；请对方重发。详见 §3「实例互斥与重启重叠」 |
| `stop` 退出码 1 | 发出信号但进程未退出 | 再执行一次 `stop`，第二次信号会立即结束 |
| 语音只收到"没有转写"的提示 | 平台未提供该条语音的转写 | 让用户重发或改用文字；要 100% 覆盖需接 ASR |
| `stop` 回"没有运行记录" | 0.1.x 旧版本只依赖 `run.json` | 0.2.0 会继续扫进程和 launchd 标签；仍失败时用 `pgrep -fl "qoder-wechat run"` / `launchctl list` 手工确认 |
| 日志 `-14` | 微信会话过期 | 重新 `login`；不要高频重登（会触发风控） |
| `npm error EACCES ~/.npm/_cacache` | 缓存目录有 root 所有的文件 | 用 `--cache ./.npm-cache`，或自行修复缓存权限 |
| `install-scripts` 拦截 esbuild | npm 11 默认禁止 postinstall | 本项目不依赖 tsx/esbuild，用 `tsc` 构建即可 |

### 5.1 错误类别速查

桥接把 qodercli 的失败分成**传输层类别**（`errorKind`，进程怎么失败的）与**业务语义类别**（`errorClass`，qodercli 报的是什么），两者正交，都记在日志与诊断文件头里。

| `errorClass` | 识别特征（实测） | 用户看到 | 处置 |
|---|---|---|---|
| `model_quota` | `error_code=110`（数字）或 `error_message` 含 `Billing daily count exceeded` | `模型额度已用尽：…` | 稍后重试或 `/model` 换模型。实测 110 不是硬性全天封锁：2026-11-05 曾出现 23:21 失败、23:22 同模型成功 |
| `output_limit` | `error_code="max_output_tokens"`，或 `stop_reason="max_tokens"` 且 `is_error=true` | `回答被截断：…` | `/model` 换输出上限更大的模型，或把任务拆小。BYOK 模型的思考 token 与正文共用额度时容易触发 |
| `auth` | `error_code="authentication_failed"` | `Qoder 凭据已失效：…` | 本机执行 `qodercli login`；微信侧无入口 |
| `unknown` | 以上都未命中 | 一期传输层文案（如 `执行失败：qodercli 异常退出（退出码 1）。详见本机日志。`）。**不参与去重**，每次都发完整提示 | 看日志 `未识别的 qodercli 语义错误` 里的 `errorCode` 与摘要，攒够样本再补规则 |

传输层类别 `errorKind` 保持一期不变：`timeout` / `spawn` / `empty` / `parse` / `exit` / `is_error`。这四类里没有语义字段，`errorClass` 恒为 `unknown`，文案与 0.2.0 逐字一致。

**两种"额度"不要混：**

| 名称 | 含义 | 在哪看 |
|---|---|---|
| `model_quota`（模型额度） | qodercli 侧模型调用额度耗尽，`error_code=110` | `status` 的「最近失败」行、日志 `errorClass` |
| `quota`（下行额度） | 微信侧 `ret=-2`，一次入站约 10 条下行的额度 | `status` 的「下行额度」行、日志 `category=quota` |

两者毫无关系，代码与文案里也刻意不共用名字。qodercli 上游枚举里还有 `billing_error` / `rate_limit` / `invalid_request` / `server_error`，目前**零实测样本**，一律落 `unknown` 并写告警日志，不做猜测性归类。

## 6. 观察与验收

```bash
# 实时看日志
tail -f ~/.local/state/qoder-wechat-bridge/logs/bridge-$(date +%F).jsonl
```

验收标准（0.2.0）：

1. 微信发一条文本，10 秒内日志出现「收到授权消息」；
2. 若任务较长，微信侧可见「正在输入」；
3. 结果在 ≤9 条消息内回传，单条 ≤2000 字；超出进入 outbox，下一次入站优先补发；
4. 第二条消息能延续上下文（`state.json` 中同一 `sessionId`）；
5. `/status` 与 `qoder-wechat status` 能看到 outbox、隔离区和额度状态；
6. qodercli 崩溃时只收到一条 ≤300 字短错误，诊断文件 ≤64KB；
7. launchd 托管下 `stop` 打印 bootout 命令并返回 2。

0.2.0 真机验收（2026-11-03）：

- 正常收发：1 条 18 字回复，队列 0；
- 坏 qodercli：`errorKind=spawn`，单条 80 字错误，诊断 150B；
- outbox：606 字回复只发 1 段，10 条入队；重启后仍为 10 条；下一轮先补 9 条，剩 2 条；再发一条后归零；
- stop：launchd 下打印 bootout 并返回 2；手动实例 603ms / 604ms 退出并返回 0；
- 验收中发现并修复：`stop` 曾把包含 `node dist/cli.js run` 的 shell 包装命令误当成第二实例；已改为按 argv 首段匹配并加回归用例。

验收标准（0.3.0）——自动化部分已通过（304 tests，Lines 97.77%），**真机部分待执行，结果未填**：

1. 用 `/model` 切到输出上限较小的 BYOK 模型，发一个长任务复现截断：应收到「回答被截断：…」而不是「异常退出（退出码 1）」；
2. 额度耗尽时段连发 3 条消息：第 1 条收到完整提示，第 2、3 条收到 `（…同 HH:MM 那条，本次为第 N 次，已略）` 且 N 递增；
3. `qoder-wechat status` 的「最近失败」行显示类别、`error_code`、时间、任务 id，且与「下行额度」行分成两行、字面可区分；
4. 当日诊断文件头部含 `# errorClass:` 与 `# errorCode:` 两行，`## stdout` / `## stderr` 未被挤掉；
5. 重启服务后再触发一次同类失败：应重新收到完整提示（去重窗口在内存，重启即重置，属预期）；
6. 上述全过程 `status` 的待补发与隔离区计数始终为 0（错误提示不入队）；
7. 一期 7 条验收标准全部回归通过。

0.4.0 实例互斥与本轮加固的自动化验收记录见 `.specs/20261110_桥接运维加固/verification.md`（385 tests，Lines 98.46%）；真机 V1 已在 launchd 实例在跑时验证，V2 未停服。

## 7. 安全

- 当前配置为 `ownerUserId` 单人授权 + `bypass_permissions`，等于"你本人可远程指挥本机"。
- 不要把 `config.json` 提交到仓库或分享；token 权限 600。
- 长期不用请停止进程并在微信侧解绑。
