# 审查记录：微信会话管理（A 期·核心切换组）

> 日期：2026-11-14 ｜ 分支：`feat/20261114-wechat-sessions` ｜ 覆盖式审查（覆盖旧内容）
> 增量：第二轮审查见 **§11**，终审见 **§13**（2026-11-14）；`/delete` 修复回执见 §10。
> 方法：对照 requirements.md 7 需求 + 4 非功能 + design.md 11 正确性属性逐条核验；每条定级均取本机可复现证据（真实 CLI 输出、构建产物执行、测试复跑）。审查建议本身亦经复核，定级与需求编号分离。

## 0. 结论

主体设计成立：注册表单一分发、指针式切换、intake 元数据守卫、原子写、零新增依赖均按设计落地，新增模块测试覆盖充分。但存在 **1 个必修 P0** 与 **6 个建议合并前修的 P1**：

- **P0**：空工作目录下 `/sessions` 把 CLI 的正常空清单输出当成"解析失败"，违反需求 1.3。
- **P1**：`/help` 丢失 `/stop`（N1 回归）；`/switch <序号>` 与清单展示序号可能错位；同名会话不报"不唯一"（违反需求 2.5）；命令分发缺少统一异常兜底（需求 6.3 未完全满足）；零参命令带参数时语义改变（`/reset 一下` 会直接清指针，N1 偏差）；`listSessions` 超时被误判为"未登录"（错误字段实测不匹配）。

**Ready to merge：With fixes**（P0 必修；P1 建议本次一并修，修后复跑 8.1）。

## 1. 需求覆盖

| 需求 | 结论 | 证据 / 问题 |
| --- | --- | --- |
| 1 `/sessions`（P0） | **P0 缺陷** | 1.1/1.2/1.4/1.5/1.7 通过；**1.3 失败**（空清单误报，见 P0-1）；1.6 失败分支可读，但空清单被误归类、超时被误报为登录失败（P1-6） |
| 2 `/switch`（P0） | 基本通过，2 处偏差 | 2.1/2.3/2.4/2.6/2.7/2.8 通过；**2.2 序号可能错位**（P1-2）；**2.5 名称未做唯一性校验**（P1-3） |
| 3 `/new`（P0） | 通过 | 清指针 + 待用名、不调 CLI、成功后清名（`test/integration/service-commands.test.ts:121-130`）；名称消费失败重试仍保留，合理 |
| 4 `/rename`（P1） | 基本通过，证据待补 | 无会话/空名/超长/失败语义齐全；**4.1 的 headless 生效证据未落盘**，成功判据仅 `is_error=false`（Minor-2） |
| 5 命令登记与帮助（P0） | 部分失败 | 5.2/5.4/5.5 通过；**5.1 失败**：`COMMANDS` 由处理器派生后丢 `/stop`（P1-1）；5.3 四命令迁移完成，但 `/stop` 元数据无归宿、零参命令参数语义变化（P1-5） |
| 6 并发与状态安全（P0） | 基本通过 | 6.1/6.2/6.4 通过；**6.3 部分未满足**：`dispatchCommand` 外层无 try/catch，`/new` `/reset` `/model` 抛错时用户收不到可读错误（P1-4） |
| 7 错误可读性与额度（P1） | 部分失败 | 7.2/7.3 通过；7.1 超时被误报为登录失败（P1-6）；**7.4 未满足**：`/new` 无任何日志，`/switch` 仅失败写 warn，成功路径无 info（Minor-1） |

## 2. 非功能覆盖

- **N1 兼容性：不通过**。`/help` 不再列出 `/stop`（P1-1）；零参命令带参数时语义改变（P1-5，`/reset 一下` 会清指针）。其余普通消息、`/reset`、`/status`、`/model`、`/stop`（精确匹配时）执行路径不变。
- **N2 依赖/平台：通过**。零新增运行时依赖，复用 `cross-spawn` + `cleanEnv`。
- **N3 隐私：通过**。回复/日志仅含 userId、会话 id/名称，未发现 token/context_token。
- **N4 可观测性：部分通过**。失败有 warn；成功关键路径日志缺失（同 Minor-1）。

## 3. 正确性属性覆盖

| # | 属性 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | `/sessions` 只读 | 通过 | 处理器无 persistState；集成用例断言指针不变 |
| 2 | `/switch` 仅改指针 | 通过 | 仅写 `state.sessions`；不调 CLI 改内容 |
| 3 | `/new` 不即时耗额度 | 通过 | 处理器不调 CLI；集成用例断言 runQoder 未调用 |
| 4 | 任务中拒绝变更命令 | 通过 | intake 守卫（`service.ts:865-872`）+ 集成用例 |
| 5 | 异常不中断主循环 | **部分通过** | 主循环有 enqueue catch；但 `/new` 等异常无用户可读回复（P1-4） |
| 6 | 清单按 cwd 隔离 | 通过 | `listSessions(bin, workdir())` 透传 |
| 7 | 状态原子写入 | 通过 | 复用 `persistState` |
| 8 | 重命名受支持路径或降级 | **待取证** | 走 `-r -n -p`；成功判定弱（Minor-2） |
| 9 | 序号以最近清单为准 | **部分通过** | 缓存生效；但缓存内序号映射有错位风险（P1-2） |
| 10 | 增量兼容与隐私 | **不通过** | `/help` 丢 `/stop`（P1-1）+ 零参命令参数语义变化（P1-5）；隐私通过 |
| 11 | 注册表单一分发可扩展 | 通过 | `dispatchCommand` 单入口；新增命令仅需处理器 + 登记 |

## 4. 问题清单

### Critical（必修）

**P0-1 空清单被误判为"解析失败"，`/sessions` 首次使用即报错**
- 位置：`src/bridge/sessions.ts:60-76`（`parseSessionList`）；`src/bridge/commands/sessions.ts:18-22`
- 复现（2026-11-14，qodercli 1.1.89）：
  ```bash
  mkdir -p /tmp/qwb-probe-empty && cd /tmp/qwb-probe-empty && qodercli --list-sessions
  # 输出：No previous sessions found for this project.
  ```
  构建产物直接调用 `parseSessionList` 对上述输出 → `SessionError('parse', '会话清单格式异常，请升级 qodercli')`。用户侧实际收到"无法列出会话：会话清单格式异常，请升级 qodercli"。
