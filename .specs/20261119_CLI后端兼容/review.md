# 审查报告：CLI 后端兼容（20261119）

> 审查方式：覆盖式，独立复核 `requirements.md` / `design.md` / 实现 / 测试 / CN 真机证据
> 分支：`feat/20261119-cli-backend-compat` ｜ HEAD：`23ead42`
> 审查日期：2026-11-19
> 审查结论：**有条件通过，暂不建议按上一版 review.md 的“达到合并提交条件”直接收尾。**
> 核心架构（后端画像纯函数、`cleanEnv`、会话 bin 标签、四命令适配）成立，默认路径下国际版/CN 均可用，国际版回归绿；但 **P1-1（配置目录覆盖链路）** 与 **P1-2（预检告警/诊断）** 是需求验收缺口，需修复或由主人明确降级；P2 若干建议本包顺手处理。
> **增量复审（2026-11-19）**：§10 修复已独立复核，P1-1/P1-2 与 P2-1..P2-5 闭环；当前结论改为 **通过（可合并）**，剩余 1 个 P2 边界与 P3 文档/测试建议见 §11。

---

## 0. 结论摘要

| 级别 | 问题 | 影响 | 建议 |
|---|---|---|---|
| **P1-1** | CN 配置目录覆盖名写错（`QODER_CONFIG_DIR` ≠ CN 的 `QODERCN_CONFIG_DIR`），且 `cleanEnv()` 把覆盖变量从 CLI 子进程剥掉，`models.ts` 却仍读它 | 设覆盖变量时 `/model` 可能列出 CLI 不认识的模型，CN 还可能混入国际版 provider；默认目录不受影响 | 按后端解析覆盖变量并贯通到 CLI；或修订需求/文档，明确仅影响列表读取 |
| **P1-2** | 预检失败的用户告警仍写死 `qodercli`，失败日志也未记录实际 bin / failure detail | CN 预检失败时误导用户；排查缺少关键 bin 信息；违反需求 5.3 与成功标准 | 告警使用实际 `qoderBin`（或按 D7 中性化），日志补 `qoderBin` + detail；补 CN 用例 |
| **P2-1** | 启动日志缺“配置目录”字段 | 需求 6.2 未完全落实，运维无法从日志确认画像目录 | 增加 `configDir` 字段与断言 |
| **P2-2** | `models.test.ts` 模块级缓存未清理，最后一个用例可命中前面同 bin 缓存 | “缓存按 bin 隔离”用例对 CN 侧证明力不足，可能掩盖回归 | 加测试专用清缓存 / `vi.resetModules()`，用唯一 provider id |
| **P2-3** | README launchd 示例只设 `QWB_QODER_BIN=qoderclicn`，未保证 PATH 含 `/usr/local/bin` | launchd 默认 PATH 下按名调用可能 ENOENT，CN 新用户易踩 | 示例改用绝对路径或显式设置 PATH |
| **P2-4** | CLI help 与 README 通用排障仍有 `qodercli` 残留（`--qoder-bin`、`qodercli login`） | CN 用户按图索骥会跑错命令 | 补 CN 版说明，登录命令写成“对应后端” |
| **P2-5** | `activeSession` 对 `record.bin` 无类型防御 | 手改/损坏 state 的 `bin` 非字符串会让 `backendProfile` 抛错 | `typeof === 'string'` 收窄，低概率低成本 |

**总评**：实现质量整体较好：改动集中在正确的位置，纯函数画像与 bin 标签的组合把差异收敛得很干净；530 用例、98.7% 行覆盖、pack 自检都通过。上一版 review.md 的“代码质量与默认路径可用”判断基本成立，但其“达到合并条件”的结论漏掉了配置目录覆盖链路与预检文案/诊断两个需求缺口，且“CN 七项验收全部通过”本轮未能全部独立复核（见 §1.3）。

---

## 1. 本轮独立验证

### 1.1 代码门禁

| 项 | 命令 | 结果 |
|---|---|---|
| 工作树 | `git status --short` / `git diff --stat` | HEAD `23ead42`；23 个已修改文件 + 3 个新增源码/测试 + 规范包未跟踪；`git diff --check` 无空白错误 |
| 类型检查 | `npm run typecheck` | 通过 |
| 构建 | `npm run build` | 通过（`postbuild ok`） |
| 全量测试 | `npx vitest run --coverage --maxWorkers=2`（node 24.21.0） | **30 文件 / 530 用例全绿**，9.33s |
| 覆盖率 | 同上 | All files Lines **98.7%**（1912/1937）、Statements 97.1%、Branches 89.94%、Functions 97.61% |
| 打包自检 | `npm pack --dry-run` | 含 `dist/bridge/backend.js` / `backend.d.ts`，无缺失 |
| 白名单触达文件 | 同上 | `backend.ts` 100、`config.ts` 100、`qoder.ts` 96.58、`service.ts` 97.95、`failure.ts` 100、`sessions.ts` 100、四命令处理器 100（Lines），均 ≥95% |
| 未纳入门禁 | `vitest.config.ts` | `models.ts` 沿用既有白名单外状态（任务 8.1 明确“不扩大门禁”），有单测但不参与 95% 门禁 |

> 验证口径：本轮用 node 24.21.0（`PATH` 前置 n 版本目录）跑测试；默认 node 20.20.2 + vitest 5.1.0 reporter 的 `Map.groupBy` 崩溃为存量问题，本轮未复现/未处理。生产运行时仍要求 node ≥20，未被本次改动改变。

### 1.2 CN CLI 独立抽查

