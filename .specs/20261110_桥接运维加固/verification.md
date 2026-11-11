# 验收记录：桥接实例互斥

> 对应规范：`.specs/20261110_桥接运维加固/`
> 基线：`HEAD = 01e03c1` + 未提交工作区改动（分支 `feat/20261110-bridge-hardening`）
> 记录时间：2026-11-10（第三轮审查修复后更新）
> 审查输入：`review.md` 第一轮（Block 5 / 欠账 7 / 文档 9）、第二轮（Block 1 / Important 7 / 文档冲突 5）、第三轮（Important 2 / Minor 4）

## 1. 门禁结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（exit 0） |
| `npm run build` | 通过（`tsc` + `postbuild ok`） |
| `npx vitest run` | **22 文件 / 385 用例全过** |
| `npx vitest run --coverage` | All files Lines **98.46%**；`instance-lock.ts` Lines **100%**（Stmts 98.86 / Branch 84.92 / Funcs 100）；`service.ts` Lines 98.2%；`lifecycle.ts` Lines 97.63% |
| `node scripts/check-publish.mjs` | 通过（`@jcyao/qoder-wechat-bridge@0.4.0`） |
| `npm pack --dry-run` | 90.6 kB / 57 files，含 `dist/cli.js` |
| `node scripts/verify-instance-lock.cjs` | **14 项全过**（真实双进程；已隔离 `HOME`，见 §4） |

Branch 覆盖率未达 95% 的原因见 `design.md` 8.3：IO 失败分支依靠 `vi.spyOn` 逐条注入，组合无法穷举，已由错误处理用例逐条覆盖。

## 2. 第一轮问题闭环（第二轮复核）

| 编号 | 结论 | 证据 |
| --- | --- | --- |
| B1 释放时机 | 已修；第二轮继续收口超时路径 | `stop()`/信号统一走 `shutdown()`：取消任务 → 排空（共享 promise，上限 3s）→ **排空成功才释放**；用例「停止时等待在途任务结束再释放锁」「排空超时时保留锁而不是带着未完成任务释放」 |
| B2 同进程假阳性 | 已修 | `test/fixtures/instance-lock-contender.mjs` + 真实双进程用例 |
| B3 特征漏判 | 已修 | 仅 `!alive` 才接管；存活但特征不符记 error 后等待；支持 `node --inspect` / `env node` / `npm exec` |
| B4 missing 忙等 | 已修 | deadline + `await sleep(pollMs)` |
| B5 测试污染 | 已修 | 集成用例 `HOME` 隔离 + 注册表清空断言 |
| R1~R7 | 已修 | 见第一轮记录；新增实际 `waitedMs`、共享/重算 deadline、启动 try 覆盖、botId 告警 |
| D1 run.json 兜底 | 已实现 | 无锁 + `run.json` 指向存活桥接进程 → 拒绝；陈旧 → 清理；真机见 §3 |
| D2~D11 | 已修 | 需求/设计/任务/backlog 口径已对齐 |

## 3. 第二轮问题闭环

| 编号 | 结论 | 证据 |
| --- | --- | --- |
| B1 残余：排空超时释放锁 | 已修 | `shutdown()` 在 `drain()` 返回 false 时**保留锁**并记 error；`stop()` 等 `runLoop` 收敛；`isStopping`/`canPersist` 双重门禁（入站与落盘）；新增「任务时长 > 排空上限」用例断言锁仍在、日志含「保留实例锁」 |
| I-1 保守接管无自愈出口 | 已修（提示级） | `AlreadyRunningError.lockFile` + CLI 输出 `rm "<lockFile>"`；不做按时间自动接管（风险见设计 §9） |
| I-2 run.json 与锁判定方向 | 文档披露 | 设计属性 9 说明「提示源 vs 权威源」的刻意不对称 |
| I-3 missing 分支空转 | 已修 | 补 `await sleep(pollMs)` |
| I-4 登录前起算 deadline | 已修 | bot 锁 deadline 在登录后重算；需求 4.2 改为每把锁 5s |
| I-5 半写锁可被抢 | 已修 | 临时文件写完 + `link(2)` 原子挂载；短写 `ENOSPC` fail-closed；不支持硬链接回退 `O_EXCL`；覆盖率用例覆盖三条分支 |
| I-6 跨进程余量 | 已修 | 成功方持锁 5s，超时 kill 子进程 |
| I-7 backlog 无证据断言 | 已修 | 改为「受 iLink 契约限制」，不再声称已实现 |
| Minor（corrupt 分支 / cli.js 收紧 / stop API / 6.2 warn / 验证脚本） | 部分修，第三轮收口 | corrupt 分支收窄、`cli.js` 仅识别 `dist/` 下、设计登记 `stop()` 异步化、接管 warn 断言均已落地；**脚本当时只是入库、并未隔离 `HOME`**（仍读写真实注册表目录），第三轮才真正隔离；CLI 拒绝启动退出码由脚本「第二个真实进程被拒绝启动 — exit=1」以真实进程覆盖，仓内仍无 `cli.ts` 单测 |
| M-1~M-5 | 部分修，第三轮收口 | 第二轮把 `design.md` 的 deadline（共享 / ≤5s）、原子占用动作（`open('wx')`）、锁内容（botId 哈希 vs 明文）、常量名 `LOCK_POLL_MS`、§3.1 launchd 样例缺 `rm` 行，以及需求 1.4 与术语表「陈旧」定义的冲突留下 5 处未同步；第三轮逐条改写，见 §5 |

## 4. 真机验证（不中断常驻服务）

**V1 升级窗口 / D1 兜底**：保持 launchd 实例（pid 85391，0.3.0）运行，执行新构建的 `node dist/cli.js run`。

