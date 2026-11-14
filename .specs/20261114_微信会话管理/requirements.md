# 需求文档：微信会话管理（A 期·核心切换组）

## 简介

桥接目前每个微信用户只维护**一个活动会话**（`state.json` 的 `sessions[userId]`），管理命令只有 `/reset`（断开映射、下条消息开新会话）和 `/status`（看会话 id）。多个话题只能串在同一条会话里，上下文互相污染；想回到之前某个话题，没有任何入口。

会话本身生在 Qoder CLI 侧（`~/.qoder/projects/<工作目录slug>/<session>.jsonl`），桌面端 GUI 不索引 CLI 会话（2026-11-14 复验：官方 Data import 来源不含 CLI，`~/.qoder/tasks/` 只是会话内待办存储）。因此本期**就在 CLI 侧管会话**：把 CLI 1.1.89 已具备的会话能力（`--list-sessions` / `-r` / `--session-id` / `-n`）包装成微信内置命令，让用户在手机上就能列出、切换、新建、重命名会话。

本期只做**核心切换组**四个命令：`/sessions`、`/switch`、`/new`、`/rename`。B 方案（本地管理台）按用户决定**待定，本期不实现**。

## 术语表

- **工作目录**：桥接调用 qodercli 时的 cwd，取 `config.cwd`（`QWB_CWD`），为空时为主目录（全局会话）。见 `src/bridge/service.ts:802` 的 `workdir()`。
- **会话目录清单（catalog）**：某工作目录下全部 CLI 会话的列表，由 `qodercli --list-sessions` 在该工作目录下产出，含序号、显示名、最近活跃时间、会话 id。会话按工作目录隔离。
- **活动会话**：`state.sessions[userId].sessionId` 指向的会话，下一条普通消息用 `-r` 续接它。
- **会话指针**：`state.sessions[userId]` 这条记录本身（`{sessionId, updatedAt, turns}`）。切换会话 = 改指针，**不改动任何会话内容**。
- **显示名**：会话的可读名称。CLI 默认用首句 prompt 作显示名；`-n` 可在创建时指定。
- **变更类命令**：会改写会话指针或会话元数据的命令（`/switch`、`/new`、`/rename`）。`/sessions` 是只读命令。
- **下行额度**：iLink 单条入站约 10 条下行额度，命令回复也计入。

## 背景

### 现有实现

| 位置 | 现状 | 与本需求的关系 |
| --- | --- | --- |
| `src/bridge/service.ts:505` | `/reset` 直接 `delete state.sessions[userId]` | `/new` 在此基础上支持可选命名 |
| `src/bridge/service.ts:515` | `/status` 显示当前 sessionId | 复用其工作目录/会话展示口径 |
| `src/bridge/service.ts:654` | 任务成功后写 `state.sessions[userId] = {sessionId, updatedAt, turns}` | 切换/新建只改这条指针 |
| `src/bridge/service.ts:802` | `workdir() = config.cwd.trim() \|\| os.homedir()` | `/sessions` 必须在此目录下列会话 |
| `src/bridge/qoder.ts:194` | 有 sessionId 时 `args.push('-r', sessionId)` | 切换后下条消息自动续接目标会话 |
| `src/commands.ts:18` | `COMMANDS` 登记表，`/help` 单一事实来源 | 新命令在此登记 |
| `src/commands.ts:45` | `isUnknownCommand` 只认已登记命令 | 新命令登记后自然被识别 |

### CLI 已具备的能力（1.1.89 实测 + 官方文档）

- `--list-sessions`：按当前工作目录列会话（序号 / 显示名 / 时间 / id），**文本输出，无 `-o json` 选项**。
- `-r <id>`：续接指定会话；`--session-id <id>`：预分配会话 id；`-n <name>`：设置显示名。
- 会话存储：`~/.qoder/projects/<slug>/<session>.jsonl` + 旁挂 `<session>/state.json`。
- **CLI 无独立 `--rename-session` 旗标**（见开放风险 R1）。

## 需求

### 需求 1：会话列表 `/sessions`（P0）

**用户故事：** 作为微信用户，我希望列出当前工作目录下的会话并看清哪个是活动会话，以便决定切换到哪条。

#### 验收标准