- 原因：真实 CLI 的空清单**不输出** `Available sessions ... (0):` 表头，而是一句 `No previous sessions found ...`；它不以 `Available sessions` 开头，被计入 `meaningful`，最终 `meaningful>0 && entries.length===0` 抛 parse。
- 影响：需求 1.3（P0）直接失败；新工作目录/新项目第一次发 `/sessions` 必现；错误文案还会误导用户去升级 CLI。
- 修复：显式识别空清单哨兵（`/^No previous sessions found/` 视为空），并把 parse 错误条件收紧为"存在疑似会话行（含 36 位方括号 id）却无法解析"；仅凭"有非空行"不能判定格式异常。
- 用例：用真实哨兵字符串与"表头 (0)"两种空清单各加一条单测；`/sessions` 集成用例覆盖空目录。
- 去向：回 T2.1（解析）+ T4.1（命令），并入 T8.3 修复批次。

### Important（建议合并前修）

**P1-1 `/help` 丢失 `/stop`，`isUnknownCommand('/stop')` 变为 true**
- 位置：`src/commands.ts:19-31`、`37-40`
- 复现（构建产物）：
  ```text
  可用命令：
  /help — …
  /status — …
  /model … — …
  /reset — …
  /sessions — …
  /switch … — …
  /new … — …
  /rename … — …
  isUnknown(/stop) = true
  ```
- 原因：`COMMANDS` 改为 `COMMAND_HANDLERS.map(h => h.def)` 派生，而 `/stop` 按设计（§5.3.3）不走注册表，导致其元数据无处存放。
- 影响：N1「`/help` 行为不变」回归；`src/index.ts` 导出的 `COMMANDS` 公开元数据也少了 `/stop`。（`/stop` 执行路径仍由 intake 处理，功能未坏，故定为 Important 而非 Critical。）
- 修复：保留一份 metadata-only 的 `/stop` 定义参与 `COMMANDS`（例如 `STOP_DEF` 单独并入，或处理器标 `intakeOnly`），并在 `/help` 断言 `/stop`。
- 去向：回 T1.2。

**P1-2 `/switch <序号>` 与清单展示序号可能错位**
- 位置：`src/bridge/sessions.ts:117-120`（按数组位置 `catalog[n-1]`）、`src/bridge/sessions.ts:155`（展示用 CLI `e.index`）
- 复现（构建产物，含一行坏行）：
  ```text
  展示：1. 甲 … 3. 乙 …（坏行被忽略）
  /switch 3 → {"ok":false,"reason":"序号越界"}   ← 用户看到的序号却不可用
  /switch 2 → 命中 index=3 的「乙」               ← 与展示序号不一致
  ```
- 影响：需求 2.2「序号对应最近一次 /sessions 清单」不成立；一旦 CLI 输出夹带无法解析行（升级、警告行、格式微调），可能切到非用户所指会话（指针被改）。
- 修复：`resolveSession` 数字分支按 `catalog.find(e => e.index === n)` 解析（与展示同源）；或渲染时改用展示位置序号。两者取一并加"跳过坏行后序号仍一致"用例。
- 去向：回 T2.2（+ T4.2 用例）。

**P1-3 同名会话不报"不唯一"，静默切到第一条**
- 位置：`src/bridge/sessions.ts:132-133`
- 复现：两条同名「你好」→ `resolveSession('你好')` 直接返回 `index=1`，不报错。
- 影响：违反需求 2.5「id/名称无法唯一匹配 SHALL 返回错误」；CLI 默认用首句 prompt 命名，同名（如都叫"你好"）并不罕见，可能静默切错会话。
- 修复：名称匹配改为先聚合全部精确匹配，`>1` 返回 `{ok:false, reason:'名称不唯一'}`；补重复名用例。
- 去向：回 T2.2。

**P1-4 命令分发无统一异常兜底，`/new` 等异常时用户无回复**
- 位置：`src/bridge/service.ts:526`（`await dispatchCommand(...)` 未包 try/catch）；`src/bridge/commands/new.ts:12-25`（无 try/catch）
- 影响：需求 6.3 要求"会话命令处理中发生异常 SHALL 捕获并返回可读错误"。`/new` 的 `persistState`（磁盘满/权限）或 `/reset`、`/model` 的 `listModels` 抛错时，异常一路到 enqueue 的 `.catch` 只写日志，用户收不到任何回复。主循环不中断（需求后半满足），但可读错误缺失。
- 修复：在 `service.ts` 的 `dispatchCommand` 调用处统一 try/catch → `log.warn` + 中文提示；处理器内部 catch 保留用于命令级语义。
- 去向：回 T5.1（+ 一条 persistState 抛错用例）。

**P1-5 零参命令带参数时语义改变，`/reset xxx` 会直接清指针**
- 位置：`src/commands.ts:59-64`（`findHandler` 统一前缀匹配）
- 复现（构建产物）：
  ```text
  /help me    => handler: /help   （旧：交给 Qoder）
  /reset 一下 => handler: /reset  （旧：交给 Qoder；新：清空活动会话指针）
  /status x   => handler: /status （旧：交给 Qoder）
  ```
- 原因：旧实现 `/help` `/reset` `/status` 是精确匹配，带参数会落到 Qoder；注册表统一改成"命令名 + 空格"前缀匹配后，零参命令也接受任意尾随文本。
- 影响：N1「既有命令行为不变」偏差。`/reset 一下` 这类输入会清指针（可通过 `/sessions`+`/switch` 找回，非不可逆）；`/help me`/`/status x` 不再交给 Qoder。频率低但属语义变化。
- 修复：在 `CommandDef`/`CommandHandler` 增加 `acceptsArgs?: boolean`，`findHandler` 对零参命令只做精确匹配；或零参处理器自己校验尾随参数并回用法。补 `/reset 一下` 保持 Qoder 路径的用例。
- 去向：回 T1.2（+ T1.1 findHandler 用例）。