| 项 | 命令 / 方式 | 结果 |
|---|---|---|
| CN CLI 就位 | `qoderclicn --version` | `1.1.92` |
| 空清单哨兵 | 空目录 `qoderclicn --list-sessions` | `No previous sessions found for this project.`，与 `sessions.ts` 哨兵正则匹配 |
| CN 内置/自定义模型 | `listModels('/usr/local/bin/qoderclicn')` | 22 条：14 内置 + 8 自定义 |
| 国际版模型对照 | `listModels('/usr/local/bin/qodercli')` | 25 条：17 内置 + 8 自定义 |
| 桥接 listSessions | `listSessions('/usr/local/bin/qoderclicn', homedir)` | 2 条真实 CN 会话，解析正常 |
| 画像/记忆 env | `backendProfile` / `cleanEnv({memory:true,bin:'qoderclicn'})` | CN → `QODERCN_MEMORY_HEADLESS=1`，且不设 `QODER_MEMORY_HEADLESS`；intl 反之 |
| 默认目录 | `~/.qoder-cn/settings.json` / `~/.qoder/settings.json` | 两者均存在且含 providers；默认路径下 `/model` 自定义模型读取正常 |

### 1.3 验证口径与未复核项

- **已独立复核**：CN CLI 版本、空清单哨兵、默认模型清单、桥接 `listSessions`、画像/记忆 env、默认配置目录读取。
- **未独立重复**：真实 `runQoder` prompt 往返、CN 记忆行为探针。上一版 review.md 记录“2026-11-19 主人登录后七项全部实测通过”，但仓库没有独立的 `verification.md` 复核记录；本轮为避免消耗额度/写入用户数据没有重跑。若主人信任上一轮记录，R1 视为关闭；否则建议合并前补一次最小往返。
- **环境注意**：本轮非登录 shell 的 PATH 不含 `/usr/local/bin`，按名调用 `qoderclicn` / `qodercli` 会 `ENOENT`，用绝对路径正常。这不影响代码正确性，但直接影响 launchd 示例（见 P2-3）。
- **临时目录**：本轮创建的 `/tmp/qwb-cfgtest`、`/tmp/qwb-review-empty` 已清理；上一版留下的 `/tmp/qoderclicn-probe`（约 117MB）与 `/tmp/qwb-cn-accept`（约 12KB）仍在，待主人确认清理。

---

## 2. 需求覆盖矩阵

| 需求 | 实现位置 | 守护用例 / 证据 | 状态 |
|---|---|---|---|
| 1.1 CN 画像 | `src/bridge/backend.ts` | `backend.test.ts` CN 主程序/dispatcher/绝对路径 | ✅ |
| 1.2 intl 画像 | 同上 | `backend.test.ts` intl | ✅ |
| 1.3 未知 bin 回落 | `backend.ts` `INTL_PROFILE` | `backend.test.ts` `my-wrapper` / `qoder` / 空串 | ✅（R2 局限已写 README） |
| 1.4 配置目录覆盖优先 | `src/models.ts:23-25` | `models.test.ts` 仅覆盖 intl；CN 未覆盖 | ⚠️ **P1-1** |
| 1.5 纯函数、不探测 | `backend.ts` 仅 `node:path` | 模块无 CLI 调用 | ✅ |
| 2.1 CN 记忆开关 | `cleanEnv` `memoryEnv` | `qoder.test.ts` CN 互斥 + env-probe 子进程 | ✅ |
| 2.2 intl 记忆开关 | 同上 | `qoder.test.ts` intl 互斥 | ✅ |
| 2.3 memory=false 不设 | 同上 | `qoder.test.ts` | ✅ |
| 2.4 双前缀剥离 | `cleanEnv` | `qoder.test.ts` `QODER_*`/`QODERCN_*` 双剥 | ✅ |
| 2.5 全调用路径清理 | `sessions.ts` ×3、`models.ts` ×1、`runQoder` | 设计 D3：不传 bin 只影响记忆开关（未开启），双剥无条件生效；调用方均用 `cleanEnv` | ✅（preflight `--version` 未枚举，见 §5 观察） |
| 3.1 CN 自定义模型目录 | `models.ts` 默认 `.qoder-cn` | `models.test.ts` 临时目录 + 唯一 provider | ✅ 默认路径；⚠️ 覆盖路径 P1-1 |
| 3.2 intl 默认目录 | `models.ts` 默认 `.qoder` | `models.test.ts` | ✅ |
| 3.3 内置模型不混后端 | `listBuiltinModels(bin)` | 走当前 bin `--list-models`；CN/intl 实测 14/17 内置 | ✅ 默认；⚠️ 覆盖路径 P1-1 |
| 3.4 缓存按 bin 隔离 | `models.ts` `cache.bin` | 代码成立；`models.test.ts` 用例被缓存泄漏削弱 | ✅ 生产行为；P2-2 测试质量 |
| 3.5 缺失/损坏降级 | `listCustomModels` | `models.test.ts` 损坏 settings → 空自定义 + Auto | ✅ |
| 4.1 指针写 bin | `service.ts:646`、`switch.ts:49` | `service.test.ts`、`commands-session.test.ts` | ✅ |
| 4.2 跨后端不续接 | `config.ts` `activeSession` kind 比较 | `config.test.ts` 8 例；`service.test.ts` 跨后端 | ✅（D1 字面差异见 §6） |
| 4.3 存量无 bin 视为 intl | `activeSession` `?? DEFAULT_CONFIG.qoderBin` | `config.test.ts` intl/CN 两向 | ✅ |
| 4.4 跨后端 turns 从 1 | `service.ts` `(record?.turns ?? 0)+1` | `service.test.ts` | ✅ |
| 4.5 旧指针被覆盖 | 成功写新指针 | `service.test.ts` | ✅ |
| 4.6 六命令当前后端可用 | status/sessions/switch/rename/delete/model | `commands.test.ts`、`commands-session.test.ts`；`delete.ts` 本就传 `config.qoderBin` | ✅ |
| 4.7 同后端续接不变 | `activeSession` kind 相同即返回 | `service.test.ts` 存量/同后端 | ✅ |
| 5.1 failure/sessions 中性化 | `failure.ts` 7 处 + `sessions.ts` 4 处 | `failure.test.ts`、`sessions.test.ts` | ✅ |
| 5.2 日志可保留原文 | 未改诊断/日志命令原文 | 既有用例 | ✅ |
| 5.3 预检提示含实际 bin | `service.ts:999-1001` / `1195-1200` | 仅断言含 `qoder_missing` | ❌ **P1-2** |
| 6.1 `/status` 后端行 | `commands/status.ts:15` | `commands.test.ts` 两例 | ✅ |
| 6.2 启动日志画像 | `service.ts:1224-1226` | `service-startup.test.ts` 断言 bin/backend/memoryEnv | ⚠️ 缺配置目录 **P2-1** |
| 6.3 下行额度 | 单行追加 | 长度约 15 字符 | ✅ |
| N1 国际版零回归 | 默认 `qoderBin='qodercli'`；存量无 bin | 全量 530 绿；`service.test.ts` 存量用例 | ✅ |
| N2 零新依赖 | diff 无 `package.json` 依赖变更 | `backend.ts` 仅 `node:path` | ✅ |
| N3 隐私 | 画像只涉 env 名/目录名 | 无凭据读取 | ✅ |
| N4 可观测 | 切换 log.info + 启动日志 | 有日志；配置目录字段缺口见 P2-1 | ⚠️ |

