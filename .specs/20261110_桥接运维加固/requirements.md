# 需求文档：桥接实例互斥

## 简介

`qoder-wechat run` 目前没有任何实例检查：启动即覆盖 `run.json`、立即开始 `getupdates` 长轮询。launchd 常驻、手动双击启动脚本、KeepAlive 重启重叠、换机后旧实例未停等场景都会出现两个进程消费同一个 bot。两个实例各自持有内存里的 `get_updates_buf`，又整文件覆盖 `state.json`，实际后果是同一条消息被执行两次、游标回退导致漏收/重投、`outbox` 与会话记录互相抹掉。

本需求增加一个启动期安全兜底：同一状态目录下只允许一个桥接实例存活；发现已有存活实例时明确拒绝启动并给出停止方法，而不是静默双开。异常退出后必须能被后续实例接管，不能把服务永久锁死。

## 术语表

- **实例**：一个执行 `qoder-wechat run` 的 Node 进程。
- **状态目录**：`$QWB_STATE_DIR` > `$XDG_STATE_HOME/qoder-wechat-bridge` > `~/.local/state/qoder-wechat-bridge`。`state.json`、`run.json` 都在这里。
- **运行记录（`run.json`）**：当前实例写入的 `{pid, ppid, startedAt, cwd}`，供 `status` / `stop` 定位进程。
- **锁**：启动期创建的原子互斥标记，用于把"检查是否已有实例"和"登记自己"合并为一个不可分割的动作。
- **存活实例**：锁记录中的 pid 仍然存在（不要求命令行匹配）。命令行是否像桥接进程只用于告警，不作为删锁依据（Windows 无命令行校验能力，同样只按 pid 存活判定，见非目标）。
- **陈旧锁**：锁内 pid 已不存活。pid 存活但命令行不匹配属判定不清，**不算陈旧**：按占用处理、拒绝启动并要求人工确认。
- **陈旧运行记录**：`run.json` 的 pid 已不存在，或存在但已不是桥接进程。仅用于升级窗口的兜底判定，与"陈旧锁"口径不同（见需求 1.4 与属性 9 的不对称说明）。
- **launchd 托管实例**：由 `com.jcyao.qoder-wechat-bridge.plist` 启动、`KeepAlive=true` 的实例。

## 背景

### 现有实现

| 位置 | 现状 | 后果 |
| --- | --- | --- |
| `src/cli.ts` `run` 分支 | 直接调用 `runService`，无任何前置检查 | 可以同时起多个实例 |
| `src/config.ts` `writeRunInfo()` | 无条件覆盖 `run.json` | 后启动的实例把记录改成自己的 pid，`stop` / `status` 指向错乱 |
| `src/config.ts` `saveState()` | 整文件原子替换，无锁 | 两个实例的 `state.json` 副本互相覆盖，后写者赢 |
| `src/bridge/service.ts` 主循环 | 每个进程独立持有 `get_updates_buf` 并落盘 | 游标回退或跳跃，消息漏收/重投 |
| `src/bridge/service.ts` `cancelAllTasks()` | 只遍历本进程 `runningTasks` | `/stop` 停不掉另一实例里的任务 |
| `src/bridge/lifecycle.ts` `planStop()` | 已能在 `stop` 时识别多实例并拒绝自动处理 | 只能事后发现，启动期不拦截 |
| `启动桥接.command` | 直接 `node dist/cli.js run` | 双击即可在 launchd 之外再起一个 |

### 高风险场景

1. launchd 常驻 + 手动调试（最常见）。
2. KeepAlive 拉起新实例时旧实例仍在优雅退出的重叠窗口。
3. 同一 bot token 配不同状态目录起"调试实例"。
4. 历史遗留的 nohup / pm2 / 其他终端进程。

## 需求

### 需求 1：启动期实例互斥（P0）

**用户故事：** 作为本机唯一运维者，我希望重复启动被明确拒绝，避免两个实例同时消费消息。

#### 验收标准

