# 验证记录：微信会话管理（A 期·核心切换组）

> 日期：2026-11-14 ｜ 分支：`feat/20261114-wechat-sessions` ｜ 验证由阿程跑本地命令，微信真人验收归主人

## 1. 命令与结果

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（tsc --noEmit 无错误） |
| 构建 | `npm run build` | 通过（postbuild ok） |
| 全量测试 + 覆盖率 | `npx vitest run --coverage --maxWorkers=2` | **492 用例全绿，28 文件**（含 T8.3 修复、T9 /delete、/delete 增量审查修复）；exit=0 |
| 打包自检 | `npm pack --dry-run` | 103.1 kB / 79 files，含新模块（含 commands/delete.js） |

## 2. 覆盖率（Lines ≥ 95% 门禁）

`All files` Lines **98.58%**（Stmts 96.89 / Branch 89.78 / Funcs 97.21），门禁通过。T8.3 审查修复批次后复跑（P0-1 + P1-1~6 + Minor-1/4/5/7/8/9/11），详见 review.md §9 修复回执。

新增/触达模块 Lines：

| 文件 | Lines | 说明 |
| --- | --- | --- |
| `src/commands.ts` | 100% | 注册表枢纽 |
| `src/bridge/sessions.ts` | 100% | 清单/解析/目标/渲染/重命名 |
| `src/bridge/commands/help.ts` | 100% | |
| `src/bridge/commands/reset.ts` | 100% | |
| `src/bridge/commands/status.ts` | 100% | |
| `src/bridge/commands/model.ts` | 100% | |
| `src/bridge/commands/sessions.ts` | 100% | |
| `src/bridge/commands/switch.ts` | 100% | catch 分支已补用例 |
| `src/bridge/commands/new.ts` | 100% | |
| `src/bridge/commands/rename.ts` | 100% | catch 分支已补用例 |
| `src/bridge/commands/delete.ts` | 100% | 两步确认 + I-1 清缓存 + I-2 名称后验 |
| `src/bridge/qoder.ts` | 96.58% | name 入参分支已覆盖 |
| `src/config.ts` | 100% | sessionListLimit |
| `src/bridge/service.ts` | 97.92% | 接线/守卫/消费待用名 |

`types.ts` 为纯接口，无运行时逻辑，不纳入门禁。

## 3. 打包产物核对

`dist/bridge/sessions.js`、`dist/commands.js`、`dist/bridge/commands/{help,reset,status,model,sessions,switch,new,rename,types}.js` 均已生成并进入 tarball。

## 4. 已知环境特性（非本次回归）

- `test/unit/qoder.test.ts` 与 `test/integration/{fake-ilink,instance-lock}.test.ts` 含 spawn 子进程用例，超时阈值紧（2000ms/5000ms）。在默认 28 worker 并行 + 覆盖率插桩抢占 CPU 时偶发假超时（`timeout` 误判）。
- 取证：单独复跑这些文件全绿；`--maxWorkers=2` 限并发后全量 492 用例稳定全绿。
- 结论：属存量 timing flaky，非本次改动引入；本次未修改这些存量用例（精准修改原则）。建议后续单独评估放宽其超时或降低默认并发（列入 backlog，不在本期）。

## 5. 插件壳同步（独立仓）

- 仓：`/Users/joke/webcode/qoder-wechat-plugin`，分支 `feat/20261114-session-commands`（不写 main）。
- 已改：`skills/qoder-wechat/SKILL.md` 命令清单、`agents/qoder-wechat-setup.md` 常用命令；README 无微信命令清单，无需改。
- 状态：改动已落盘，**未提交**（按合并提交策略，待主人审查后触发）；插件版本 bump 与重装到 `~/.qoder/plugins/cache` 归主人。

## 6. 待主人真人验收

- 微信里发 `/sessions` 列会话并标活动会话；`/switch <序号>` 切换后续接；`/new 名称` 开新会话并命名；`/rename 名称` 改名。
- 任务执行中发 `/switch`/`/new`/`/rename` 被拒并提示先 `/stop`；`/sessions` 仍可用。
- 黄金路径（普通消息、`/reset`、`/status`、`/model`、`/stop`、`/help`）行为不变。

## 7. 提交状态

按主人确认的**合并提交**策略：文档 + 代码 + 单测合并，审查后由主人触发 commit（`refs #20261114`）。当前所有改动未提交，等待 8.2 审查与主人验收。

## 8. /delete 受控探针（I-3，2026-11-14，临时目录非生产）

在 `/tmp/qwb-del-verify` 创建探针会话后实测 `qodercli --delete-session`（清理 env，探针后已删除临时目录）：

```
删除前清单：  1. 只回复 ok (Just now) [29f22d30-6a58-416d-b3b0-49dc1c09c5c8]
删除序号 1：  stdout="Deleted session 1: 只回复 ok (Just now)"  exit=0
重复删序号 1：stdout="No previous sessions found for this project."  exit=0
```

**契约结论**：成功判据须认 stdout 的 `Deleted session <n>: <名称>`（序号不存在也 exit 0，不能靠退出码）；stdout 含被删名称，供处理器与 `pending.name` 后验比对（I-2，防 TOCTOU 删到邻条）。`deleteSession` 据此解析名称返回，处理器比对不符则告警。