---

## 3. 正确性属性覆盖

| 属性 | 证据 | 状态 |
|---|---|---|
| 1 画像纯函数与回落 | `backend.test.ts` 8 例；模块仅 import `node:path` | ✅ |
| 2 配置目录覆盖优先 | `models.test.ts` 仅 intl 覆盖；CN 覆盖未测，且 env 名错误 | ⚠️ **P1-1** |
| 3 记忆开关互斥 | `qoder.test.ts` CN/intl 互斥 + 子进程 env-probe | ✅ |
| 4 双前缀剥离全路径 | `cleanEnv` 双剥用例；sessions/models 调用方共用 | ✅ |
| 5 模型隔离与降级 | 默认 CN/intl 隔离、损坏降级；缓存用例被 P2-2 削弱；覆盖路径可混后端 | ⚠️ P1-1 / P2-2 |
| 6 指针必带 bin | `service.test.ts`、`commands-session.test.ts` | ✅ |
| 7 跨后端不续接/同后端不变 | `config.test.ts` 8 例 + `service.test.ts` 4 例 | ✅ |
| 8 文案不改语义 | `failure.test.ts` / `sessions.test.ts`；归类/截断/去重未动 | ✅（预检告警另见 P1-2） |
| 9 切换可观测 | `/status` 行 + 启动日志三字段 | ⚠️ 配置目录字段缺 **P2-1** |
| 10 国际版零回归与隐私 | 530 绿；存量 state 用例 | ✅ |
| 11 零新增依赖 | diff 无依赖变更 | ✅ |

---

## 4. 主要问题（P1）

### P1-1 配置目录覆盖链路不成立：CN 用错 env 名，且 `cleanEnv` 把覆盖变量剥掉

**结论：需求 1.4 / 3.1 的事实前提有误。实现只完成了“默认目录按后端”，没有完成“覆盖目录优先且 CLI 可见”。**

**证据 1：CN 包静态结构（`@qodercn-ai/qoderclicn@1.1.92`）**

- `Gu="QODERCN_"`，`yo(A) = Gu + A`，`MLe = yo("CONFIG_DIR")` → **`QODERCN_CONFIG_DIR`**；`hi()` 用 `Hh(MLe)` 解析全局配置目录。
- `QODER_CONFIG_DIR` 在 CN 包是 `ZVt = DC("CONFIG_DIR")`，出现在 skill 路径替换（`${QODER_CONFIG_DIR}`）等位置，不是全局配置目录的入口。

**证据 2：真机对照（本机 1.1.92）**

- `QODER_CONFIG_DIR=<含 providers 的临时目录> qoderclicn --list-models` 仍列出默认 `~/.qoder-cn` 的 8 条自定义模型 → **CN 忽略该变量**。
- `QODERCN_CONFIG_DIR=$HOME/.qoder-cn qoderclicn --list-models` 正常列出 8 条；指向临时副本则报 `Not logged in` → **它确实切换了配置目录**（副本缺登录态）。
- 国际版 `qodercli` 相反：`QODER_CONFIG_DIR` 生效（withprov 8 / noprov 0），`QODERCN_CONFIG_DIR` 不生效。

**证据 3：代码链路**

- `src/models.ts:23-25` 无条件读 `process.env.QODER_CONFIG_DIR`，没有按后端选择变量。
- `src/models.ts:37` 与 `src/bridge/qoder.ts:98-113` 的 `cleanEnv` 会删除 `QODER_*` 与 `QODERCN_*`；CLI 子进程看不到覆盖变量。
- 实测：设 `QODER_CONFIG_DIR=<sentinel provider 目录>` 后，`listModels('/usr/local/bin/qodercli')` 与 `listModels('/usr/local/bin/qoderclicn')` 都列出 `sentinel-xyz/sentinel-model`；同一 `cleanEnv()` 下 CLI `--list-models` 看不到 sentinel。也就是说，**桥接侧列表与 CLI 实际可用模型可能不一致**。
- CN 后端还会把 `QODER_CONFIG_DIR` 指向的任意/国际版 provider 混入 `/model`，违反 3.1/3.3。

**证据 4：文档/设计同样写错**

- `requirements.md` 术语表/1.4/3.1、`design.md` §1.2/§5.1.4/正确性属性 2、`RUNBOOK.md:167` 都写“两版通用”；README CN 节只写了默认 `~/.qoder-cn/settings.json`，没有覆盖面。上一版 review.md 的“配置目录覆盖优先”证据只覆盖了国际版 `QODER_CONFIG_DIR`，未覆盖 CN。