1. WHEN 执行 `qoder-wechat run` THEN THE 桥接服务 SHALL 在开始 `getupdates` 长轮询之前完成实例互斥检查。
2. IF 同一状态目录下已存在存活实例 THEN THE 桥接服务 SHALL 拒绝启动，输出存活实例的 pid、启动时间、工作目录与停止方法，并以非零退出码结束。
3. IF 拒绝启动 THEN THE 桥接服务 SHALL NOT 覆盖 `run.json`、SHALL NOT 进入轮询、SHALL NOT 处理任何入站消息。
4. IF `run.json` 记录的是陈旧运行记录（pid 不存在，或存在但已不是桥接进程） THEN THE 桥接服务 SHALL 清理该记录并继续正常启动。
5. WHEN 互斥检查通过 THEN THE 桥接服务 SHALL 登记自身为当前实例，供后续 `status` / `stop` 使用。
6. IF 不存在任何锁文件、但 `run.json` 指向仍存活的桥接进程（升级前版本不写锁） THEN THE 桥接服务 SHALL 拒绝启动并给出该实例的 pid 与停止方法，避免新旧版本叠加双开。

### 需求 2：原子占锁与异常接管（P0）

**用户故事：** 作为运维者，我希望互斥本身不会变成新的故障源：既不能出现两个实例同时通过检查，也不能在崩溃后把服务永久锁死。

#### 验收标准

1. WHEN 两个实例在毫秒级时间窗内同时启动 THEN THE 桥接服务 SHALL 只允许其中一个进入轮询，另一个按需求 1.2 拒绝启动。
2. THE 桥接服务 SHALL 以原子方式创建锁，SHALL NOT 采用"先读再写"的两步判断。
3. WHEN 实例正常退出（含 SIGINT / SIGTERM） THEN THE 桥接服务 SHALL 先停止接收新消息、取消已启动任务并等待队列排空，再释放锁；若 3 秒内未能排空 THEN THE 桥接服务 SHALL 保留锁不释放，并在在途任务落定后补释放（补释放前同进程内重启 SHALL 被防重入拒绝，进程退出后由下一次启动按陈旧锁接管），确保锁释放之后 SHALL NOT 再写入 `state.json`。
4. IF 实例被 SIGKILL 或崩溃、未释放锁 THEN 后续实例 SHALL 仅在锁内 pid 不存活时将其判定为陈旧锁并接管；pid 存活但命令行不匹配时 SHALL 拒绝启动并提示人工确认，SHALL NOT 自动接管。
5. IF 锁因权限或磁盘 IO 无法创建或读取（原因不是"已有实例"） THEN THE 桥接服务 SHALL 以非零退出码拒绝启动，输出原因、锁文件路径与可操作提示，SHALL NOT 在无互斥保护的情况下进入轮询。
6. 无冲突时 THE 锁的创建与检查路径 SHALL NOT 创建子进程、SHALL NOT 发起网络请求（冲突判定允许调用 `ps` / `launchctl`）；在空状态目录下完成取锁 + 释放的实测耗时 SHALL 不超过 100ms（不含既有预检），由单元测试计时断言。
7. WHEN 实例已进入停止流程 THEN THE 桥接服务 SHALL NOT 再下载附件、SHALL NOT 入队新任务、SHALL NOT 执行队列中尚未启动的任务，只写 info 级日志。由于 `get_updates_buf` 已推进且 iLink 不再投递，这批已拉取的消息 SHALL 被视为丢弃且不再重试（属预期行为，见需求 4 与「入站消息队列的持久化」非目标）。

### 需求 3：运行记录一致性（P0）

**用户故事：** 作为运维者，我希望 `stop` 和 `status` 永远指向真正在跑的那个实例。

#### 验收标准

1. WHEN 成功占锁 THEN THE 桥接服务 SHALL 才写入 `run.json`，内容至少包含 pid、父 pid、启动时间、工作目录。
2. WHEN 进程退出 THEN THE 桥接服务 SHALL 仅在 `run.json` 中的 pid 等于自身 pid 时清理该文件。
3. WHEN 执行 `qoder-wechat stop` 且存在多个桥接进程 THEN THE 桥接服务 SHALL 保持现有的冲突提示行为，列出所有 pid，SHALL NOT 自动杀死任意一个。
4. WHEN 执行 `qoder-wechat status` THEN THE 桥接服务 SHALL 显示当前实例 pid 与存活状态（无实例时显示"未运行"）。

### 需求 4：launchd 与重启重叠（P0）

**用户故事：** 作为运维者，我希望 launchd 与手动启动不会互相踩，也不会因为 KeepAlive 反复重启而形成双实例。

#### 验收标准