**P1-6 `listSessions` 超时被误判为"请确认已登录"**
- 位置：`src/bridge/sessions.ts:95-100`
- 复现（本机 3 次强制 1s 超时）：
  ```text
  { code: 'ETIMEDOUT', killed: undefined, signal: null, status: 143 }
  ```
  实现只判断 `e.killed || e.signal === 'SIGTERM'`，上述真实超时形状两个条件都不成立 → 落入 `spawn` 分支，用户收到"列出会话失败，请确认 qodercli 已登录"（我在仓库目录实测命中过一次）。
- 影响：需求 7.1/1.6 的错误可读性失真——超时被说成登录问题，用户会去做错误的排查动作。
- 修复：优先判断 `e.code === 'ETIMEDOUT'`（可兼看 `status === 143`），再判 `killed/signal`；单测改用真实错误形状，不要 mock `{killed:true,signal:'SIGTERM'}`（`test/unit/sessions.test.ts:113-118` 目前 mock 的是不真实形状，因此漏检）。
- 去向：回 T2.2。

### Minor（可后续处理）

1. **需求 7.4 关键路径日志不全**：`src/bridge/commands/new.ts` 无任何日志；`switch.ts` 仅失败 `warn`（`:52`），成功无 info；`sessions.ts` 仅失败 warn（`:20`）。建议 switch/new 成功写 info（userId、目标 id）。
2. **`/rename` 成功判据弱、证据未落盘**：`sessions.ts:228-232` 仅凭 `is_error=false` 判定成功，未回读清单确认名称生效；verification.md 未附 R1 探针输出，本机也找不到"探针新名"会话。建议验证记录补探针（`-r -n -p` 后 `--list-sessions` 回读），或成功后自动回读一次（不耗额度）。
3. **`/rename` 未纳入 `runningTasks`**：`/stop` 无法终止 rename（提示"没有正在执行的任务"），最坏占住该用户串行队列 `qoderTimeoutMs`（默认 600s）。建议注册取消句柄或使用更短的专用超时。
4. **`renameSession` 输出无上限**：设计 §5.1.1 要求复用 `MAX_OUTPUT_BYTES` 口径，实现 `sessions.ts:213-215` 无上限累积 stdout；spawn 错误直接把英文 `err.message` 拼进中文回复（`:217`）。
5. **`pendingNames` 生命周期**：`/switch`（`switch.ts:43-49`）与 `/reset`（`reset.ts:11`）都不清待用名；`/new 名字` → `/switch`/`/reset` → 之后的新会话仍会被命名，行为意外。建议切换/重置时清空。
6. **`/switch` 复制 `turns`**：`switch.ts:46` 沿用源会话轮次，`/status` 的"累计轮次"在切换后不再对应当前会话（桥接无法得知目标轮次，复制本身可理解，但应注明或置 0）。
7. **错误归类**：`listSessions` 把 `ENOENT` 一律当"未安装"（`sessions.ts:97`）；实测 `config.cwd` 不存在时 `execFileSync` 也报 `ENOENT`（`syscall: spawnSync qodercli`），会误报"未找到 qodercli，请先安装"。
8. **名称未做字符清洗**：`/new`、`/rename` 允许换行或 `-` 开头的名称；换行会污染后续清单解析，`-` 开头可能被 CLI 当旗标。建议拒绝控制字符并禁止首字符为 `-`。
9. **`sessionListLimit` 仅 env 校验**：`config.ts:237-244` 对 env 做正整数校验，但 `loadConfig` 对配置文件值直接合并（`:378`）；配置文件写 0/负数会出现"会话清单（最近 0 条）"。
10. **`execFileSync` 阻塞事件循环最长 20s**：设计 §9 已登记、照 models.ts 范式；`/sessions` 期间所有用户轮询暂停，属已接受代价，仅提示。
11. **`SESSION_LIST_TIMEOUT_MS=20s` 余量偏紧**：干净环境实测（本机 1.1.89）冷启 11.0s、热跑 2.9/2.5s（空目录）与 3.4/2.2/1.8s（仓库目录）；并行压测时曾观测到 >20s（一次 35s）。冷启 + 负载叠加时可能触发超时。建议提高阈值或改配置、或改异步 spawn；不构成 Critical（干净环境有 2–7 倍余量）。
12. **intake 与分发的大小写口径不一致**：intake 用 `text.trim().toLowerCase()` 查 handler（`service.ts:847,866`），processTask 用原文分发（`:509,526`）；`/Switch 2` 在任务运行中会被守卫拒绝，空闲时又落到 Qoder。低频，但与"已知命令"直觉不一致。
13. **上下文死字段**：`CommandContext.contextToken`（`types.ts:24`）与 `isTaskRunning`（`:41`）未被任何处理器使用。
14. **新增文件缺文件末尾换行**：`src/commands.ts` 及 `src/bridge/commands/*.ts` 多数文件末尾无换行（diff 已标注）。
15. **循环导入**：`commands.ts` ↔ `commands/help.ts`（help 反向 import `formatHelp`）。当前 CJS/ESM 求值顺序下安全（测试通过），但属脆弱结构，后续可把 `formatHelp` 下移到独立模块。
16. **UI 小偏差**：设计 §3.1 的清单头部含"当前工作目录：…"，实现 `formatSessionList` 未输出该行（需求未强制）。
17. **测试缺口**：`test/unit/sessions.test.ts:74-76` 只用"表头 (0)"测空清单，未覆盖真实 CLI 哨兵；`sessions.test.ts:113-118` 的 timeout mock 用的是不真实错误形状（掩盖 P1-6）；无重名、序号错位、`/help` 含 `/stop`、成功路径日志、`/new` 异常兜底、`/rename` 运行中拒绝等用例。

## 5. 设计问题（根因，不只实现）

