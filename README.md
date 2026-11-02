# @jcyao/qoder-wechat-bridge

把**个人微信单聊**接到**本机 Qoder**：在手机上发一句话，电脑上的 Qoder 干活，结果自动回到微信。

适合"人不在电脑前，但想让电脑上的 Qoder 继续干活"的场景。

> 当前版本 `0.1.1`：单聊文本、主动提醒、双向图片/文件/视频、语音接收（平台转写）与语音发送（macOS 原型）。

---

## 它能帮你做什么

装了它之后，你可以在微信里给机器人发这些话：

| 你想做的事 | 在微信里发 |
|---|---|
| 改代码 | `把 my-app 的登录接口加上参数校验，改完跑一遍测试` |
| 看项目状态 | `看一下当前目录 git 状态，有哪些没提交的改动` |
| 整理文件 | `把桌面上这周下载的截图按日期归档到 Pictures/Screenshots` |
| 写文档 | `根据 README 写一份给新同事的上手说明，存成 docs/onboarding.md` |

执行过程在你电脑上的 Qoder 里完成，结果会分条发回微信。

**它不适合做什么**：群聊（官方通道不支持）、实时聊天（一个任务要跑一会儿）、替你保管密码或密钥。

---

## 开始前，你需要准备

按顺序确认这四样，缺一不可。

### 1. 一台会开着的电脑

桥接服务跑在这台电脑上。电脑关机、休眠或退出程序，微信里就没人干活了。

### 2. Node.js 20 或更高版本

打开终端（Mac 上是「终端」App），输入：

```bash
node -v
```