**影响**

- 默认路径（不设覆盖）下 CN/intl 均正常，这是当前实现的主要收益。
- 设覆盖变量迁移配置的用户会遇到 `/model` 与 CLI 不一致，甚至跨后端混列；属于 P0 需求 1.4/3.1 的验收缺口。Qoder Desktop shell 若继承 `QODER_CONFIG_DIR`，也可能在切换后端时把旧后端目录带进来。

**建议（二选一，需主人确认）**

- **方案 A（推荐，保留 1.4 承诺）**：`qoderConfigDir(bin)` 按后端选变量（CN `QODERCN_CONFIG_DIR`，intl `QODER_CONFIG_DIR`；trim，空串视为未设置）；把解析后的目录作为 `cleanEnv` 的可选参数补回子进程（或提供等价的 CLI 参数），让任务/会话/模型四条路径看到同一目录；补 CN/intl 覆盖测试；修正 requirements/design/RUNBOOK。
- **方案 B（缩小承诺）**：明确覆盖变量只影响桥接侧 `models.ts` 读取，不影响 CLI 子进程；修正 1.4/3.1 和文档，并写明“迁移配置目录需保证 CLI 自身可见，或使用默认目录”。这样 P1-1 降级为已知限制，但不能继续声称“两版通用/覆盖优先”。

**补充**

- 无论 A/B，`QODER_CONFIG_DIR=''` / `QODERCN_CONFIG_DIR=''` 的空串都应视为未设置；当前 `??` 会得到相对路径 `settings.json`，可能误读 bridge cwd 下的文件。
- 若选 A，`cleanEnv` 只补回当前后端对应的变量，不要无条件保留 `QODER_*`，避免桌面 shell 的 SDK worker 变量重新泄漏。

### P1-2 预检失败的用户告警仍写死 `qodercli`，失败日志也没有实际 bin / detail

**结论：需求 5.3 与成功标准“用户可见错误文案不再写死 qodercli”未闭环。**

**证据**

- `src/bridge/service.ts:999-1001`：

  ```ts
  return `本机 Qoder 环境异常：${kinds}。已记录日志，请检查 Node / qodercli。`.slice(0, 300);
  ```

  `service.ts:1209` 把它发给 owner（`sendTextFn`），是用户可见文案。
- `service.ts:1195-1200` 的 `log.error` 只记录 `failure.kind`；`qoderPath` 在 bin 缺失时为空字符串；`failures[].detail`（含 `input.qoderBin`，例如 `找不到可执行的 qoderclicn`）没有被记录。
- `test/unit/service-startup.test.ts:310-313` 只断言告警包含 `qoder_missing`，没有断言 bin 或中性称呼。
- 结果：CN 预检失败时，用户看到“qodercli”；日志也看不到“qoderclicn”。既不符合需求 5.3“预检失败提示 SHALL 仍包含实际配置的 bin 名”，也不符合 D7“文案统一 Qoder CLI”，是两种口径的中间态。

**影响**

- 低频但关键：预检失败通常意味着服务起不来，用户会按提示去查/登录错误的 CLI；日志缺少实际 bin 也让排查变慢。

**建议**

- 给 `formatPreflightAlert` 传入 `config.qoderBin`（或用 `preflight.failures[].detail`），输出实际 bin；`log.error` 增加 `qoderBin` 与 `details`（截断/脱敏）；补 CN 用例断言告警含 `qoderclicn` 且不含硬编码 `qodercli`。
- 若主人希望 D7 的“中性称呼”优先，则改为“请检查 Node / Qoder CLI”，并同步修订需求 5.3 的措辞——但不能保持现在的硬编码。

---

## 5. 次要问题（P2）

### P2-1 启动日志缺“配置目录”字段

- 需求 6.2 要求启动日志记录“当前后端 bin 与推导出的画像（记忆开关 env 名、**配置目录**）”。
- `service.ts:1224-1226` 只有 `qoderBin` / `backend` / `memoryEnv`；`service-startup.test.ts:127-129` 也只断言这三项；`design.md §5.1.5` 的字段清单同样漏了。
- 建议：加 `configDir: backendProfile(config.qoderBin).configDirName`（若 P1-1 选 A，则记录解析后的绝对目录）并补断言。

### P2-2 `models.test.ts` 模块级缓存未清理，最后一个用例证明力不足

- `models.ts` 的 `cache` 是模块级；`models.test.ts` 的 `beforeEach` 只换 `os.homedir` / 临时目录，不重置 cache。
- 用例顺序：`CN 后端默认读 ~/.qoder-cn` 先缓存 `bin='qoderclicn'`；最后一个 `缓存按 bin 隔离` 再次调用 `listModels('qoderclicn')` 会命中旧缓存。两个用例又都用 `pcn/m-cn`，所以即使新目录没被读取，断言也会通过。
- 生产缓存按 bin 隔离本身符合需求 3.4；这是**测试有效性**问题。建议导出测试专用 `clearModelCache()` 或 `vi.resetModules()`，并用唯一 provider id 断言新目录确实被读取；同时补一条同 bin 缓存命中/失效的显式用例。

### P2-3 README launchd 示例未保证 PATH，按名调用可能失败

- README CN 节的 plist 示例只设 `QWB_QODER_BIN=qoderclicn`。launchd 默认 PATH 通常不含 `/usr/local/bin`；本轮非登录 shell 的 PATH 也不含，按名 `execFileSync('qoderclicn')` 直接 `ENOENT`，绝对路径正常。
- 建议：plist 示例改用 `QWB_QODER_BIN=/usr/local/bin/qoderclicn`，或同时设置 `PATH`；RUNBOOK 的“bin 名须为 … 或绝对路径”应和示例保持一致。默认 `qodercli` 也有同样问题（存量），CN 新用户更容易踩。