1. **§5.1.1 解析契约未覆盖真实空清单**：设计假设空清单输出表头 `(0)`，实测是 `No previous sessions found ...`，直接导致 P0-1。
2. **§5.1.1 序号语义自相矛盾**：`resolveSession` 用数组位置，渲染用 CLI index；设计未约定"跳过坏行后如何保持序号一致"，导致 P1-2。
3. **名称匹配未落实需求 2.5 的唯一性**：设计写"精确匹配即命中"，与需求冲突（P1-3）。
4. **§5.3 `/stop` 不入注册表，但未安排其 `/help` 元数据归宿**：`COMMANDS` 单一事实来源被派生逻辑破坏（P1-1）。
5. **§5.3.3 统一前缀匹配未区分"零参命令"**：把旧精确匹配的 `/help` `/reset` `/status` 一并放宽为接受尾随参数，造成语义变化（P1-5）。
6. **§5.1.3 声称"命令分支各自 try/catch"，实际只在 sessions/switch/rename 实现**（P1-4）。
7. **需求 7.4 日志在设计 §5.1.3/§7 只描述失败路径**，实现照做，导致成功路径无日志。
8. **R1 重命名的"成立"缺少可复核证据**：设计仅注明"探针坐实"，verification.md 未留输出；且以 `is_error=false` 作为"已改名"的判据不充分（Minor-2）。
9. **`/rename` 的安全边界未讨论**：现网 `permissionMode` 为 bypass 全权，rename 会跑一个完整 agent 轮次；"重命名"这三个字作为 prompt 交给全权限 agent，存在非预期工具调用风险。设计只登记了额度与 junk 轮次，建议明确 prompt/权限收敛策略。
10. **§7 错误映射表未约定超时的真实错误形状**：`execFileSync` 超时实测是 `code=ETIMEDOUT, signal=null`，设计只按 `killed/SIGTERM` 想当然，导致 P1-6；20s 阈值也缺少负载余量评估（Minor-11）。

## 6. 存量与已知限制（只报不修）

- `service-startup` / spawn 类用例在并行 + 覆盖插桩下有时序 flaky：并行探针干扰下曾出现 3 例失败；随后安静环境 `npx vitest run --maxWorkers=2` **28 文件 / 457 用例全绿（exit=0）**，`service-startup.test.ts` 单跑 29/29，确认与本期改动无关，属负载型 timing flaky。
  - 旧 review 声称已把该治理登记到 `v2-backlog`「工程」节，实际文件中没有对应条目；本次按"存量只报不修"保持现状，但去向需明确（补登记或明确不追）。
- 清单缓存/待用名为内存态，重启丢失；`/rename` 耗额度 + junk 轮次；`execFileSync` 阻塞事件循环：均为设计 §9 已登记并接受的代价。
- 插件壳（独立仓 `qoder-wechat-plugin`，分支 `feat/20261114-session-commands`）两个文件已改未提交：`skills/qoder-wechat/SKILL.md:39`、`agents/qoder-wechat-setup.md:115`，命令清单已含四命令。

## 7. 复跑证据（本次审查）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过 |
| 本期相关测试 | `npx vitest run <6 个文件> --maxWorkers=1` | 6 文件 / 72 用例全绿 |
| 全量测试（安静环境） | `npx vitest run --maxWorkers=2` | **28 文件 / 457 用例全绿，exit=0** |
| 全量测试（并行探针干扰下） | 同上 | 454 通过 / 3 失败（存 timing flaky；安静环境复跑全绿，见 §6） |
| CLI 空清单 | `cd /tmp/qwb-probe-empty && qodercli --list-sessions` | `No previous sessions found for this project.` |
| 空清单解析 | 构建产物 `parseSessionList` 对上述输出 | 抛 `SessionError('parse')`（P0-1 复现） |
| `/help` | 构建产物 `formatHelp()` / `isUnknownCommand('/stop')` | 无 `/stop`；`isUnknownCommand('/stop')=true`（P1-1 复现） |
| 零参命令参数 | 构建产物 `findHandler('/reset 一下')` | 命中 `/reset`（旧实现会交给 Qoder，P1-5 复现） |
| 超时错误形状 | `execFileSync(..., {timeout:1000})` ×3 | `{code:'ETIMEDOUT', killed:undefined, signal:null, status:143}`（P1-6 复现） |
| CLI 延迟 | 空目录 3 次 / 仓库目录 3 次（干净环境） | 11.0/2.9/2.5s 与 3.4/2.2/1.8s（Minor-11） |
| 序号/重名 | 构建产物 `parseSessionList`+`resolveSession` | 坏行错位、重名首条命中（P1-2/P1-3 复现） |

### 独立审查结论对账

子代理独立审查（同一分支、只读）与主审结论一致的部分：P0-1、P1-1、P1-2、P1-4、Minor 日志/输出上限/死字段/配置未校验。差异与校正：

- 子代理把"`--list-sessions` 13–30s 触发 20s 超时"定为 Critical；主审复测干净环境为冷启 11.0s、热跑 1.8–3.4s，仅在并行压测时 >20s。**降级为 Minor-11（余量偏紧）**，不作为合并阻塞项。
- 子代理报告的"466 用例全绿"应为 457（本仓实际总数），已按 457 记录。
- 子代理未覆盖、主审补充：重名不唯一（P1-3）、零参命令参数语义（P1-5）、超时错误形状复现（P1-6）。

## 8. 下一步

1. 按 P0-1 → P1-1/P1-2/P1-3/P1-4/P1-5/P1-6 顺序走 TDD 修复（先失败用例），回对应任务；建议在 tasks.md 增一条 **T8.3 审查修复批次**统一跟踪。
2. Minor 1/2/3/5 建议本期顺带修（都小且与验收相关）；其余列 v2-backlog 或后续清理。
3. 修复后复跑 8.1（typecheck / build / `vitest run --maxWorkers=2` / coverage / pack），安静环境确认 457 全绿，再交微信真人验收。

## 9. 修复回执（2026-11-14，阿程 TDD 修复批次 T8.3）

主审独立复证全部 P0/P1 属实后逐条修复（先写失败用例再修），并顺带修 cheap 且涉正确性/安全的 Minor。