```
ERROR 拒绝启动：run.json 指向运行中的旧版本实例
已在运行：pid 85391（launchd：com.jcyao.qoder-wechat-bridge）
状态目录：/Users/joke/.local/state/qoder-wechat-bridge
启动时间：2026-11-06T06:17:05.338Z
工作目录：/Users/joke
如确认没有实例在运行，可删除记录文件后重试：
  rm "/Users/joke/.local/state/qoder-wechat-bridge/run.json"
exit=1
```

- 拒绝后真实状态目录**无 `run.lock` 残留**（`ls *.lock` 前后均无匹配），`run.json` 仍为 `Nov 6 14:17` 未被改动，原实例 pid 85391 存活。
- 说明：`state.json` 的 mtime 会由在跑实例的正常轮询持续更新，与本次拒绝无关；判定依据是「无锁残留 + run.json 未变 + 退出码 1」。

**跨进程与接管链**：`node scripts/verify-instance-lock.cjs`（先 `npm run build`）以两个真实 `node dist/cli.js run` 子进程复验 14 项，全部通过，含「陈旧锁被新进程接管」（`lock.pid` 由被杀进程切到新进程）、「跨状态目录同一 bot 被拒绝」、「启动期 SIGTERM 后锁已释放」。

**脚本隔离修复的实测证据**（第三轮）：脚本原先只隔离 `QWB_CONFIG_DIR` / `QWB_STATE_DIR`，bot 锁走 `os.homedir()`，因此会污染真实注册表目录——修复前该目录 mtime 为 `22:17:58`（正是旧脚本跑过一次留下的）。补上临时 `HOME` 后重跑，14 项全通过且真实目录 mtime **仍为 `22:17:58` 不变**，隔离生效。

## 5. 第三轮问题闭环

| 编号 | 结论 | 证据（先 RED 后 GREEN） |
| --- | --- | --- |
| N-1 停止后队列任务照常执行 | 已修 | RED：`expected 2 to be 1`——两条消息同批入队，SIGTERM 后第二条仍进入 `runQoder`。修复：`processTask` 入口 `isStopping` 门禁。用例「应该在停止后不再执行队列中未启动的任务」 |
| N-2 排空超时后无补释放、`stop()` 契约失实 | 已修 | RED：`expected true to be false`——任务落定后锁仍存在。修复：`drain()` 抽出真实排空 promise，`shutdown()` 超时分支挂补释放；同步改写 `BridgeHandle.stop` 契约注释与「finally 会再取消一次」的失实注释。用例「应该在排空超时后的任务落定时补释放实例锁」；原「排空超时时保留锁」用例中 250ms 后「锁仍在」的断言固化的正是本缺陷，已改为只断言超时当下保留 |
| N-3 停止门禁无仓内测试 | 已修 | 新增「应该在停止后丢弃已拉取但尚未交给 Qoder 的消息」：断言附件下载计数为 1、`runQoder` 调用为 0；`service.ts` Lines 由 97.8% 升至 **98.2%** |
| 丢弃策略未写入任何面向使用者的文档 | 已修（主人拍板：属正常行为） | 需求新增 2.7；设计 §4.3 增策略段；RUNBOOK §3「实例互斥与重启重叠」+ §5 四行排错；README 两条 FAQ |
| 验证脚本污染真实注册表目录 | 已修 | 见 §4 的 mtime 前后对照 |
| N-4 tmp 残留、N-5 建议句顺序、N-6 drain 默认值 | 记入文档 / 不改码 | tmp 残留写入设计 §5.2 与需求非目标；`describeOwner` 建议句仍先给 `stop`，`rm` 行由 CLI 追加（真机输出可见，顺序不影响可操作性）；`drain()` 在 runtime 未创建时返回 `true` 属实但不可达（赋值早于主循环启动），保留 |
| M-1~M-5 文档口径 | 已修 | 需求术语表拆为「存活实例 / 陈旧锁 / 陈旧运行记录」，1.4 与 2.3 措辞、2.7 新增、4.2 量化「每把锁 5s、整次上界约 10s」；设计 §1.2 原子性与接管、§3.1 补 `rm` 行、§4.3 释放顺序与补释放、§5.1.1 `link(2)` 占用与 `DEFAULT_POLL_MS`、§5.2 锁内容与 tmp、属性 8 补补释放、§9 风险表新增保留锁停机窗口 |

**本轮未覆盖的残余**：`service.ts` 未覆盖行 `1079-1080`（`drain` 的 catch）、`1331`（补释放的 catch）、`126/252/416`；`instance-lock.ts` Branch 84.92%。两处 catch 属防御分支，构造成本高，未强行加测。

**需求 4.2 口径变更说明**：第二轮曾要求「两阶段共享 5s」，第三轮实现改为「每把锁各 5s、登录不占预算」——共享预算会被扫码登录吃掉导致 bot 阶段零重试（第二轮 I-4）。本轮把真实上界「约 10s」写进需求与设计风险表，而非维持原先的「整次 ≤5s」表述。

## 6. 未执行 / 未覆盖

| 项 | 原因 |
| --- | --- |
| V2 `kill -9` **launchd 实例**后观察接管 | 未执行，且按现环境**测了也不算数**：全局安装的仍是 0.3.0，launchd 拉回来的旧版不写锁，无法验证新版接管。等效链路已在隔离 `HOME`/状态目录下用真实双进程验证（§4「陈旧锁被新进程接管」）。若要真机复现需先 `launchctl bootout` + 重装新版，属一次性人工操作 |
| V4 真机 drain 与游标比对 | 未执行；排空、保留锁与补释放三条路径已用单测覆盖（§5），真机需停服重启并比对 `get_updates_buf` |
| Windows 行为 | 仅在 macOS 验证；设计已写明平台差异 |
| bot 锁定期回收 | 明确列为非目标 |