### P2-4 CLI help 与 README 通用排障仍有 `qodercli` 残留

- `src/cli.ts:53`：`--qoder-bin <path> qodercli 路径（默认 qodercli）`，未提 CN 版。
- `README.md:228` / `README.md:242`：通用排障仍只说 `qodercli login`；CN 用户按图索骥会跑错命令。
- 建议：CLI help 补“CN 版 qoderclicn”；排障改成“本机执行对应后端的登录命令（国际版 `qodercli login` / CN `qoderclicn login`）”。这不是需求 5.1 的代码文案，但属于本次 CN 支持的使用者文档一致性。

### P2-5 `activeSession` 对 `record.bin` 无类型防御（低概率）

- `normalizeState` 原样透传 `sessions`；`activeSession` 直接 `backendProfile(record.bin ?? DEFAULT_CONFIG.qoderBin)`。
- 若 state.json 被手改成 `bin: 123` / 对象，`path.basename` 会抛 `TypeError`，影响每条入站消息。建议：
  ```ts
  const recordBin =
    typeof record.bin === 'string' && record.bin.trim() ? record.bin : DEFAULT_CONFIG.qoderBin;
  ```
- 低概率但修复成本低；不属于本次阻断项。

---

## 6. 已确认无问题的口径

以下检查过、**不构成缺陷**，避免后续重复讨论：

1. **`sessions.ts` ×3 与 `models.ts` ×1 调用 `cleanEnv()` 未传 bin**：设计 D3 明确这是故意的。它们不开启 memory，`bin` 只影响记忆开关；双前缀剥离是无条件生效的，所以需求 2.5 的“双前缀清理”满足。若 P1-1 选方案 A，这些调用方需要把解析后的配置目录一并传入。
2. **`activeSession` 按后端 kind 比较而非原始 bin 字符串**：与设计 D1 一致，效果合理（`qodercli` ↔ 绝对路径、`qoderclicn` ↔ `qodercn` 同后端不同写法不误丢续接）。需求 4.2 字面是“bin 不一致”，实现是“kind 不一致”，属设计细化；见 §7 的批准记录待确认。
3. **`models.ts` 缓存按原始 bin 隔离**：需求 3.4 满足；切换 `qoderclicn` ↔ `qodercn` 会多一次重建，只是性能小损，不影响正确性。
4. **`/delete` 用原始 `state.sessions` 比较 id**：只用于删除当前会话后清指针；跨后端 session id 不会碰撞，未发现实际问题。
5. **`/new`、`/reset` 直接删指针**：不需要 bin；符合需求 4.6。
6. **failure/sessions 文案中性化**：`failure.ts` 7 处、`sessions.ts` 4 处已替换；错误归类、截断、去重逻辑未动，测试同步通过。
7. **`/status` 新增行长度**：约 15 字符，单条回复，未显著增加下行额度；需求 6.3 满足。
8. **国际版零回归**：默认 `qoderBin='qodercli'`，存量无 bin 指针正常续接；530 用例全绿。
9. **零新依赖 / pack 完整**：`backend.ts` 仅 `node:path`；pack 含 `dist/bridge/backend.js` / `.d.ts`。

---

## 7. 残余风险与待主人确认

1. **CN 真实 prompt 往返与记忆行为**：上一版 review.md 记录已通过；本轮未独立重复。若信任该记录，R1 关闭；否则合并前补一次最小 `runQoder` 往返与记忆探针。
2. **D1 批准记录**：`design.md` 顶部仍写“设计待评审”，但实现已按 D1（kind 比较）落地；上一版 review.md 称“已获批”。建议主人在合并前确认 D1 口径，并把设计状态更新为已批准，避免后续审计把 kind 比较当成偏差。
3. **R2 wrapper/改名局限**：自定义 wrapper、改名软链、直接指向 `bundle/qoderclicn.js` 都会回落 intl 画像；README/RUNBOOK 已写明标准名/绝对路径的约束，但 `.js` 路径这种写法没有明确覆盖。若主人使用 npm 包装路径，请改用 `/usr/local/bin/qoderclicn`。
4. **`preflight --version` 未走 `cleanEnv`**：需求 2.5 枚举的是任务/会话/模型四条路径，preflight 不在其中；本轮未发现实际影响。若后续要严格按“全部 CLI 调用路径”理解，可补一个继承变量场景的用例。
5. **node 20 + vitest 5.1.0 reporter 存量问题**：本轮用 node 24 规避；建议后续单独处理（升级默认 node 或 pin vitest 兼容版），不在本包顺手改。
6. **`models.ts` 不在覆盖率门禁**：任务 8.1 明确“沿用现状不扩大”，新逻辑有 5 条单测但不受 95% 门禁约束；这是已接受的取舍，记录备查。
7. **临时取证目录**：`/tmp/qoderclicn-probe`（约 117MB）与 `/tmp/qwb-cn-accept`（约 12KB）仍在；本轮自己的 `/tmp/qwb-cfgtest`、`/tmp/qwb-review-empty` 已清理。是否删除前者由主人确认。

---

## 8. 建议处理顺序

1. **主人先定 P1-1 的口径**：是保留“覆盖优先”承诺（方案 A），还是降级为“仅列表读取”（方案 B）。这决定是改代码 + 文档，还是只改需求/文档。
2. 若选 A：修 `qoderConfigDir` 的按后端 env + `cleanEnv` 补回 + CN/intl 覆盖测试；同步 requirements/design/RUNBOOK。
3. 修 **P1-2**：预检告警使用实际 bin（或按 D7 中性化），日志补 `qoderBin` + detail，补 CN 用例。
4. 顺手处理 P2-1（启动日志 configDir）、P2-2（测试清缓存）、P2-3（launchd PATH 示例）、P2-4（CLI help / 排障登录命令）；P2-5 可选。
5. 重跑 `npm run typecheck && npm run build && npx vitest run --coverage --maxWorkers=2 && npm pack --dry-run`。
6. 如不信任上一轮记录，补一次 CN 真实 prompt 往返 + 记忆探针，再触发合并提交。

