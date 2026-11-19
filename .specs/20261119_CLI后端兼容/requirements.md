# 需求文档：CLI 后端兼容（qodercli / qoderclicn 可配置切换）

## 简介

桥接底层目前适配国际版 `qodercli`。主人已把桌面数据迁移到 Qoder CN，希望同一套桥接能在 `qodercli` 与 `qoderclicn` 之间切换，且**只改一个配置项**。

切换二进制的能力其实已经存在：`qoderBin` 是配置项（`config.json` / `QWB_QODER_BIN` / `--qoder-bin`），预检、任务调用、会话与模型命令全部走它。真正的问题是切到 CN 后**三处隐性耦合会静默失效**：

1. 记忆开关：桥接设 `QODER_MEMORY_HEADLESS=1`，CN CLI 实际读 `QODERCN_MEMORY_HEADLESS`（包内 `yo()` 前缀函数实测），长期记忆静默关闭；
2. 自定义模型目录：`models.ts` 默认读 `~/.qoder/settings.json`，CN 的用户配置目录是 `~/.qoder-cn`，`/model` 会列出 CN 用不了的国际版自定义模型、且列不出 CN 自己的；
3. 环境清理：`cleanEnv` 只剥 `QODER_*`，CN 另有 `QODERCN_*` 系列变量，从 CN 桌面 shell 启动时可能漏剥。

此外会话指针跨后端不可续接（国际版会话 id 在 CN 存储里不存在），现有降级重试虽能自愈，但每个用户切换后第一条消息白付一次失败的 CLI 往返。

本期新增**后端画像推导**（由 `qoderBin` 名推导记忆开关 env 名与用户配置目录）与**会话 bin 标签**（跨后端直接新建会话），补齐上述缺口。不新增配置项，`qoderBin` 就是唯一切换开关。

## 术语表

- **后端（backend）**：桥接调用的 Qoder CLI，二选一：`qodercli`（国际版）或 `qoderclicn`（CN 版）。
- **后端画像（backendProfile）**：由 `qoderBin` 推导出的后端差异集合：记忆开关 env 名（`QODER_MEMORY_HEADLESS` / `QODERCN_MEMORY_HEADLESS`）与用户配置目录名（`.qoder` / `.qoder-cn`）。
- **记忆开关**：headless 调用时启用 Qoder 长期记忆的环境变量，由 `config.memoryEnabled` 控制是否设置。
- **会话指针**：`state.sessions[userId]` 记录（`{sessionId, updatedAt, turns}`），下一条普通消息用 `-r` 续接它。
- **bin 标签**：本期给会话指针新增的 `bin` 字段，记录创建该会话时使用的后端 bin，用于跨后端切换时判定指针是否可续接。
- **用户配置目录**：CLI 存放 `settings.json`（含自定义 provider 模型）的目录，国际版 `~/.qoder`、CN 版 `~/.qoder-cn`。覆盖变量**按后端不同**：国际版认 `QODER_CONFIG_DIR`，CN 认 `QODERCN_CONFIG_DIR`（2026-11-19 真机对照实测修正，原"两版通用 QODER_CONFIG_DIR"结论有误）。

## 背景

### 现有实现

| 位置 | 现状 | 与本需求的关系 |
| --- | --- | --- |
| `src/config.ts:173` | `qoderBin` 默认 `'qodercli'`，`QWB_QODER_BIN` 覆盖 | 唯一切换开关，本期不加新配置项 |
| `src/cli.ts:127` | `--qoder-bin` 旗标写入 `qoderBin` | 同上 |
| `src/bridge/qoder.ts:97` | `cleanEnv` 剥 `QODER_*` / `CLAUDECODE` / `CLAUDE_CODE_*`，memory=true 时设 `QODER_MEMORY_HEADLESS=1` | 改为按后端设开关、两前缀都剥 |
| `src/models.ts:24` | `qoderConfigDir()` = `QODER_CONFIG_DIR ?? ~/.qoder` | 默认目录改为按后端推导 |
| `src/bridge/service.ts:605` | 续接失败且 errorDetail 匹配 `/session\|resume\|not found/i` 时降级新建重试 | bin 标签让跨后端切换不再走这条失败路径 |
| `src/bridge/service.ts:633` | 任务成功后写会话指针 `{sessionId, updatedAt, turns}` | 写入时带 bin 标签 |
| `src/bridge/preflight.ts:150` | 预检按 `config.qoderBin` 解析与 `--version` | 已 bin 驱动，无需改动 |
| `src/bridge/commands/status.ts:12` | `/status` 展示工作目录/模型/会话/轮次等 | 增加当前后端 bin 展示 |