1. WHEN 用户发送 `/sessions` THEN THE 桥接服务 SHALL 在桥接工作目录（`workdir()`）下调用 `qodercli --list-sessions`，返回会话清单，每条含序号、显示名、最近活跃时间与会话 id（可截断显示）。
2. WHEN 渲染清单 THEN THE 桥接服务 SHALL 明确标记当前活动会话（例如 `← 当前`），使用户一眼区分。
3. IF 清单为空（该工作目录尚无会话） THEN THE 桥接服务 SHALL 返回友好提示（如"当前还没有会话，发条消息即可创建"），SHALL NOT 报错或返回空文本。
4. IF 清单条数超过上限 N（默认 10，可配置） THEN THE 桥接服务 SHALL 只展示最近 N 条并提示"仅显示最近 N 条"，以控制下行额度。
5. WHEN `/sessions` 执行 THEN THE 桥接服务 SHALL NOT 改变活动会话指针，SHALL NOT 修改任何会话内容（只读）。
6. IF `qodercli --list-sessions` 调用失败（未安装 / 未登录 / 超时 / 输出无法解析） THEN THE 桥接服务 SHALL 返回中文可读错误，SHALL NOT 抛出未捕获异常或中断主循环。
7. IF 桥接工作目录被配置为某项目目录（`config.cwd` 非空） THEN THE 清单 SHALL 只含该目录下的会话；主目录全局会话与项目会话互不混列。

### 需求 2：会话切换 `/switch`（P0）

**用户故事：** 作为微信用户，我希望切换到之前某条会话继续聊，以便不同话题各自保留上下文。

#### 验收标准

1. WHEN 用户发送 `/switch <目标>` THEN THE 桥接服务 SHALL 把活动会话指针改指向目标会话，下一条普通消息用 `-r` 续接该目标。
2. THE `/switch` SHALL 支持三种目标写法：序号（对应最近一次 `/sessions` 清单）、会话 id（完整或可唯一匹配的短 id）、显示名。
3. WHEN 切换成功 THEN THE 桥接服务 SHALL 回复确认（含目标显示名与 id），并更新 `state.sessions[userId]` 的 `sessionId` 与 `updatedAt`。
4. IF 未带参数 THEN THE 桥接服务 SHALL 返回用法提示与当前活动会话，SHALL NOT 改变指针。
5. IF 目标不存在、序号越界、或 id/名称无法唯一匹配 THEN THE 桥接服务 SHALL 返回中文错误并提示用 `/sessions` 查看清单，SHALL NOT 改变指针。
6. IF 目标会话与当前活动会话是同一条 THEN THE 桥接服务 SHALL 提示"已在该会话"，不做无意义写入。
7. WHEN 切换会话 THEN THE 桥接服务 SHALL NOT 删除、截断或修改目标会话与源会话的任何内容（仅改指针）。
8. IF 该用户有正在执行的任务 THEN THE 桥接服务 SHALL 拒绝切换并提示先 `/stop`，SHALL NOT 在任务执行中改写指针（见需求 6）。

### 需求 3：新建会话 `/new`（P0）

**用户故事：** 作为微信用户，我希望主动开一条干净的新会话（可选起名），以便开始一个全新话题。

#### 验收标准

1. WHEN 用户发送 `/new` THEN THE 桥接服务 SHALL 清空当前活动会话指针，下一条普通消息创建新会话（行为与现有 `/reset` 一致）。
2. WHEN 用户发送 `/new <名称>` THEN THE 桥接服务 SHALL 记录该名称为待用显示名，下一条普通消息创建会话时通过 `-n <名称>` 应用。
3. WHEN `/new` 执行 THEN THE 桥接服务 SHALL NOT 立即调用 qodercli 创建会话，SHALL NOT 消耗模型额度（命名在下次真实消息时随创建生效）。
4. IF 未带名称 THEN THE 新会话 SHALL 沿用 CLI 默认命名（首句 prompt），与现有行为一致。
5. WHEN `/new` 成功 THEN THE 桥接服务 SHALL 回复确认；带名称时回显将使用的名称。
6. IF 该用户有正在执行的任务 THEN THE 桥接服务 SHALL 拒绝并提示先 `/stop`（见需求 6）。
7. THE `/new` SHALL NOT 删除旧会话内容，旧会话仍可通过 `/sessions` + `/switch` 找回。

### 需求 4：会话重命名 `/rename`（P1）

**用户故事：** 作为微信用户，我希望给当前会话起个可读的名字，以便在 `/sessions` 清单里容易认出它。

#### 验收标准