| 编号 | 修复 | 证据 |
| --- | --- | --- |
| P0-1 | `parseSessionList` 识别 `No previous sessions found` 哨兵；parse 错误收紧为"含方括号 id 的疑似会话行却无法解析" | 空目录实测哨兵→`[]`；新增 4 条解析用例 |
| P1-1 | `COMMANDS` 并入 metadata-only 的 `STOP_DEF`（intake-only，不入分发） | `formatHelp()` 含 `/stop`、`isUnknownCommand('/stop')=false`、`findHandler('/stop')=undefined` |
| P1-2 | `resolveSession` 序号改按 `e.index` 查找（与展示同源） | 稀疏序号 [1,3]：`/switch 3`→乙、`/switch 2`→越界 |
| P1-3 | 名称匹配聚合全部精确匹配，`>1` 返回"名称不唯一" | 两条"你好"→`{ok:false,reason:'名称不唯一'}` |
| P1-4 | `service.ts` `dispatchCommand` 外包 try/catch→中文回复 | `/model` listModels 抛错→用户收到"命令执行出错" |
| P1-5 | `CommandHandler.acceptsArgs`；零参命令仅精确匹配 | `findHandler('/reset 一下')=undefined`（交回 Qoder）；带参命令仍前缀匹配 |
| P1-6 | 超时优先判 `code==='ETIMEDOUT'`（兼看 status 143） | qodercli 强制超时 ×3 真实形状 `{ETIMEDOUT,signal:null,status:143}`→正确归类 timeout |
| Minor-1 | switch/new 成功写 info 日志 | 代码 + 用例 |
| Minor-4 | renameSession 输出 1MB 上限；spawn/非零退出错误改中文 | 用例文案同步 |
| Minor-5 | /switch、/reset 清待用名 | 生命周期用例 |
| Minor-7 | ENOENT 文案改"未安装或工作目录不存在"（不单一归因安装） | 用例 |
| Minor-8 | `sessionNameError` 拒绝控制字符/换行与 `-` 开头 | new/rename 用例 |
| Minor-9 | `loadConfig` 校验配置文件 sessionListLimit 正整数 | 配置文件 0→回落 10 用例 |
| Minor-11 | `SESSION_LIST_TIMEOUT_MS` 20s→30s（冷启余量） | 常量 |

**复跑证据**：`npm run typecheck` 通过；`npx vitest run --coverage --maxWorkers=2` **28 文件 / 471 用例全绿**（较修复前 +14 用例），All files Lines **98.58%**，新模块全 100%；`npm run build` 通过；已 `launchctl kickstart -k` 重新部署试用服务（pid 97669，预检通过），dev 产物复验 P0-1/P1-1 生效。

**延期项（列 v2-backlog，不在本期）**：Minor-2（rename 成功回读清单验证）、Minor-3（/rename 纳入 runningTasks 可取消）、Minor-6（/switch 复制 turns 语义）、Minor-10/12-17（阻塞已接受/大小写口径/死字段/末尾换行/循环导入/UI 头部/测试缺口补齐）。其中 Minor-2/3 涉验收与安全，建议下一迭代优先。

**主审对账修正**：P1-6 不仅是指控属实，且正是主人试用时首次 `/sessions` 失败的根因（冷启 >20s 超时被误归类"请确认已登录"）；Minor-11 提阈值后缓解。

## 10. /delete 增量审查修复回执（2026-11-14，TDD）

独立审查对 /delete 增量提出 I-1~I-3 + Minor，阿程逐条本机复证属实后修复：

| 编号 | 修复 | 证据 |
| --- | --- | --- |
| I-1 | 删除成功后 `ctx.catalogs.delete(userId)` 失效序号缓存 | 新增用例：删后 `catalogs.has=false`；防 `/switch 序号` 指向已删会话 |
| I-2 | `deleteSession` 解析 stdout 被删名称返回；处理器与 `pending.name` 后验比对，不符告警 | 受控探针证实 stdout 含名称；新增名称不符用例 |
| I-3 | 受控删除探针落盘 verification.md §8（临时目录，非生产） | 成功 `Deleted session 1: 只回复 ok`、不存在也 exit 0 |
| Minor 文案 | 会话函数返回裸原因、处理器加一次前缀，消除"重命名失败：重命名失败"重复 | rename/delete 文案用例同步 |
| Minor 超时 | `/delete` 用 `SESSION_DELETE_TIMEOUT_MS=30s`（非任务 600s） | 常量 + 设计 §5.0 |
| Minor 残留 | `/new` `/reset` 清 `pendingDeletes` | 新增用例 |
| Minor 集成 | 补 `/delete` 经 processTask 两步确认集成用例 | service-commands 集成 |
| Minor 文档 | design 命令范围/超时阈值（20s→30s）、verification 补 delete.ts 与探针 | 文档同步 |

**复跑**：typecheck/build 通过；全量 **492 用例全绿**（+4），All files Lines **98.65%**，delete.ts 100%；已重建并 kickstart 部署（pid 26799，预检一次通过）。

**仍延期（backlog）**：/delete 与 /rename 纳入 runningTasks 使 /stop 可取消（Minor-3 同源）；/delete <序号> 用新鲜清单而 /switch 用缓存的口径差异（删除用新鲜更安全，保留）。

## 11. /delete 终审 F 批次修复回执（2026-11-14，TDD）

终审唯一阻塞项 F-1 + 同批 F-2/F-3 + 文档漂移，阿程复证属实后修复：

| 编号 | 修复 | 证据 |
| --- | --- | --- |
| F-1（阻塞） | 弃用脆弱的名称字符串比对，改**删除后重新 listSessions 按 pending.sessionId 是否消失判定**——根治含括号名截断/重名/误判，且正确清指针 | 复证旧正则把"重构 (登录页) 方案"截成"重构"；新方案三样本+re-list 用例全绿 |
| F-2 | 误判分支测试改实断言：先设活动指针，re-list 仍在→判未生效且**不清指针** | 新增用例断言指针保留 |
| F-3 | 任何 !ok/超时/catch 都 `ctx.catalogs.delete`（CLI 可能已删但报失败） | 失败/抛错用例断言缓存失效 |
| 文档漂移 | design 布局/接口/影响范围补 delete；requirements 成功标准补 /delete；verification 打包尺寸 103.1kB/79files、用例数 492 | 文档同步 |

**复跑**：typecheck/build 通过；全量 **492 用例全绿**，All files Lines **98.7%**，delete.ts 100%；已重建并 kickstart 部署（pid 39768，预检瞬时失败自愈）。

**微信真人验收重点**（终审建议）：含括号名称的会话删除、删活动会话后下一条消息、任务中 /delete 被拒。

## 11. 增量审查（第二轮，2026-11-14）

> 范围：§9 修复回执逐条复证 + 需求 8 `/delete` 增量。方法：读当前源码/测试 + 构建产物执行 + 真实 CLI 只读探针 + 安静环境全量复跑；未改动任何代码。独立子代理同范围复核，结论已对账。

