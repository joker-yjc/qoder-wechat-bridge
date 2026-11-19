# 真机验收记录：CLI 后端兼容（20261119）

> 环境：macOS arm64，CN CLI `@qodercn-ai/qoderclicn@1.1.92`（`/usr/local/bin/qoderclicn`），国际版 `@qoder-ai/qodercli@1.1.89`。
> 验收人：阿程（agent 跑本地命令）+ 主人（CN 登录真人步骤）。日期：2026-11-19。
> 测试运行口径：node 24.21.0（`PATH` 前置 `/usr/local/n/versions/node/24.21.0/bin`）；生产运行时仍 node ≥20。

## 1. CN 后端核心验收（主人登录后）

| 项 | 命令/方式 | 结果 |
|---|---|---|
| CN CLI 就位 | `qoderclicn --version` | `1.1.92` |
| 空清单哨兵 | 空目录 `qoderclicn --list-sessions` | `No previous sessions found for this project.`，匹配 `sessions.ts` 正则 |
| CN 登录 | 主人本人 `qoderclicn login` | 完成 |
| 真实任务往返 | 桥接 `runQoder`（bin=qoderclicn, memory=true, prompt="只回复两个字：收到"） | `ok=true`、text="收到"、sessionId `971810ae-8ff2-4bf6-a26d-e688da8af63f`、modelUsed=auto、exitCode 0、durationMs 8868 |
| 记忆生效（行为探针） | `runQoder`（memory=true）问"用户 GitHub 用户名" | 答 `joker-yjc`（来自迁移记忆 user-personal-accounts），坐实 `QODERCN_MEMORY_HEADLESS=1` 加载了长期记忆 |
| `--list-models` 格式 | `qoderclicn --list-models` | 内置 14 条无括号、自定义带括号被 models.ts 正确跳过 |
| CN 自定义模型 | `listModels('qoderclicn')` | 8 条 `providerId/model`（provider `qoder-custom-14a1…` 2 条 + `qoder-custom-5f62…` 6 条），id 可传 `-m` |
| CN 会话存储 | 查 jsonl 落点 | `~/.qoder-cn/projects/-Users-joke/971810ae….jsonl`（CN 独立存储）；`~/.qoder-cn/memory/MEMORY.md` 含迁移记忆 |

> 记忆正文注入在系统提示（jsonl 不落全文），故用行为探针而非 jsonl grep 坐实。往返与探针各消耗一次最小模型轮次。

## 2. P1-1 配置目录覆盖变量对照（审查后复证）

临时目录 `/tmp/qwb-verify-cfg/withprov/settings.json` 含 sentinel provider（无登录态）。

| 探针 | 结果 | 结论 |
|---|---|---|
| CN + `QODER_CONFIG_DIR=withprov` `--list-models` | sentinel 0 命中、默认自定义 8 条 | CN **忽略** `QODER_CONFIG_DIR` |
| CN + `QODERCN_CONFIG_DIR=withprov` `--list-models` | `Not logged in. Run qoderclicn login` | CN **认** `QODERCN_CONFIG_DIR`（切到无登录态副本） |
| intl + `QODER_CONFIG_DIR=withprov` `--list-models` | `Not logged in. Run qodercli login` | intl **认** `QODER_CONFIG_DIR` |
| intl + `QODER_CONFIG_DIR=~/.qoder`（真实目录） | 自定义 8 条，与无覆盖一致 | intl 覆盖生效且默认目录等价 |

包内静态佐证：CN `MLe=yo("CONFIG_DIR")=QODERCN_CONFIG_DIR` 为全局配置目录入口；`ZVt=DC("CONFIG_DIR")=QODER_CONFIG_DIR` 仅用于 skill 路径替换等。**原"两版通用 QODER_CONFIG_DIR"结论有误，已按方案 A 修正。**

## 3. 修复后代码门禁（审查意见修复完成后重跑）

见 review.md 修复处置节与提交说明；命令：`npm run typecheck && npm run build && npx vitest run --coverage --maxWorkers=2 && npm pack --dry-run`。

## 4. 遗留待主人

- 验收探针在 `~/.qoder-cn/projects/-Users-joke/` 留下两条真实 CN 会话（`971810ae…` 等），属用户数据，删否由主人定。
- 临时目录 `/tmp/qoderclicn-probe`、`/tmp/qwb-cn-accept`、`/tmp/qwb-verify-cfg` 待主人确认清理。