1. WHEN 用户发送 `/rename <名称>` 且存在活动会话 THEN THE 桥接服务 SHALL 把该会话的显示名改为指定名称，且 `/sessions` 清单随后展示新名称。
2. IF 不存在活动会话 THEN THE 桥接服务 SHALL 提示"当前没有会话，先发消息创建"，SHALL NOT 报错。
3. IF 未带名称或名称为空 THEN THE 桥接服务 SHALL 返回用法提示，SHALL NOT 改名。
4. IF 名称超过合理长度（默认 60 字符） THEN THE 桥接服务 SHALL 截断或拒绝并提示，SHALL NOT 写入超长名称。
5. IF 重命名能力在当前 CLI 版本无法以 headless 方式实现（见开放风险 R1） THEN THE 桥接服务 SHALL 返回明确的"暂不支持"提示，SHALL NOT 静默失败或假装成功；该命令可降级为本期不交付（P1 允许滑出）。
6. IF 该用户有正在执行的任务 THEN THE 桥接服务 SHALL 拒绝并提示先 `/stop`（见需求 6）。

### 需求 5：命令登记与帮助（P0）

**用户故事：** 作为微信用户，我希望 `/help` 能看到新命令及其用法，以便发现和使用它们。

#### 验收标准

1. THE 新增命令 SHALL 在 `src/commands.ts` 的 `COMMANDS` 登记（name / usage / description），`/help` 自动包含它们。
2. THE 新命令 SHALL 被 `isUnknownCommand` 正确识别为已知命令，SHALL NOT 被当成未知命令或普通消息交给 Qoder。
3. THE 命令分发 SHALL 采用统一的命令处理器注册表（单一分发入口）：每条命令为一个独立处理器模块，新增命令只需新增处理器并登记，SHALL NOT 改动分发主干，SHALL NOT 引入并行的第二套分发逻辑。既有命令（`/help` `/reset` `/status` `/model`）一并迁入注册表，行为保持不变。
4. THE `/help` 与命令回复 SHALL 为中文。
5. THE 微信用户侧命令清单 SHALL 同步更新 qoder-wechat 插件壳（独立仓 `qoder-wechat-plugin`）的 `skills/qoder-wechat/SKILL.md` 与 `agents/qoder-wechat-setup.md` 命令列表，使插件文档与新命令一致。

### 需求 6：并发与状态安全（P0）

**用户故事：** 作为运维者，我希望会话命令不会和正在跑的任务打架，也不会写坏状态文件。

#### 验收标准

1. IF 该用户有正在执行的任务 THEN THE 变更类命令（`/switch`、`/new`、`/rename`） SHALL 拒绝执行并提示先 `/stop`；只读命令 `/sessions` SHALL 仍可执行。
2. WHEN 任一会话命令改写 `state.json` THEN THE 桥接服务 SHALL 复用现有原子保存路径（`saveState`），SHALL NOT 产生半截写入。
3. WHEN 会话命令处理中发生异常 THEN THE 桥接服务 SHALL 捕获并返回可读错误，SHALL NOT 中断 `getupdates` 主循环或影响其它用户。
4. THE 会话命令 SHALL NOT 并发改写同一会话的 jsonl（切换只改桥接指针，不触碰 CLI 会话文件）。

### 需求 7：错误可读性与额度（P1）

**用户故事：** 作为微信用户，我希望命令出错时看得懂、不刷屏。

#### 验收标准

1. THE 会话命令的错误回复 SHALL 为中文、简短，复用现有 `failure.ts` / `error-class.ts` 的归类与截断口径，SHALL NOT 把 CLI 原始 stderr 直达用户。
2. THE `/sessions` 清单与命令确认回复 SHALL 控制在下行额度内（清单按需求 1.4 截断）。
3. WHEN 会话命令调用 qodercli THEN THE 桥接服务 SHALL 设置超时（复用现有 `qoderTimeoutMs` 或独立的列表超时），超时按失败处理。
4. THE 会话命令的关键路径（切换、新建、列表失败） SHALL 写 info/warn 级日志，含 userId 与目标会话 id，便于排查。

### 需求 8：会话删除 `/delete`（P1，2026-11-14 追加）

**用户故事：** 作为微信用户，我希望删除不再需要的会话，以便清单不无限累积。

#### 验收标准

1. WHEN 用户发送 `/delete <目标>` THEN THE 桥接服务 SHALL 解析目标（序号/id/名称，复用 `resolveSession`），回复将删除的会话名与 id 及确认指令，SHALL NOT 立即删除。
2. WHEN 用户发送 `/delete yes <序号>` 且序号与待确认记录匹配、未过期 THEN THE 桥接服务 SHALL 调 `qodercli --delete-session <当前序号>` 删除，成功回复"已删除"。
3. THE 确认 SHALL 有两步且 60 秒过期；序号不匹配/过期/无待确认 SHALL 返回中文提示，SHALL NOT 删除。
4. WHEN 删除的是当前活动会话 THEN THE 桥接服务 SHALL 同时清空会话指针与待用名。
5. THE `/delete` SHALL 标 `requiresIdle`，任务执行中被 intake 拒绝（同需求 6）。
6. IF 删除失败（序号不存在/CLI 失败/超时） THEN THE 桥接服务 SHALL 返回中文错误；成功判据 SHALL 认 stdout 的 `Deleted session`（实测序号不存在也 exit 0，不能靠退出码）。
7. THE 删除 SHALL 按 sessionId 在确认时重新取当前序号，避免两步之间活跃排序漂移。