### 11.1 修复项复证（全部成立）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| P0-1 空清单哨兵 | 已修复 | 构建产物对 `No previous sessions found...` → `[]`；空目录端到端 `/sessions` 回"当前工作目录下还没有会话" |
| P1-1 `/stop` 元数据 | 已修复 | `formatHelp()` 含 `/stop`、`isUnknownCommand('/stop')=false`、`findHandler('/stop')=undefined` |
| P1-2 序号一致 | 已修复 | 稀疏序号 [1,3]：`/switch 3`→乙、`/switch 2`→越界 |
| P1-3 重名唯一 | 已修复 | 两条「你好」→ `{ok:false,reason:'名称不唯一'}` |
| P1-4 分发兜底 | 已修复 | 集成用例 `/model` 抛错 → "命令执行出错"（`service-commands.test.ts:156-163`） |
| P1-5 零参命令 | 已修复 | `/reset 一下`、`/help me`、`/status x`、`/sessions extra` 均不命中；`/model 3`、`/switch 2`、`/new 名`、`/delete …` 仍命中 |
| P1-6 超时归类 | 已修复 | 强制 1s 超时真实形状 `{ETIMEDOUT,signal:null,status:143}` → `timeout` |
| Minor-1/4/5/7/8/9/11 | 已修复 | 与 §9 回执一致；日志、1MB 上限、待用名清理、ENOENT 文案、名称清洗、配置文件校验、30s 阈值均在码 |

**验证**：`npm run typecheck`、`npm run build` 通过；安静环境 `npx vitest run --maxWorkers=2` **28 文件 / 488 用例全绿，exit=0**；`npm pack --dry-run` 含 `dist/bridge/commands/delete.js`（102.6 kB / 79 files）。

### 11.2 新增问题

#### Important

**I-1 `/delete` 成功后 `catalogs` 未失效，后续 `/switch <序号>` 会切到已删除会话**
- 位置：`src/bridge/commands/delete.ts:58-64`（成功分支只清指针/待用名），`src/bridge/commands/switch.ts:22-34`（数字序号走缓存）
- 复现（构建产物 + 模拟 CLI 重排）：缓存 `[1:甲,2:乙,3:丙]` → `/delete 2` → `yes 2` 成功（CLI 实际变为 `[1:甲,2:丙]`）→ `/switch 2` 仍按旧缓存命中**已删除的乙**，指针指向已删 id；下条消息续接失败后静默新建。若删的是中间条目，也可能切到与展示不符的会话。
- 影响：违反正确性属性 9 的"不用过期序号误切"；删除后是确定性触发，不需要外部竞争。
- 修复：成功删除后 `ctx.catalogs.delete(ctx.userId)`（强制下次 `/sessions`），或写入剔除并重排后的清单；补"删除后 `/switch <序号>` 要求先 `/sessions`"用例。
- 去向：T9.2 修复批次。

**I-2 破坏性删除缺少后验，索引 TOCTOU 不可观测（风险，未稳定复现）**
- 位置：`src/bridge/commands/delete.ts:41-57`、`src/bridge/sessions.ts:277-322`
- 机理：确认阶段"重新 list 取 index → spawn `--delete-session <index>`"之间存在窗口；若同工作目录在此期间因外部进程（桌面端/另一授权用户）新建或激活会话导致排序变化，可能删到相邻条目；回复仍称"已删除「预期名」"。CLI 成功 stdout 形如 `Deleted session <n>: <名称> (...)`，当前实现只做 `/Deleted session/` 存在性判断，不回读名称。
- 影响：删除不可恢复，后果最重；概率低（同用户命令串行、requiresIdle 已挡住自身任务），但外部写入不受桥接控制。
- 修复：解析 stdout 的序号与名称，与 `pending.name` 比对，不一致时告警（无法回滚，但可立即告知）；删除后再 list 一次确认目标 id 消失且未连带其它条目；受控探针确认回显格式后落用例。
- 去向：T9.2（与 I-3 同批）。

**I-3 `--delete-session` 成功语义缺少落盘探针证据**
- 位置：`requirements.md:141/145`、`src/bridge/sessions.ts:271-273` 注释均称"实测"，但 `verification.md` 未记录成功删除的探针输出。
- 现状：主审只能验证"不存在的序号 9999 → exit 0、stdout 空、判失败、会话数不变"（未触真实会话）；无法证明序号 1-based、与 `--list-sessions` 同序、成功 stdout 的真实格式。
- 建议：上线/验收前在**临时项目**做一次受控探针（建 2 条会话，删第 2 条，核对回显名与剩余清单），把输出贴入 verification.md；生产工作目录不要执行。
- 去向：T9.2 验证项。

#### Minor

1. **失败文案重复前缀**（已复证）：`renameSession` 的 spawn 错误本身以"重命名失败："开头，handler 再拼一次 → "重命名失败：重命名失败：无法启动 qodercli"（`rename.ts:37` + `sessions.ts:247`）；delete 同理 → "删除失败：未找到该序号的会话或删除失败"（`delete.ts:55` + `sessions.ts:319`）。建议内层错误只给原因。
2. **`/delete` 超时复用 `qoderTimeoutMs`（600s）且不在 `runningTasks`**：`/stop` 无法取消，最坏占住该用户队列 10 分钟；建议专用短超时（如 30s），与延期项 Minor-3 一并处理。
3. **`pendingDeletes` 跨命令残留**（已复证）：`/delete 2` 后接 `/new` 或 `/reset`，待确认记录仍在，60s 内仍可 `yes 2` 真删；建议 `/new` `/reset` `/switch` 时一并清理，或明确保留语义。
4. **`/delete <序号>` 与 `/switch <序号>` 口径不同**：delete 第一步用新鲜清单解析，switch 用上次 `/sessions` 缓存；第一步回显名称可兜底，但可能与用户刚看到的清单不一致，建议文档注明或用缓存。
5. **`/delete` 缺集成走线用例**：`service-commands.test.ts` 未注入 `deleteSession`，目前仅处理器级 ctx 单测；建议补"processTask → /delete → 删活动会话清指针"与"任务中拒绝"两条。
6. **文档漂移**（建议同批同步）：
   - `design.md:28` 仍把 `/delete` 列为非目标，与需求 8/§5.3.4 冲突；§5.3.1 目录缺 `delete.ts`；§5.2 数据模型缺 `pendingDeletes`；§5.3.2/§5.3.3 未同步 `acceptsArgs` 与 `deps.deleteSession`（仍写无条件前缀匹配）；§5.0/§7/§9 仍写 20s（实现已是 30s）。
   - `requirements.md:150/158` 成功标准与文档关系仍只列四命令；需求 8 已存在，建议补 `/delete`。
   - `verification.md`：§1 写 488 绿（已由本次安静复跑确认）；但 §2 覆盖表漏 `commands/delete.ts`，§3 产物列表漏 `delete.js`、打包尺寸仍写 98.9 kB/77 files（实测 102.6 kB/79 files），§4 仍写 457，§6 真人验收清单未含 `/delete`。
   - README/RUNBOOK/插件壳已含 `/delete`，无漂移。