看到 `v20.x.x` 或更高就行。低于 20（比如 `v16`）需要先升级，推荐去 [nodejs.org](https://nodejs.org) 下载 LTS 版本，或用版本管理工具：

```bash
n 22                # 如果你用 n
fnm install 22 && fnm use 22   # 如果你用 fnm
```

### 3. Qoder CLI，并且已经登录

Qoder CLI 是 Qoder 的命令行版本，本工具靠它执行任务。先确认：

```bash
qodercli --version
```

能输出版本号后，再登录一次：

```bash
qodercli login
```

它会打印一个链接，在浏览器里打开并授权即可。之后验证：

```bash
qodercli -p "只回复两个字：收到"
```

看到 `收到` 就说明登录成功。

> 注意：Qoder CLI 的会话和 Qoder 桌面版的会话是**两套**。本工具执行的任务在 CLI 侧，桌面版历史里看不到。

### 4. 一个微信号

建议先用**小号**试。绑定后这个号会长期被机器人接管，反复扫码、发送太频繁都可能触发微信风控。微信版本需要 ≥ 8.0.69。

---

## 三步装好

### 第一步：安装

```bash
npm i -g @jcyao/qoder-wechat-bridge
qoder-wechat --version      # 验证安装
```

> 不想全局安装，也可以每次用 `npx @jcyao/qoder-wechat-bridge <命令>`。

### 第二步：扫码登录微信

```bash
qoder-wechat login
```

终端里会出现二维码（macOS 上还会自动用预览打开二维码图片）。用手机微信扫码，按手机提示确认。

成功后你会看到：

```
登录成功，token 已保存
```

此时配置写到了 `~/.config/qoder-wechat-bridge/config.json`，里面记录了机器人身份和**唯一允许指挥它的人**（就是扫码的这个微信号）。

### 第三步：启动服务

```bash
qoder-wechat run
```

看到这两行就说明起来了：

```
桥接服务启动
服务已启动
```

**这个终端窗口要一直开着。** 关掉窗口、按 `Ctrl+C`、或者电脑关机，服务就停了。

服务挂在后台、或你找不到那个终端窗口时，用 `qoder-wechat stop` 停：它会给运行中的实例发停止信号，**正在执行的 Qoder 任务会一并取消**，不会留下继续干活的孤儿进程。服务由 launchd 之类的监督器托管时，`stop` 不会发信号（发完会被重新拉起），只打印需要执行的那条 `launchctl bootout` 命令。

> 想固定某个项目目录时：`qoder-wechat run --cwd ~/projects/my-app`。不加就是全局模式，在你自己的用户目录下工作。

---

## 在微信里怎么用

1. 打开微信，找到扫码后出现的「微信助手」会话（找不到就在微信里搜索"助手"，或重启一次微信）。
2. 直接发一句话，比如：`列出当前目录下最近修改的三个文件`。
3. 你会看到"正在输入"提示；任务完成后，结果会分条发回来。

**发附件**：图片、文件、视频可以直接发给机器人，桥接会下载并解密，通过 `--attachment` 交给 Qoder（图片能直接识别内容）。多个附件、图文混发都支持，单文件上限 20MB。附件缓存在 `inboxDir`（默认 `~/.local/state/qoder-wechat-bridge/inbox/`），7 天后启动时自动清理。语音依赖微信平台的转写：有转写就按文字处理，没有转写会直接提示重发，不会启动任务。

附件目录可以自己指定，也可以随时清理：

```bash
qoder-wechat run --inbox-dir ~/Pictures/qwb-inbox   # 换目录（也可写进配置 QWB_INBOX_DIR）
qoder-wechat status                                  # 查看目录占用
qoder-wechat clean                                   # 删除 7 天前的附件
qoder-wechat clean --days 1                          # 只保留最近 1 天
qoder-wechat clean --all                             # 全部删除
```

### 内置命令

不确定能发什么时，先发 `/help`：

| 命令 | 作用 |
|---|---|
| `/help` | 看全部命令 |
| `/status` | 看当前工作目录、模型、会话、待补发条数 |
| `/model` | 看有哪些模型、当前用哪个 |
| `/model 3` | 按序号切换模型（下一条任务生效） |
| `/model [my-provider] glm-5.3` | 按名称切换模型 |
| `/model default` | 恢复默认模型（Auto） |
| `/reset` | 清空当前对话上下文，重新开始 |
| `/stop` | 强制停止当前正在执行的任务（`/cancel` 同义） |

其余任何内容都会当成任务交给 Qoder。

> 只有扫码登录的那个微信号能指挥它，其他人发消息会被忽略。

---

## 关掉之后怎么再开

目前没有做开机自启，所以每次重新使用前：

```bash
qoder-wechat run
```

**电脑重启、终端关闭、Ctrl+C 之后，都需要再执行一次。** 登录状态是保存的，不用重新扫码。

Windows 下同样用 `qoder-wechat run`，或双击仓库里的 `启动桥接.cmd`；停止用 `Ctrl+C` 或 `qoder-wechat stop`。Windows 上 `stop` 是直接结束进程（没有 POSIX 信号那套优雅关闭），正在跑的任务子进程可能残留——这条路径尚未在 Windows 真机验证。

登录过期（日志里出现 `-14`）时，重新扫码即可：

```bash
qoder-wechat login
```

### 想换一个微信号绑定

```bash
# 1. 先停掉旧服务：Ctrl+C，或另开终端执行
qoder-wechat stop

# 2. 用新号扫码
qoder-wechat login

# 3. 重新启动
qoder-wechat run
```

如果换号后日志里一直报 `getupdates 返回错误`，删掉本地状态再启动：

```bash
rm ~/.local/state/qoder-wechat-bridge/state.json
```

---

## 常见问题

**发了消息没反应？**

```bash
pgrep -fl "dist/cli.js run"                                      # 服务还在吗
tail -20 ~/.local/state/qoder-wechat-bridge/logs/bridge-$(date +%F).jsonl   # 最近日志
qoder-wechat status                                              # 登录状态
```

**回复"执行失败：Not logged in"？** Qoder CLI 没登录，执行 `qodercli login`。

**报 `sdk_worker_removed`？** 你是在 Qoder 桌面版的终端里启动的，继承了它的环境变量。本工具会自动剥离；如果仍出现，换用系统「终端」App 启动。

**报 `SyntaxError: Invalid regular expression flags`？** Node 版本太低，`node -v` 确认 ≥ 20。

**任务跑了但微信没收到？** 官方通道有额度限制：一次入站大约只能回 10 条消息，`context_token` 约 24 小时过期。超出部分会进入补发队列，下次你发消息时自动补发。日志里的 `ret=-2` 就是这种情况。

**结果太长会怎样？** 按每条 2000 字切分，最多发 9 条；剩下的进补发队列。

**能拉进群吗？** 不能。官方个人微信通道只开放单聊。

**会被封号吗？** 有风险。个人微信号被机器人接管不属于常规用法，建议先用小号验证，不要高频扫码或高频发送。

---

## 命令速查

```bash
qoder-wechat login                 # 扫码登录 / 换号
qoder-wechat run                   # 启动服务（前台）
qoder-wechat run --cwd ~/project   # 指定工作目录
qoder-wechat stop                  # 停止服务（会取消进行中的任务；launchd 托管时只打印命令）
qoder-wechat notify "内容"          # 主动推一条提醒（窗口不可用时自动排队）
qoder-wechat send-file shot.png    # 发图片/文件/视频（可选 --text "文案"）
qoder-wechat send-voice "构建完成了"  # [实验性] 本机 TTS 语音（客户端可能不显示）
qoder-wechat status                # 查看配置与会话
qoder-wechat help                  # 帮助
```

### 发送语音（实验性，暂不可用）

```bash
qoder-wechat send-voice "构建完成，有三个测试失败，需要你确认"
```

链路本身能跑通（`say → afconvert → silk-wasm → CDN`，服务端也返回 `messageId`），但实测把 `encode_type`、`sample_rate`、`bits_per_sample` 都对齐平台入站语音后，**微信客户端仍不渲染这条语音**。判断是这条官方机器人通道目前只支持入站语音、不支持出站语音。命令保留用于以后复测，不建议在实际流程中使用；需要发音频时请用 `send-file` 发音频文件。

### 发送图片 / 文件

```bash
qoder-wechat send-file ~/Desktop/report.pdf --text "报告生成好了"
qoder-wechat send-file ~/Desktop/chart.png
```

图片（png/jpg/gif/webp）会直接显示在聊天里，其它文件作为附件发送，mp4/mov 作为视频。单文件上限 10MB；文案和媒体会各占一条下行额度。需要最近一次入站留下的窗口，没有窗口时会直接报错——先给机器人发一句话再发文件。

### 主动提醒（notify）

任务执行到一半需要你做决定、或者有事情要通知你时，可以主动推一条消息：

```bash
qoder-wechat notify "构建完成，有 3 个测试失败，需要你确认是否继续"
```

它走的是同一条微信通道，所以受同样的窗口限制：

- 你最近给机器人发过消息（约 24 小时内）→ 直接推送；
- 没有可用窗口或额度用完 → 自动写入本地队列，**等你下次给机器人发消息时补发**；
- 只允许发给授权账号，其他人推不了。

> 如果任务是你从微信里派出去的，推送最可靠；如果任务是从 Qoder 桌面/CLI 发起的，而你一整天没给机器人发过消息，提醒可能要等你下次开口才能送达。需要"随时必达"的告警，建议用钉钉/企业微信 webhook。

> 不想自己敲命令？安装配套的 Qoder 插件后，在 Qoder 里运行 `/qoder-wechat:setup`，由 Agent 完成环境检查、安装和启动，你只需要扫码。

---

## 进阶：配置与编程调用

配置文件在 `~/.config/qoder-wechat-bridge/config.json`（权限 600），运行状态在 `~/.local/state/qoder-wechat-bridge/`。

优先级：**命令行参数 > 环境变量 > 配置文件 > 默认值**。

| 字段 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `cwd` | `QWB_CWD` | 空（全局） | 工作目录；留空表示不限定 |
| `permissionMode` | `QWB_PERMISSION_MODE` | `dont_ask` | `default` / `accept_edits` / `dont_ask` / `bypass_permissions` / `auto` |
| `qoderBin` | `QWB_QODER_BIN` | `qodercli` | CLI 路径 |
| `qoderModel` | `QWB_MODEL` | 空 | 默认模型 |
| `memoryEnabled` | `QWB_MEMORY` | `true` | 是否加载 Qoder 长期记忆（`QODER_MEMORY_HEADLESS`） |
| `personaFile` | `QWB_PERSONA_FILE` | `~/.config/qoder-wechat-bridge/persona.md` | 人设文件；存在时作为 `--append-system-prompt` |
| `inboxDir` | `QWB_INBOX_DIR` | `~/.local/state/qoder-wechat-bridge/inbox` | 入站附件目录，可指向磁盘更宽裕的位置 |
| `ownerUserId` | `QWB_OWNER_ID` | 登录时写入 | 唯一授权发送者 |
| `allowFrom` | `QWB_ALLOW_FROM` | `[]` | 额外白名单，逗号分隔 |
| `allowFirstSender` | `QWB_ALLOW_FIRST_SENDER` | `false` | 未设置授权人时是否信任首个发送者 |
| `qoderTimeoutMs` | `QWB_TIMEOUT_MS` | `600000` | 单任务超时 |
| `maxReplyChars` | `QWB_MAX_REPLY_CHARS` | `2000` | 单条消息最大字符数 |
| `maxRepliesPerTurn` | `QWB_MAX_REPLIES` | `9` | 单轮最多下行条数 |

模型切换细节：内置模型直接写名字（如 `GLM-5.3`）；自定义 provider 的模型必须写成 `<providerId>/<model>`，否则 Qoder 会静默回落到 `auto`。`/model` 命令已处理这层映射。

**记忆**：开启 `memoryEnabled` 后，headless 会话会读取 Qoder 的长期记忆（`~/.qoder/memory/MEMORY.md` 与当前工作目录对应的项目记忆），你在桌面端积累的偏好、项目背景会带进微信任务里。实现上只是给 `qodercli` 补回 `QODER_MEMORY_HEADLESS=1`——桥接为了避免 `sdk_worker_removed` 会剥离所有 `QODER_*`，唯独这个开关需要保留。关闭用 `QWB_MEMORY=0`。

**人设（persona）**：把人设写进 `~/.config/qoder-wechat-bridge/persona.md`，每条任务会读取它并作为 `--append-system-prompt` 追加到 Qoder 默认提示后——工具、skill、记忆的说明都保留，只增加你的风格约束。改完保存，下一条微信消息就生效，不用重启。文件上限 8KB。

```markdown
你是「阿程」，一个通过微信远程协助的工程助手。
- 回答简洁，先给结论，再给必要细节
- 不确定就直说不确定，不要编造
- 涉及删除、覆盖、推送等操作，先确认再执行
```

配置里也能改路径：`personaFile` 或 `QWB_PERSONA_FILE`。文件不存在时等于没设人设，不影响任何行为。

作为库调用：

```ts
import { runService, runQoder } from '@jcyao/qoder-wechat-bridge';

const handle = await runService({ cwd: '/path/to/project', permissionMode: 'dont_ask' });
// ...
handle.stop();

const result = await runQoder({
  prompt: '列出最近修改的三个文件',
  cwd: '/path/to/project',
  timeoutMs: 300_000,
  bin: 'qodercli',
  permissionMode: 'dont_ask',
});
console.log(result.ok, result.text);
```

---

## 安全提示

- **授权**：默认只响应扫码登录的那个微信号，其他人发的消息会被忽略。
- **权限**：`bypass_permissions` 会让微信里的指令直接读写文件、执行命令，等于把电脑执行权交出去。默认值 `dont_ask` 更安全；用 `bypass_permissions` 时务必确认只有你能给机器人发消息。
- **Token**：配置文件里存着微信令牌，权限 600，不要提交到仓库或发到聊天里。
- **合规**：请遵守微信软件许可协议与相关法律法规。

---

## 已知限制

- 仅单聊；官方通道 `groupPolicy: "disabled"`，不支持群聊。
- 一次入站大约只有 **10 条下行额度**，`context_token` 约 **24 小时**时效（社区实测，官方未公布数值）。
- `ret=0` 只代表接口受理，不保证送达；风控可能静默过滤。
- Windows 可用：收发、附件、通知等与 macOS 一致；登录二维码需手动打开 `~/.local/state/qoder-wechat-bridge/wechat-qr.png`。
- 出站语音为实验性：协议字段已对齐，但微信客户端不渲染；发音频请用 `send-file`。
- 任务在 CLI 侧执行，Qoder 桌面版历史里看不到。
- v0.1 没有开机自启，重启后需要手动 `run`。

## Roadmap

- `0.3`：双向决策（`ask`：发问题后等待微信回复再继续）、开机自启（LaunchAgent / systemd）
- `0.4`：图片与文件、进度提示、多会话与按项目路由
- `0.5`：`init` / `init --rebind` / `logout` 等账号管理命令

## License

MIT