### CN CLI 实测证据（2026-11-19，`@qodercn-ai/qoderclicn@1.1.92`）

- npm 官方包 `@qodercn-ai/qoderclicn`，bin 为 `qoderclicn`（主程序）与 `qodercn`（dispatcher）。注意 `@qoder-ai/qoderclicn@0.0.1` 疑似抢注包，不采用。
- 包内品牌常量：`BRAND_USER_CONFIG_DIR_NAME=".qoder-cn"`、`BRAND_PROJECT_CONFIG_DIR_NAME=".qoder"`、keychain 前缀 `qoder-cli-cn`。
- env 前缀函数 `yo(A)` 返回 `QODERCN_` + A，故 `ENV_MEMORY_HEADLESS = QODERCN_MEMORY_HEADLESS`；包内**无** `QODER_MEMORY_HEADLESS` 字面量。
- worker/SDK 判定相关 env 仍叫 `QODER_*`（`QODER_AGENT_SDK_ENTRYPOINT`、`QODER_SDK_ACCESS_TOKEN` 等）；`QODERCN_*` 系列用于 VPC 端点、服务账号、客户端类型等。
- **配置目录覆盖变量两版不同（2026-11-19 真机对照修正）**：CN 包内 `MLe=yo("CONFIG_DIR")=QODERCN_CONFIG_DIR` 才是全局配置目录入口，`ZVt=DC("CONFIG_DIR")=QODER_CONFIG_DIR` 仅用于 skill 路径替换等。实测：CN 忽略 `QODER_CONFIG_DIR`（仍列默认自定义模型）、认 `QODERCN_CONFIG_DIR`（切到无登录态副本即报 Not logged in）；intl 相反。原需求/设计"两版通用 QODER_CONFIG_DIR"前提有误，已按方案 A 修通覆盖链路。
- 调用契约与国际版一致：`-p` / `-o json` / `-r` / `-n` / `-w` / `-m` / `--list-sessions` / `--delete-session` / `--list-models` / `--append-system-prompt` / `--permission-mode` / `--attachment` 均在包内；result JSON 键 `session_id` / `modelUsage` / `is_error` / `error_code` / `stop_reason` 均在。
- 本机已全局安装 `qoderclicn` 1.1.92（`/usr/local/bin/qoderclicn`），干净环境下 `--version` 输出 `1.1.92`；空目录 `--list-sessions` 输出 `No previous sessions found for this project.`，与 `sessions.ts` 现有哨兵正则 `/^No previous sessions found/` 匹配。
- **待实测**（执行阶段验收）：CN CLI 登录后的真实任务往返、`QODERCN_MEMORY_HEADLESS` 生效、`--list-models` 输出格式、CN `settings.json` 自定义模型读取。CN CLI 登录为独立凭据，需主人本人授权，不在自动化范围。

## 需求

### 需求 1：后端画像推导（P0）

**用户故事：** 作为运维者，我希望只改 `qoderBin` 一个配置项，桥接就能自动用对后端的记忆开关与配置目录，以便在国际版与 CN 版之间切换。

#### 验收标准

1. WHEN `qoderBin` 的命令名（绝对路径取 basename）为 `qoderclicn` 或 `qodercn` THEN THE 桥接服务 SHALL 判定为 CN 后端：记忆开关 env 名为 `QODERCN_MEMORY_HEADLESS`，用户配置目录默认为 `~/.qoder-cn`。
2. WHEN `qoderBin` 的命令名为 `qodercli` THEN THE 桥接服务 SHALL 判定为国际版后端：记忆开关 env 名为 `QODER_MEMORY_HEADLESS`，用户配置目录默认为 `~/.qoder`（与现状完全一致）。
3. IF `qoderBin` 命令名无法识别为上述任一后端（如自定义 wrapper 名） THEN THE 桥接服务 SHALL 回落为国际版画像，SHALL NOT 报错或拒绝启动；该局限须在 README 写明。
4. IF 当前后端的配置目录覆盖变量已设置（国际版 `QODER_CONFIG_DIR`，CN `QODERCN_CONFIG_DIR`；空串/纯空白视为未设置） THEN THE 模型目录 SHALL 优先使用该值，SHALL NOT 被后端默认目录覆盖，SHALL NOT 读取另一后端的覆盖变量。解析后的目录 SHALL 经 `cleanEnv` 补回 CLI 子进程的对应变量，保证桥接 `/model` 列表与 CLI 实际可用模型一致。
5. THE 后端画像 SHALL 是纯函数（输入 bin 名，输出画像），SHALL NOT 引入运行时探测（不执行 CLI 判断版本）。

### 需求 2：环境清理与记忆开关（P0）