## 成功标准

- 微信里发 `/sessions` 能列出当前工作目录会话并标出活动会话；`/switch` 能切到指定会话且下条消息续接成功；`/new` 能开新会话（可选命名）；`/rename` 能改名（若 headless 路径成立）；`/delete` 两步确认能删除会话（含括号名称不误判、删活动会话清指针）。
- 切换/新建不改动任何会话内容；旧会话可经 `/sessions` + `/switch` 找回。
- 任务执行中变更类命令被拒绝；命令异常不中断主循环。
- 现有 `/reset`、`/status`、`/model`、`/stop`、`/help` 与普通消息黄金路径行为完全不变。
- 全部测试通过，`coverage.include` 内源文件 Lines ≥ 95%；新增核心逻辑文件须纳入 `coverage.include`。

## 与既有文档的关系

- 上游：`.specs/v2-backlog.md`「会话与路由 → 多会话切换」（`/new`、`/use <name>`）——本包将其落地为 `/sessions` `/switch` `/new` `/rename`，完成后回填指向本目录。
- 同目录：`design.md`（实现设计，待需求批准后产出）、`tasks.md` + `task-list/`（执行拆分）。
- 调研依据：2026-11-14 会话管理方案调研（A 先行 / B 待定），CLI 1.1.89 与桌面 0.5.11 本机取证。

## 非功能性需求

### N1 兼容性

THE 桥接服务 SHALL 保持现有行为完全不变：普通消息收发、排队、`/reset`、`/status`、`/model`、`/stop`、`/help`、`notify`、`send-file`、会话续接语义均不改动。新命令为纯增量。

### N2 依赖与平台

THE 实现 SHALL NOT 引入新的运行时依赖；会话清单与续接使用既有 `cross-spawn` + qodercli，环境清理复用 `qoder.ts` 的 `cleanEnv`。

### N3 安全与隐私

THE 命令回复与日志 SHALL NOT 包含 bot token 或 context_token；会话 id/显示名可展示。`/sessions` 只读，SHALL NOT 暴露会话正文以外的敏感配置。

### N4 可观测性

THE 会话命令的调用与失败 SHALL 有日志可查（userId、命令、目标会话 id、失败原因），口径对齐现有 diagnostics。

## 非目标

- **B 方案本地管理台**（CLI 子命令 / Web 页查看完整历史）：用户决定待定，本期不实现，保留在 v2-backlog。
- `/history`（查看历史轮次）、`/fork`（分支）：用户本期选核心切换组，这些不纳入。（`/delete` 原为非目标，2026-11-14 主人试用时追加，见需求 8。）
- 按项目路由 cwd（消息前缀指定工作目录）：v2-backlog 另一条，独立需求。
- 让 CLI 会话进桌面端 GUI：官方未开放，不做（含逆向桌面 SQLite / host.sock）。
- 跨工作目录切换会话：会话按 cwd 隔离，本期只列/切当前工作目录内的会话。
- 强制自动命名所有桥接会话：保持 CLI 默认首句命名，命名仅由 `/new <名称>` 与 `/rename` 触发。
- 修改会话正文内容（压缩、裁剪、编辑历史）：本期只管理指针与显示名。

## 开放风险（设计阶段须先验证）

- **R1 `/rename` 的 headless 实现路径**：CLI 1.1.89 无独立 `--rename-session` 旗标。候选路径：① `-r <id> -n <新名>` 续接时改名（需实测是否生效、是否消耗额度/产生轮次）；② SDK `renameSession`（需外部会话存储，单机偏重）；③ 读改旁挂 `state.json`（触碰 CLI 内部格式，脆弱，倾向不采用）。设计阶段先跑探针确认①，不成立则 `/rename` 按需求 4.5 降级。
- **R2 `--list-sessions` 文本解析**：该命令无 JSON 输出，需解析文本行（序号/名称/时间/id）。名称可能含空格、括号、中文甚至换行风险，解析须鲁棒；设计阶段固定解析契约并加边界用例。
- **R3 序号稳定性**：`--list-sessions` 序号按最近活跃排序，两次调用间可能变化。`/switch <序号>` 以最近一次 `/sessions` 清单为准；设计阶段决定是否缓存上次清单或优先推荐 id/名称。