---

## 9. 改动清单（本轮审查对象）

- **源码（10）**：`src/bridge/backend.ts`（新）、`src/config.ts`、`src/bridge/qoder.ts`、`src/models.ts`、`src/bridge/service.ts`、`src/bridge/commands/{status,sessions,switch,rename}.ts`、`src/bridge/failure.ts`、`src/bridge/sessions.ts`。
- **测试（10）**：`test/unit/backend.test.ts`（新）、`test/unit/models.test.ts`（新）、`test/unit/{config,qoder,service,service-startup,commands,commands-session,failure,sessions}.test.ts`、`test/integration/fake-ilink.test.ts`、`test/fixtures/fake-qodercli.mjs`。
- **配置/文档**：`vitest.config.ts`、`README.md`、`RUNBOOK.md`。
- **规范包**：`.specs/20261119_CLI后端兼容/`（本 review.md 覆盖上一版）。

> 本轮只写审查意见，未修改任何源码、测试或需求/设计文档。

---

## 10. 修复处置（阿程，2026-11-19，主人确认口径后）

主人拍板：**P1-1 方案 A（修通覆盖链路）**、**P1-2 用实际 bin 名**。逐条处置如下，全部经独立复证后修复，非盲从。

| 条目 | 处置 | 证据 |
|---|---|---|
| **P1-1** | 成立（阿程原"两版通用"取证错误，真机复现确认）。`backend.ts` 加 `configDirEnv` + `resolveConfigDir(bin)`（按后端认变量、trim、空串视为未设、不跨后端读）；`cleanEnv` 把解析目录补回子进程对应变量；`models.ts` 改用 `resolveConfigDir`；sessions.ts ×3 / models 内置查询 cleanEnv 均传 bin。修正 requirements 1.4/3.1/术语表/证据、design D8/属性2/§5.1、RUNBOOK §5.2、README CN 节 | backend.test.ts resolveConfigDir 7 例（CN/intl 覆盖、跨后端忽略、空串/空白、trim、默认）；models.test.ts CN 覆盖 + CN 忽略 intl 覆盖；qoder.test.ts cleanEnv 补回 3 例 + env-probe 断言 cnCfg/intlCfg 互斥；真机对照见 verification.md §2 |
| **P1-2** | 成立。`formatPreflightAlert(result, qoderBin)` 告警含实际 bin；`log.error('启动预检失败')` 增 `qoderBin` + `details`（截断 300）；调用点传 config.qoderBin | service-startup.test.ts：告警含 `Node / qoderclicn` 且不含 `Node / qodercli。`；预检失败日志断言 qoderBin + details |
| P2-1 | 启动日志增 `configDir: resolveConfigDir(config.qoderBin)` | service-startup.test.ts 启动日志断言 configDir 含 `.qoder-cn` |
| P2-2 | models.ts 导出测试专用 `clearModelCache()`；models.test.ts beforeEach/afterEach 清缓存 + 唯一 provider id；新增"同 bin 命中缓存、不同 bin 重读"显式用例 | models.test.ts 7 例全绿，隔离用例 CN 侧不再命中旧缓存 |
| P2-3 | README launchd 示例改 `/usr/local/bin/qoderclicn` 绝对路径，注明 launchd PATH 缘由与按名需设 PATH | README CN 节 |
| P2-4 | cli.ts `--qoder-bin` help 补 CN；README 两处登录排障改"对应后端登录命令" | cli.ts:53、README 228/242 |
| P2-5 | `activeSession` 对 `record.bin` 做 `typeof === 'string' && trim` 收窄 | config.test.ts 非字符串 bin（123）视为 intl 且不抛错 |
| §7.2 D1 批准记录 | design.md 顶部状态改"设计已批准（含 D1）" | design.md header |
| §1.3 真机无留档 | 新增 verification.md 落盘往返/记忆探针/P1-1 对照证据 | verification.md |
| §7.3 `.js` 路径局限 | RUNBOOK 排查节补"直接指向 bundle/qoderclicn.js 回落 intl" | RUNBOOK §5.2 |

**修复后门禁**（node 24.21.0）：`npm run typecheck` 通过；`npm run build` postbuild ok；`npx vitest run --coverage --maxWorkers=2` **30 文件 / 545 用例全绿**（较审查时 530 增 15），All files Lines **98.66%**，backend.ts 100%、白名单触达文件均 ≥95%；`npm pack --dry-run` 含 backend.js/.d.ts，81 文件。

**未处置（存量/取舍，沿用审查口径）**：node20+vitest reporter Map.groupBy（存量，node24 规避）；models.ts 不在覆盖率门禁（8.1 既定取舍）；preflight --version 未走 cleanEnv（审查 §7.4 认定无实际影响，需求 2.5 未枚举该路径）。

**待主人**：合并提交触发；临时目录（/tmp/qoderclicn-probe、/tmp/qwb-cn-accept、/tmp/qwb-verify-cfg）与验收 CN 会话清理确认；版本 bump + publish。

---

## 11. 增量复审（独立复核，2026-11-19）

> 范围：§10 修复记录对应的当前工作树；HEAD 仍 `23ead42`，改动全部未提交。只复核修复增量与回归，不重复 §1–§9 的全文审查。
> 结论：**通过（可合并）**。P1-1、P1-2 与 P2-1..P2-5 已闭环；未发现新的 P0/P1。剩余 1 个 P2 边界（相对路径覆盖）与若干 P3 文档/测试问题，不构成合并阻断。
> 口径：未重复 CN 真实 prompt 往返与记忆探针；这两项沿用 `verification.md` 的记录，本轮只独立复核 CLI 版本、默认模型清单、覆盖变量隔离与代码门禁。