#### 残留的既有风险（非本轮新增，状态不变）

- `/rename` 成功仍只认 `is_error=false`、未回读清单（Minor-2 延期）；`/rename` 仍未纳入 `runningTasks`（Minor-3 延期）；`/switch` 复制 `turns`（Minor-6 延期）；大小写口径/死字段/末尾换行/循环导入/`/sessions` 不提示 `/delete` 等（Minor-12-17 延期）。

### 11.3 独立审查对账

- 子代理独立复核同样判定 §9 修复成立，并独立发现 I-1（缓存失效）、I-2（TOCTOU）、失败文案重复、`pendingDeletes` 残留、文档漂移；与主审一致。
- 子代理未复跑 typecheck/build；主审已复跑并通过。子代理"P1-5 零参命令均已标注"表述不准确：实现是**未标 `acceptsArgs` 即精确匹配**，行为正确。
- 子代理建议的"解析回显名比对"与"删除后 list 复核"为 I-2 的可落地缓解，主审采纳为建议；TOCTOU 无法稳定复现，按"不可逆操作风险"定级而非已证实缺陷。
- 本次安静环境全量 488/488 全绿；此前一次并行探针/子代理负载下出现 `fake-ilink` 5s 超时 1 例，单跑 15/15 全绿，属存量 timing flaky，非增量回归。

### 11.4 结论

**Ready to merge：With fixes**。修复项复证全部成立，无新增 Critical；合并前建议至少修 **I-1**（一行缓存失效 + 用例）与 I-2 的回显名比对，补 I-3 受控探针并同步文档漂移。完成后再交微信真人验收（重点加 `/delete` 两步确认与删活动会话后下一条消息行为）。建议在 tasks.md 增 **T9.2 增量修复批次**统一跟踪（I-1/I-2/I-3 + Minor 1/2/3/5/6）。

## 12. 遗留项去向（第二轮更新）

| 项 | 去向 |
| --- | --- |
| I-1 删除后缓存失效 | T9.2 立即修（含用例） |
| I-2 删除后验/回显名比对 | T9.2（与 I-3 同批） |
| I-3 受控删除探针证据 | T9.2 验证项，验收前完成 |
| 增量 Minor-1 失败文案重复 | T9.2 顺带修 |
| 增量 Minor-2/3/5（delete 超时、pendingDeletes 残留、集成用例） | T9.2 或 v2-backlog |
| 增量 Minor-6 文档漂移 | T9.2 同批同步 |
| 第一轮延期项 Minor-2/3/6/10/12-17（原编号） | v2-backlog（`.specs/v2-backlog.md` 已登记） |

## 13. 最终增量审查（第三轮，2026-11-14）

> 范围：I-1/I-2/I-3 + Minor 修复回执与文档同步。方法：源码/测试复核、构建产物执行、正则样本、安静环境全量+覆盖率复跑；未改代码。独立子代理同范围复核（对账见 §13.3）。

### 13.1 复证结果

| 项 | 结论 | 证据 |
| --- | --- | --- |
| I-1 删除后缓存失效 | 已修复 | `delete.ts:66` 成功后 `catalogs.delete`，名称不符分支 `:61` 同样失效；单测 `commands-session.test.ts:356-362`；构建产物行为确认 |
| I-2 名称后验 | **部分成立，有误判** | 名称比对已接，但解析正则在"名称含 ` (`"时截断（见 F-1） |
| I-3 受控探针 | 已落盘 | `verification.md §8`：成功 stdout `Deleted session 1: 只回复 ok (Just now)`、重复删 exit 0；可确认 1-based（0-based 时单会话删 1 不会成功） |
| 文案去重 | 基本修复 | 内层只返回原因、处理器加一次前缀；`重命名失败：重命名失败` 已消除（仍有"失败/删除失败"叠义，Minor） |
| 删除超时 | 已修复 | `SESSION_DELETE_TIMEOUT_MS=30s`，设计 §5.0/§7 同步 |
| pendingDeletes 残留 | 已修复 | `/new` `:25`、`/reset` `:14` 清理 |
| /delete 集成走线 | 已补 | `service-commands.test.ts:165-178` 两步确认 + 清活动指针 |
| 文档同步 | 部分完成 | design 命令范围/超时、verification §8 已同步；其余漂移见 F-4 |

**验证**：`npm run typecheck`、`npm run build` 通过；安静环境 `npx vitest run --coverage --maxWorkers=2` **28 文件 / 492 用例全绿（exit=0）**；All files Lines **98.7%**（Stmts 97.08 / Branch 89.82 / Funcs 97.59），`delete.ts` Lines 100%、`sessions.ts` Lines 100%。

### 13.2 新发现

#### Important

**F-1 删除成功回显的名称解析在"名称含 ` (`"时截断，导致误判并跳过清指针**
- 位置：`src/bridge/sessions.ts:322`（`/Deleted session \d+: (.*?) \(/`）、`src/bridge/commands/delete.ts:58-64`
- 复现：
  ```text
  真实 stdout: Deleted session 1: 重构 (登录页) 方案 (Just now)
  当前解析:    "重构"          （在第一个 " (" 处截断）
  预期:        "重构 (登录页) 方案"
  ```
  构建产物跑处理器：pending.name=`重构 (登录页) 方案`、deleteSession 返回解析名 `重构` → 回复"删除的会话「重构」与预期「重构 (登录页) 方案」不符"，**指针未清、待用名未清**（删除实际已成功）。