1. WHEN launchd 托管实例存活且用户手动执行 `run` THEN THE 桥接服务 SHALL 拒绝启动，并提示优先使用 `launchctl bootout` / `qoder-wechat stop` 管理该实例。
2. IF 锁被正在退出的旧实例短暂持有 THEN THE 桥接服务 SHALL 在不超过 5 秒的重试窗口内重试（每把锁各自计算，故整次启动的取锁等待上界约 10 秒；扫码登录耗时不计入任何取锁窗口）；仍无法获取则按需求 1.2 退出非零，交由 launchd 按既有节流策略重试。
3. THE 桥接服务 SHALL NOT 在互斥检查中主动杀死 launchd 托管实例，避免与 `KeepAlive` 形成"杀掉-拉起"循环。

### 需求 5：同一 bot 跨状态目录（P1）

**用户故事：** 作为调试者，我希望能发现"用另一个状态目录又起了一个同 bot 实例"这种情况。

#### 验收标准

1. WHEN 同一 bot id 在本机另一个状态目录已有存活实例 THEN THE 桥接服务 SHALL 拒绝启动，并输出对方状态目录、pid 与启动时间。
2. THE 该检查 SHALL 仅限本机，SHALL NOT 依赖网络，也 SHALL NOT 尝试检测另一台机器上的同 bot 实例。
3. IF 两个状态目录的 bot id 不同 THEN THE 桥接服务 SHALL 视其为不同实例，互不影响；同一 bot 更换 token 不改变所属实例，仍受本条互斥约束。

### 需求 6：拒绝启动的可观测性（P1）

**用户故事：** 作为运维者，我希望从日志就能判断"为什么这次没起来"。

#### 验收标准

1. WHEN 因已有实例而拒绝启动 THEN THE 桥接服务 SHALL 在日志中记录自身 pid、对方 pid、判定依据（锁 / `run.json` / 跨目录记录）与锁文件路径。
2. WHEN 清理陈旧记录或接管陈旧锁 THEN THE 桥接服务 SHALL 记录一条 warn 级日志，包含被清理的 pid。
3. THE 拒绝启动的控制台输出 SHALL 为中文，并给出一条可直接复制执行的停止命令。

## 成功标准

- 同目录重复启动、同 bot 跨状态目录启动都被拒绝，退出码非零，且原实例不受影响。
- SIGKILL 后下一次启动能接管陈旧锁；正常退出（含 SIGTERM）后锁被释放，后继实例可立即启动；排空超时时保留锁，由下一次启动接管。
- 拒绝路径不覆盖 `run.json`、不写 `state.json`、不进入轮询。
- 拒绝时日志含自身 pid、对方 pid、判定依据与锁文件路径；控制台为中文并给出可复制的停止命令。
- 全部测试通过，`coverage.include` 内源文件 Lines ≥ 95%。

## 与既有文档的关系

- 上游：`.specs/v2-backlog.md` 的「多实例互斥」可靠性条目（已完成，指向本目录）。
- 同目录：`design.md`（实现设计）、`tasks.md` + `task-list/`（执行拆分）、`review.md`（第一轮审查）、`verification.md`（门禁与真机验收记录）。

## 非功能性需求
### N1 兼容性

THE 桥接服务 SHALL 保持单实例下的现有行为完全不变：消息收发、排队、`/stop`、`notify`、`send-file`、会话续接、`status` / `stop` 语义均不改动。

### N2 依赖与平台

THE 实现 SHALL NOT 引入新的运行时依赖；锁与进程判定使用 Node 内置能力与既有 `src/bridge/lifecycle.ts` 的进程识别逻辑。

### N3 安全

THE 锁文件与 `run.json` SHALL 以 `0600` 权限写入；锁内容 SHALL NOT 包含 token 或 context_token。

## 非目标

- 检测另一台机器上的同 bot 实例（无跨机协调机制）。
- 在互斥失败时自动杀死或接管已有实例（保持"拒绝并提示"，不做自动处理）。
- Windows 平台不做命令行特征校验：`run.lock` 的 pid 存活即视为存活实例。该平台无法区分 pid 被无关进程复用的情况，冲突时需人工删除锁文件。
- bot 锁的定期回收：某 botId 被强杀后再不启动，其 `instances/<hash>.lock` 会长期保留，本期不做过期清理。
- 取锁临时文件（`.run.lock.<pid>.<ts>.<rand>.tmp`）的残留扫描清理：正常路径由 `createLock` 即时清理，仅在写入与 `link` 之间被 SIGKILL 打断时可能残留，不影响取锁正确性。
- 修改或自动安装 launchd 配置。
- 入站消息队列的持久化（进程重启导致排队消息丢失，另案讨论）。