### 11.1 门禁与真机复核

| 项 | 结果 |
|---|---|
| typecheck / build | 通过；`postbuild ok` |
| 全量测试 | **30 文件 / 545 用例全绿**（node 24.21.0） |
| 覆盖率 | All files Lines **98.66%**；`backend.ts` **100%**；`service.ts` 97.96%；`config.ts` 100%；`qoder.ts` 95.83% |
| 打包 | `npm pack --dry-run`：81 文件，含 `dist/bridge/backend.js` / `.d.ts` |
| 版本 | CN `qoderclicn` **1.1.92**；intl `qodercli` **1.1.89** |
| 默认模型 | intl `listModels('/usr/local/bin/qodercli')` = 25（17 内置 + 8 自定义）；CN = 22（14 + 8）；与 CLI `--list-models` 行数 26/23 对照正常 |
| 环境注入 | `cleanEnv({bin:'qodercli'})` → `QODER_CONFIG_DIR=~/.qoder`；`cleanEnv({bin:'qoderclicn'})` → `QODERCN_CONFIG_DIR=~/.qoder-cn`；互不泄漏 |
| 覆盖隔离 | `QODER_CONFIG_DIR=<sentinel>` 时 CN 仍读 `~/.qoder-cn`，8 条 CN 自定义模型，sentinel 0 命中；intl 认 sentinel（无登录态时 CLI 失败，见 11.4） |
| 未重复 | CN 真实 prompt 往返 / 记忆行为探针；`verification.md` 有记录，但本轮未重跑 |

### 11.2 修复闭环核对

| 条目 | 复核结果 | 证据 |
|---|---|---|
| P1-1 配置目录覆盖 | **闭环（绝对路径/默认路径）**；CN/intl 各认自己的变量，空串/空白回落，`cleanEnv` 补回子进程 | `backend.ts` `resolveConfigDir` + 7 例；`models.test.ts` CN 覆盖/隔离；`qoder.test.ts` 补回 3 例 + env-probe；真机隔离实测 |
| P1-2 预检告警 | **闭环**；告警含实际 `qoderBin`，失败日志含 `qoderBin` + `details` | `service.ts:999-1001,1194-1214`；`service-startup.test.ts` 两例 |
| P2-1 启动日志 | **闭环**；`configDir` 已记录 | `service.ts:1223-1228`；启动日志用例 |
| P2-2 缓存测试 | **闭环**；`clearModelCache` + beforeEach/afterEach + 唯一 provider + 同 bin/不同 bin 用例 | `models.test.ts` 7 例 |
| P2-3 launchd PATH | **闭环**；示例改绝对路径并说明 PATH | `README.md` CN 节 |
| P2-4 文案残留 | **代码/README 闭环，RUNBOOK 有残留**：CLI help 与 README 228/242 已改；`RUNBOOK.md:10/112/141` 仍写 `qodercli login` | 见 P3-2 |
| P2-5 bin 类型防御 | **闭环**；非字符串/空白回落 intl，不抛错 | `config.ts:265-274`；`config.test.ts` 新用例 |
| design 状态 / verification | **闭环**；设计状态已批准，`verification.md` 已落盘 | 文件头；§1–§4 |

### 11.3 新发现

#### P2-A（边界）相对路径覆盖会破坏“`/model` 与 CLI 一致”

- `resolveConfigDir` 的 JSDoc 声明返回“绝对路径”，但实现直接返回 `override`（`src/bridge/backend.ts:59-62`）。实测 `QODER_CONFIG_DIR=relcfg` 时返回 `"relcfg"`，`cleanEnv` 原样传给子进程。
- `models.ts` 以桥接进程 cwd 读 `relcfg/settings.json`；`runQoder` 子进程的 cwd 是 `input.cwd`（或 home，`src/bridge/qoder.ts:215-217`），CLI 会在**另一个目录**解析同一个相对路径。两者可能读到不同配置，正是 P1-1 要消除的不一致。
- 影响仅限相对路径覆盖；默认目录和绝对路径（文档示例都是绝对路径）不受影响。建议 `path.resolve(override)`（若要支持 `~` 再单独展开），并补一条相对路径测试；或在文档明确“覆盖值必须是绝对路径”并校验拒绝。**不阻断合并**，但建议合并前定口径。

#### P3-1 JSDoc / 模块注释小缺口

- `formatPreflightAlert(result, qoderBin)` 新增了 `qoderBin` 参数，但 JSDoc 只有 `@param result`（`src/bridge/service.ts:994-999`），不符合本项目 JSDoc 约定。
- `src/bridge/backend.ts:1-4` 仍写“纯函数，零运行时探测”，但同模块的 `resolveConfigDir` 会读 `process.env` 与 `os.homedir()`；建议改成“backendProfile 为纯函数；resolveConfigDir 读取 env/home，不执行 CLI”。

#### P3-2 RUNBOOK 通用排障仍有 `qodercli` 残留

- `RUNBOOK.md:10`（环境要求）、`:112`（`Not logged in` 行）、`:141`（`auth` 行）仍写 `qodercli login`。CN 用户从通用排障表进入时可能执行错命令；§5.2 虽已补 CN 专节，但通用行仍应改成“对应后端登录命令（国际版 `qodercli` / CN `qoderclicn`）”或链到 §5.2。
- README 的 `qodercli --version` / quickstart `qodercli login` 属国际版默认路径，可保留。

#### P3-3 新增测试的环境隔离与传递断言可再加固