**用户故事：** 作为微信用户，我希望切到 CN 后长期记忆仍然生效，且桥接不会把桌面 shell 的 worker 变量误传给 CLI。

#### 验收标准

1. WHEN `memoryEnabled=true` 且后端为 CN THEN THE `cleanEnv` SHALL 设置 `QODERCN_MEMORY_HEADLESS=1`，SHALL NOT 设置 `QODER_MEMORY_HEADLESS`。
2. WHEN `memoryEnabled=true` 且后端为国际版 THEN THE `cleanEnv` SHALL 设置 `QODER_MEMORY_HEADLESS=1`（与现状一致）。
3. WHEN `memoryEnabled=false` THEN THE `cleanEnv` SHALL NOT 设置任一后端的记忆开关。
4. THE `cleanEnv` SHALL 剥离 `QODER_*` 与 `QODERCN_*` 两个前缀的全部变量，以及既有的 `CLAUDECODE` / `CLAUDE_CODE_*`。
5. THE 环境清理 SHALL 覆盖全部 CLI 调用路径：任务调用（`runQoder`）、会话清单/重命名/删除（`sessions.ts`）、模型清单（`models.ts`），SHALL NOT 遗漏某条路径仍用旧前缀逻辑。

### 需求 3：模型目录按后端（P0）

**用户故事：** 作为微信用户，我希望 `/model` 列出的自定义模型是当前后端真正能用的，以便切换模型不报错。

#### 验收标准

1. WHEN 后端为 CN THEN THE `/model` 的自定义模型 SHALL 读 `~/.qoder-cn/settings.json`（或 CN 覆盖变量 `QODERCN_CONFIG_DIR` 值）的 `providers`。
2. WHEN 后端为国际版 THEN THE 自定义模型 SHALL 读 `~/.qoder/settings.json`（与现状一致）。
3. THE 内置模型 SHALL 仍通过当前 `qoderBin --list-models` 获取，SHALL NOT 混入另一后端的内置模型。
4. THE 模型目录缓存 SHALL 按 bin 隔离（现有 `cache.bin` 键已满足），切换后端后 SHALL NOT 命中旧后端的缓存。
5. IF 对应目录的 `settings.json` 缺失或损坏 THEN THE 自定义模型 SHALL 降级为空列表（沿用现有降级行为），SHALL NOT 报错中断 `/model`。

### 需求 4：会话 bin 标签与跨后端切换（P0）

**用户故事：** 作为微信用户，我希望切换后端后第一条消息直接开新会话，不白付一次失败的续接往返。

#### 验收标准

1. THE 会话指针 SHALL 新增 `bin` 字段，记录创建/续接该会话时使用的 `config.qoderBin`；任务成功写入指针时 SHALL 带上该字段。
2. IF 会话指针的 `bin` 与当前 `config.qoderBin` 不一致 THEN THE 桥接服务 SHALL 视该用户为无活动会话：下一条普通消息新建会话（不带 `-r`），SHALL NOT 尝试续接旧 id。
3. IF 存量会话指针无 `bin` 字段（旧版 state.json） THEN THE 桥接服务 SHALL 视其 `bin` 为 `qodercli`：当前后端是 `qodercli` 时正常续接（存量行为不破坏），是 CN 时按 4.2 新建。
4. WHEN 跨后端新建会话 THEN THE 新指针的 `turns` SHALL 从 1 起计，SHALL NOT 累加旧后端的轮次。
5. WHEN 跨后端新建会话成功 THEN THE 旧指针 SHALL 被新指针覆盖；SHALL NOT 保留旧后端会话 id 供切回时续接（双向保留为非目标）。
6. THE `/sessions`、`/switch`、`/new`、`/rename`、`/delete`、`/reset` 命令 SHALL 在当前后端下照常工作；`/switch` 切到的目标会话属于当前后端清单，写入指针时 SHALL 带当前 bin 标签。
7. THE bin 标签判定 SHALL NOT 影响同后端内的正常续接：`bin` 一致时行为与现状完全一致。

### 需求 5：用户文案中性化（P1）

**用户故事：** 作为微信用户，我希望错误提示不再写死"qodercli"，以便用 CN 时提示不误导。

#### 验收标准

1. THE `failure.ts` 与 `sessions.ts` 中用户可见文案里写死的 `qodercli` SHALL 改为中性称呼（如"Qoder CLI"），SHALL NOT 改变错误归类、截断与去重口径。
2. THE 日志与诊断文件 SHALL 可保留具体 bin 名/命令原文（排查需要），不受文案中性化影响。
3. THE 预检失败提示 SHALL 仍包含实际配置的 bin 名（现有 `qoder_missing` detail 已含 `input.qoderBin`，保持不变）。