- 影响：违反需求 8.4（删活动会话须清指针）；用户收到虚假告警；下一条消息对已删 id 续接失败后静默新建。名称由首句 prompt 生成，含 ` (` 很常见（设计自己的用例就是"重构 (登录页) 方案"）。
- 修复（最小）：正则改为尾部锚定贪婪/回溯形式，例如 `/Deleted session \d+: (.*?)\s*\([^)]*\)\s*$/`（已验证三种样本），并补"带括号名称"单测。
- 修复（更稳，建议）：删除后重新 `listSessions`，按 `pending.sessionId` 是否消失判定成功，而非依赖名称。可同时覆盖重名、长名截断、误判分支指针悬空。
- 去向：T9.2 后续修复（建议新增 9.3）。

**F-2 名称不符分支无法区分"误判"与"真删错"，且现有用例是空断言**
- 位置：`src/bridge/commands/delete.ts:58-64`、`test/unit/commands-session.test.ts:364-371`
- 事实：删除已发生，但分支不改 `state.sessions`；若误判（F-1）或删到邻条且邻条恰为活动会话，指针会悬空。用例只断言 `state.sessions.u1` 为 undefined，但从未设置该指针，断言恒真，未保护行为。
- 修复：采用 F-1 的"删后 list 按 id 复核"；误判/删错时若指针 id 已不在清单则清指针；用例先设置活动指针再断言。
- 去向：T9.2/9.3 与 F-1 同批。

**F-3 删除失败/超时路径不清缓存，可能残留已删语序号**
- 位置：`src/bridge/commands/delete.ts:54-57`
- 机理：30s 超时/SIGKILL 时 CLI 可能已删除成功，但 handler 直接回复失败并返回，`catalogs` 与指针保持旧值；后续 `/switch <序号>` 与 I-1 同类误切。
- 修复：任何 `!ok` 都 `ctx.catalogs.delete(ctx.userId)`（无害，强制 `/sessions`）；超时文案提示"结果不确定，请发 /sessions 核对"；指针是否清空可交给删后 list 复核（同 F-1）。
- 定级：Important（低概率，但属不可逆操作的状态一致性）。
- 去向：T9.2/9.3。

#### Minor

1. **仅比对名称对重名/长名截断不足**：stdout 无 id，漂移删到同名孪生条目不报警；建议按 id 删后 list（同 F-1 更稳方案）。
2. **文案叠义**：`删除失败：未找到该序号的会话或删除失败`（`delete.ts:55` + `sessions.ts:324`）、`重命名失败：失败，请稍后重试`（非零退出分支）仍读起来重复；建议内层用"未找到该序号""退出异常"等。
3. **探针覆盖不足**：`verification.md §8` 只建 1 条会话、名称不含括号；未验证"2 条删第 2 条"的序号对应、括号/长名回显。建议补一次受控 2 会话探针（临时目录）或至少补解析单测。
4. **测试缺口**：无"带括号名称删除解析"用例；无"任务中 `/delete` 被拒"集成用例（`requiresIdle` 已置 true，但仅 `/delete` 处理器单测标了属性）。
5. **文档残留漂移**：`design.md:390` 仍只写"认 stdout `Deleted session`"未提名称后验；§5.2(307-315) 缺 `pendingDeletes`；§5.3.1(324-337) 缺 `delete.ts`；§5.3.2 接口缺 `acceptsArgs`/`deps.deleteSession`；§5.3.3(373) 仍写无条件前缀匹配；§11(548-555) 影响范围仍只列四命令。`requirements.md:150/158` 成功标准与文档关系仍未含 `/delete`。`verification.md:12` 打包尺寸仍 98.9 kB/77 files（实测 103.1 kB/79 files）、`:16` 覆盖率 98.58%（实测 98.7）、`:46` 仍写 457 用例、`:57-59` 验收清单未含 `/delete`。
6. **历史段落数字**：§11.1 记录的 488 是第二轮当时基线，本轮实测 492；不属于错误，已在 §13.1 更新。

#### 仍延期（非本轮）

- `/delete`、`/rename` 未纳入 `runningTasks`，`/stop` 不可取消；`/delete <序号>` 用新鲜清单而 `/switch` 用缓存（删除用新鲜更安全，保留）；既有一轮 Minor-2/3/6/10/12-17。

### 13.3 独立审查对账

- 子代理独立复核与主审一致：I-1 已修；I-2 名称解析对"含 ` (`"截断（Important）；误判分支指针未清；因超时可能已删但不清缓存；文案叠义；探针只覆盖单会话；文档漂移。主审逐条复证，F-1/F-2/F-3 均已在本机以构建产物或样本复现。
- 子代理基于修订前的 review.md 报告"仍有两个 §10"：主审已在本轮把第二轮章节重编号为 §11、遗留项为 §12；其提到的 "§10.1/§10.3 记 488" 对应历史基线，本轮已更新为 492。
- 子代理实测全量 492 全绿，与主审一致；其未复跑覆盖率，主审实测 All files Lines 98.7%。

### 13.4 结论

**Ready to merge：With fixes**。I-1/I-3 与 Minor 修复均已落地，无 Critical；**唯一阻塞项是 F-1**（一行正则 + 一条带括号名称用例即可），建议同批处理 F-2/F-3（删后 list 按 id 复核 + 失败清缓存）与 F-4 文档漂移。修复后即可交微信真人验收（重点：含括号名称的会话删除、删活动会话后下一条消息、任务中 `/delete` 被拒）。

## 14. 最终去向

| 项 | 去向 |
| --- | --- |
| F-1 括号名称解析 + 用例 | T9.3（建议新增）立即修 |
| F-2 删后按 id 复核 / 指针一致性 / 空断言用例 | T9.3 |
| F-3 失败/超时清缓存 | T9.3 |
| 增量 Minor-1/2/3/4（重名/文案/探针/测试） | T9.3 或 v2-backlog |
| 增量 Minor-5 文档漂移 | T9.3 同批同步 |
| `/delete`/`/rename` 可取消、fresh-vs-cache 口径 | v2-backlog |