- `backend.test.ts` 只在 `afterEach` 清理 `QODER*`；`qoder.test.ts` 新增环境用例在测试体末尾 `delete`；`service-startup.test.ts` 的 `configDir` 断言依赖真实 home。若开发者/CI 预设了 `QODER_CONFIG_DIR` 或 `QODERCN_CONFIG_DIR`，默认目录断言可能失败；断言失败时测试体末尾的清理也不会执行。建议统一 `beforeEach` 清理或用 `vi.stubEnv`/`vi.unstubAllEnvs`。
- `models.test.ts` 的 `execFileSync` mock 未断言 `env`，`sessions.test.ts` 也没有子进程 env 断言；目前“sessions/models 传 bin 给 cleanEnv”只有代码审查保障，建议补一条 fake CLI `env-probe` 断言（至少 listSessions 或 models 内置查询之一）。

#### P2-B（需求层待确认，非本次修复引入）`cleanEnv` 剥离全部 `QODERCN_*`

- 需求 2.4 明确要求剥离 `QODER_*` 与 `QODERCN_*` 全部变量；但 requirements 同一页也说明 `QODERCN_*` 系列用于 VPC 端点、服务账号、客户端类型。当前 `cleanEnv` 剥离后只补回记忆开关与配置目录，若 CN 部署依赖这些环境变量，任务/模型查询会丢失。
- 这不是 P1-1 修复引入的（双前缀剥离在修复前已存在并被上一轮接受），但建议主人确认：若实际使用 env 配置 CN VPC/服务账号，需要白名单或显式透传；若没有，按需求 2.4 接受并可在文档写明。

### 11.4 已核对、不构成缺陷

- **覆盖目录无登录态**：此时 CLI 本身会失败；桥接 `/model` 可能降级为 `Auto` + `settings.json` 里的自定义模型。文档已提示覆盖目录需含登录态，属可接受取舍。
- **`models.ts` 缓存按原始 bin 隔离**：切换 `qoderclicn` ↔ `qodercn` 会多一次重建，不影响正确性；需求 3.4 满足。
- **`preflight --version` 未走 cleanEnv**：需求 2.5 枚举的是任务/会话/模型路径，未包含预检；本轮未发现实际影响。
- **`formatPreflightAlert` 签名变更**：未从 `src/index.ts` 导出，不是公开 API 破坏。
- **`qoder.ts` 行覆盖 95.83%**：仍过 95% 门禁；未覆盖的 221/324-325 是既有取消/销毁管道分支，不是本次新增行。
- **`models.ts` 不在 coverage include**：沿用 8.1 的既定取舍；新逻辑有 7 例直接单测，但无门禁兜底，建议后续单独处理。

### 11.5 最终结论

**通过，可合并。** 本轮没有新的 P0/P1；P1-1 与 P1-2 已闭环，P2-1..P2-5 在代码/默认路径/README 层面闭环。合并前建议（均非阻断）：

1. 处理或明确拒绝 **P2-A** 相对路径覆盖；若拒绝，文档写“必须绝对路径”并加校验/测试。
2. 修 **P3-2** RUNBOOK 三处登录命令，避免 CN 用户按图索骥。
3. 补 **P3-1** JSDoc/模块注释；按需处理 **P3-3** 测试隔离与 env 断言。
4. 请主人确认 **P2-B** 的 CN `QODERCN_*` VPC/env 使用场景；无依赖则关闭。

CN 真实 prompt 往返与记忆探针本轮未重跑，沿用 `verification.md`；若合并前需要“本轮亲自复证”，再补一次最小往返即可。

---

## 12. 增量意见处置（阿程，2026-11-19，主人确认口径后）

主人拍板：**P2-A 用 `path.resolve` 修通**、**P2-B 无 VPC/env 依赖，接受双剥 + 文档注明**。§11 非阻断建议全部处理：

| 条目 | 处置 | 证据 |
|---|---|---|
| **P2-A** 相对路径覆盖 | `resolveConfigDir` 改 `override ? path.resolve(override) : 默认`，相对值统一按桥接进程 cwd 解析成绝对，CLI 子进程拿绝对路径即一致；JSDoc 注明不展开 `~` | backend.test.ts 新增"相对路径解析为绝对"用例（`path.resolve('relcfg')` + isAbsolute） |
| **P2-B** 剥全部 QODERCN_* | 主人确认个人 OAuth 登录、无 VPC/服务账号 env 依赖；按需求 2.4 接受双剥，RUNBOOK §5.2 加"不支持 env 配置 VPC/服务账号"说明 | RUNBOOK §5.2 引用块 |
| P3-1 JSDoc | `formatPreflightAlert` 补 `@param qoderBin`；backend.ts 模块注释改"backendProfile 纯函数；resolveConfigDir 读 env/home，不执行 CLI" | service.ts / backend.ts 注释 |
| P3-2 RUNBOOK 残留 | 第 10/112/141 行登录命令改"对应后端（国际版 qodercli login / CN qoderclicn login）"，环境要求表含双后端 | RUNBOOK |
| P3-3 测试加固 | backend.test.ts 加 beforeEach 清 env；qoder.test.ts / service-startup.test.ts 全局 afterEach/beforeEach 清 `QODER*_CONFIG_DIR`（断言失败也清理）；models.test.ts 新增"内置查询把后端配置目录传给子进程 env"断言 | 三测试文件 |

**处置后门禁**（node 24.21.0）：typecheck / build（postbuild ok）/ pack（81 文件）通过；`npx vitest run --coverage --maxWorkers=2` **30 文件 / 547 用例全绿**（较 §11 的 545 增 2），backend.ts Lines 100%，白名单均 ≥95%。

**结论**：§11 的"通过（可合并）"维持，非阻断建议已全部落地。待主人触发合并提交；临时目录与验收 CN 会话清理待确认。