### 需求 6：切换可观测性（P1）

**用户故事：** 作为运维者，我希望在手机上能确认桥接当前用的是哪个后端，以便验证切换生效。

#### 验收标准

1. THE `/status` SHALL 增加一行展示当前 `config.qoderBin`（如"后端：qoderclicn"）。
2. THE 启动日志 SHALL 记录当前后端 bin 与推导出的画像（记忆开关 env 名、配置目录），便于排查切换问题。
3. THE `/status` 新增行 SHALL 计入现有下行额度口径，SHALL NOT 显著增加回复长度。

## 成功标准

- `qoderBin` 改为 `qoderclicn`（配置/环境变量/旗标任一途径）后：普通消息正常往返；`memoryEnabled=true` 时设的是 `QODERCN_MEMORY_HEADLESS`；`/model` 列出 CN 的自定义模型；切换后第一条消息直接新建会话，不产生失败续接往返。
- 切回 `qodercli` 后行为与现状完全一致；存量 state.json（无 bin 字段）在国际版下续接不受影响。
- `/status` 能看到当前后端；用户可见错误文案不再写死 qodercli。
- 现有全部命令与普通消息黄金路径行为不变；全部测试通过，`coverage.include` 内源文件 Lines ≥ 95%，新增核心逻辑文件纳入 `coverage.include`。

## 与既有文档的关系

- 上游：无（v2-backlog 未登记此条，属新需求）。
- 同目录：`design.md`（待需求批准后产出）、`tasks.md` + `task-list/`（执行拆分）。
- 关联包：`.specs/20261114_微信会话管理/`（会话指针与命令注册表，本期给指针加 bin 标签）、`.specs/20261106_错误可读性/`（failure/error-class 口径，本期只改文案不改归类）。
- 调研依据：2026-11-19 CN 包 1.1.92 本机取证（品牌常量、env 前缀函数、契约字符串、空清单哨兵实测）。

## 非功能性需求

### N1 兼容性

THE 国际版后端（`qoderBin=qodercli`）下的全部现有行为 SHALL 保持不变：普通消息收发、排队、会话续接、全部命令、notify、send-file。存量 state.json 无需迁移即可继续使用。

### N2 依赖与平台

THE 实现 SHALL NOT 引入新的运行时依赖；后端画像为纯函数，环境清理复用 `cleanEnv`，CLI 调用复用既有 `cross-spawn` 路径。

### N3 安全与隐私

THE 文案与日志 SHALL NOT 包含 bot token / context_token；后端画像只涉及 env 名与目录名，不读取凭据内容。CN CLI 登录凭据由 CLI 自身管理（keychain 前缀 `qoder-cli-cn`），桥接不触碰。

### N4 可观测性

THE 后端切换的关键路径（画像推导结果、跨后端新建会话） SHALL 有 info/warn 级日志，口径对齐现有 diagnostics。

## 非目标

- **自动探测 / 故障转移**：不做"检测哪个 CLI 可用就自动用哪个"或失败自动切另一后端；切换是显式配置行为。
- **同时跑双后端**：不做按微信用户路由到不同后端；同一桥接进程同一时刻只有一个后端。
- **跨后端会话迁移**：不把国际版会话内容导入 CN，也不反向导入；旧会话仍可在切回国际版后经 `/sessions` 找回（CLI 侧存储未动），但桥接指针不保留旧 id。
- **双向指针保留**：切换后旧指针被覆盖，切回需重新开会话（主人已确认此语义）。
- **CN CLI 登录自动化**：登录/授权是主人本人的真人步骤，桥接不代做。
- **新增配置项**：不加 `qoderBackend` / `qoderFlavor` 之类字段，`qoderBin` 是唯一开关。
- **wrapper / 改名二进制的精确识别**：无法识别的 bin 名回落国际版画像（需求 1.3），不做运行时版本探测。

## 开放风险（设计/执行阶段须验证）

- **R1 CN 真实往返待实测**：CN CLI 尚未登录，任务往返、记忆开关生效、`--list-models` 格式、CN 自定义模型读取均须登录后实测验收；静态证据（同代码base、契约字符串齐全）支持"一致"预期，但不替代实测。
- **R2 bin 名推导局限**：主人若用自定义 wrapper 名或软链改名，画像回落国际版，CN 记忆开关会设错。README 须写明"bin 名须为 qodercli / qoderclicn / qodercn 之一，或用绝对路径指向它们"。
- **R3 CN 错误文案匹配**：现有续接降级正则匹配英文 errorDetail；bin 标签方案下跨后端不再依赖该路径，但同后端内的降级语义须保持（CN 同代码base，预期一致，执行阶段抽查）。