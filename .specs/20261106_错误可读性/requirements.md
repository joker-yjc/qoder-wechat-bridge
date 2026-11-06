# 需求文档：桥接错误可读性

## 简介

当前 `qoder-wechat` 桥接只会把 qodercli 的失败归到"传输层"（启动失败、超时、空输出、无法解析、非零退出）。而 qodercli 在**业务语义失败**时是带着退出码 1 返回的，于是这类失败全部落到"非零退出"分支——该分支完全不读 stdout 里的 `error_code` / `errors` / `error_message` / `stop_reason`，尽管这些字段一直都在。结果是模型额度耗尽、输出被截断这些语义不同、处理方式也不同的失败，在用户侧长得一模一样：一句 `执行失败：qodercli 异常退出（退出码 1）。详见本机日志。`

本需求要把错误按语义归类、用人话说明并给出下一步动作，同时保证错误提示只发一次、被抑制时仍有极简回应、且不进补发队列，不重演 2026-11-03「104 条垃圾消息把队列堵死」的事故。

## 术语表

- **错误类别（error kind）**：把 qodercli 的失败归一到 `model_quota` / `output_limit` / `auth` / `unknown` 四类之一，用于生成可读提示与去重。
- **传输层失败**：进程层面的失败，即启动失败、超时、空输出、输出无法解析、非零退出。
- **业务语义失败**：进程带退出码返回、但 stdout 的 `result` 行里带有 `error_code` 等语义字段的失败，例如额度耗尽、输出被截断、凭据失效。
- **`error_code`**：qodercli `result` 行里的语义错误码，类型为 `number | string`。实测样本：数字 `110`（`error_message: "Billing daily count exceeded"`）、字符串 `"max_output_tokens"`。qodercli 自身枚举还包含 `authentication_failed` / `billing_error` / `rate_limit` / `invalid_request` / `server_error` / `unknown`。
- **停因（`stop_reason`）**：实测取值为 `max_tokens`（输出被截断）与 `stop_sequence`。不存在 `length`；且 `stop_sequence` 会出现在非截断失败上（5 次额度失败的 `stop_reason` 全是 `stop_sequence`），故 `stop_reason` 不可单独作为截断判据。
- **去重窗口**：同一会话内同一错误类别只推送一次完整提示的时间范围，默认 10 分钟。**会话维度即微信用户维度**——本项目 `state.sessions` 以 `userId` 为键，一个微信用户对应一个 qodercli 会话；当前只有单一授权账号，不做多用户区分。
- **ack**：去重窗口内同类错误再次发生时推送的极简回应，只说明"同类错误已提示过"并带抑制次数。
- **outbox（补发队列）**：发送失败时暂存待发消息的本地队列；错误提示与 ack 均不应进入该队列。
- **诊断文件**：每次失败落盘的完整 stdout / stderr 记录，供事后排查。
- **下行额度（既有概念）**：微信侧 `ret=-2` 表示的发送额度受限，对应 `SendFailureKind='quota'` 与 `state.quota`。**与 `model_quota` 是两个完全无关的概念**，代码、日志与用户文案中不得混用。

## 背景

### 实测样本

以下 6 条均来自本机诊断文件（`~/.local/state/qoder-wechat-bridge/logs/diagnostics/`），可与 `bridge-2026-11-05.jsonl` / `bridge-2026-11-06.jsonl` 逐条对上。

| 本地时间 | errorKind | exit | `stop_reason` | `error_code` | `errors[0]` | `result` |
| --- | --- | --- | --- | --- | --- | --- |
| 11-05 22:56 | `exit` | 1 | `stop_sequence` | `110` | You've reached your daily usage limit for Chat… | 空 |
| 11-05 23:13 | `exit` | 1 | `stop_sequence` | `110` | 同上 | 空 |
| 11-05 23:21 | `exit` | 1 | `stop_sequence` | `110` | 同上 | 空 |
| 11-05 23:26 | `exit` | 1 | `stop_sequence` | `110` | 同上 | 空 |
| 11-05 23:27 | `exit` | 1 | `stop_sequence` | `110` | 同上 | 空 |
| 11-06 09:29 | `exit` | 1 | `max_tokens` | `"max_output_tokens"` | The model reached its output token limit… | 空 |

6 次失败下行给用户的都是同一条 33 字符消息：`执行失败：qodercli 异常退出（退出码 1）。详见本机日志。`

### 2026-11-05 22:56–23:27：额度耗尽被报成"异常退出"，31 分钟内刷屏 5 次

- 现象：用户连续 5 次收到 `执行失败：qodercli 异常退出（退出码 1）。详见本机日志。`，日志实测每条 33 字符。
- 根因：qodercli 返回 `exit=1` + `error_code=110` + `error_message="Billing daily count exceeded"`；`src/bridge/qoder.ts` 的 `code !== 0` 判断排在 `parsed.is_error` 之前，落到 `exit` 分支，而该分支不读任何语义字段。
- 影响：用户看不出是额度问题，只能反复重试，5 次同类错误全部下行。
- 补充事实：同一时段内 23:21 失败、23:22 用同一模型成功，23:30 换模型也成功——说明 `error_code=110` 不是硬性全天封锁，"稍后重试或切换模型"是实测有效的建议。

### 2026-11-06 09:29：输出截断被报成"异常退出"

- 现象：同上，用户收到 33 字符的"异常退出"提示。
- 根因：qodercli 返回 `exit=1` + `error_code="max_output_tokens"` + `stop_reason="max_tokens"`，同样落到 `exit` 分支，截断语义被丢弃。
- 触发条件：BYOK 模型 `Qwen3.8-27B` 声明 `maxOutputTokens=4000`，且该模型的思考 token 与正文共用同一额度，长任务很容易写满。
- 补充事实：该次 `result` 字段为空字符串。当前 `-o json` 解析路径只读最终 `result` 行，因此截断时**没有任何已生成的部分内容可保留**。

### 现有实现的三处缺口

| 缺口 | 现状 | 后果 |
| --- | --- | --- |
| 语义字段被整体丢弃 | `src/bridge/qoder.ts` 的 `code !== 0` 分支先于 `is_error`，两者都不读 `error_code` / `errors` / `error_message` / `stop_reason` | 所有业务语义失败都报成"异常退出（退出码 1）" |
| 同类错误不去重 | 每次失败独立下行一条错误提示 | 11-05 的 31 分钟内 5 条同类消息 |
| 错误回复会进补发队列 | `src/bridge/service.ts` 以 `queueOnFailure: true` 发送错误提示 | 发送失败时错误消息堆积，可能重新堵塞队列 |

## 需求

### 需求 1：错误语义分类（P0）

**用户故事：** 作为通过微信接收任务结果的用户，我希望失败提示告诉我这是"模型额度用完了""回答被截断了"还是"登录凭据失效了"，并给出一句我能自己执行的处理建议。

#### 验收标准

1. WHEN qodercli 调用失败（含非零退出与 `is_error`） THEN THE 桥接服务 SHALL 先解析 stdout `result` 行中的 `error_code`、`errors`、`error_message`、`stop_reason`，再据此归类为 `model_quota` / `output_limit` / `auth` / `unknown` 之一。
2. WHEN `error_code` 为数字 `110` 或 `error_message` 含 `Billing daily count exceeded` THEN THE 桥接服务 SHALL 归类为 `model_quota`，提示模型额度已用尽，并给出"稍后重试或切换模型"的动作建议。
3. WHEN `error_code` 为字符串 `max_output_tokens` THEN THE 桥接服务 SHALL 归类为 `output_limit`。
4. WHEN `error_code` 为字符串 `authentication_failed` THEN THE 桥接服务 SHALL 归类为 `auth`，提示凭据失效，并给出"重新登录"的动作建议。
5. WHEN 已完成归类 THEN THE 桥接服务 SHALL 使用该类别对应的固定中文模板生成提示，且 SHALL NOT 把 `errors` / `error_message` 的英文原文作为回复正文发送。
6. IF 所有特征都未命中 THEN THE 桥接服务 SHALL 归类为 `unknown`，沿用现有传输层提示并保留退出码。此处"现有传输层提示"包含一期 `is_error` 分支取 `result` 首行（≤200 字）的行为：`result` 是**模型输出**而非 `errors` / `error_message` 的错误原文，N2 的禁令不覆盖它，一期已验收，本期保留（实测 6 份样本的 `result` 均为空，当前不触发）。
7. WHEN 归类为 `unknown` 且存在语义字段 THEN THE 桥接服务 SHALL 在日志中记录 `error_code` 与 `errors` 首条摘要，供后续补充识别特征。

### 需求 2：输出截断检测（P0）

**用户故事：** 作为用户，我希望回答被截断时明确告诉我"这是截断"，而不是让我以为模型答完了、或以为桥接坏了。

#### 验收标准

1. WHEN `error_code` 为 `max_output_tokens`，或 `stop_reason` 为 `max_tokens` 且 `is_error` 为真 THEN THE 桥接服务 SHALL 判定为失败类别 `output_limit`，SHALL NOT 判定为成功。
2. WHEN 判定为 `output_limit` THEN THE 桥接服务 SHALL 发送一条中文截断说明，并给出"换用输出上限更大的模型，或把任务拆小"的建议，SHALL NOT 在文案中写死具体模型名。
3. THE 桥接服务 SHALL NOT 在截断提示中声称已附上部分生成内容。
4. IF 截断提示超过字符上限 THEN THE 桥接服务 SHALL 按现有限长规则截断，SHALL NOT 发送空消息。

### 需求 3：错误提示单条化、去重与 ack（P0）

**用户故事：** 作为用户，我希望同一类错误不要反复刷屏，但也不要发了消息之后完全没有回应。

#### 验收标准

1. WHEN 发送错误提示 THEN THE 桥接服务 SHALL 只发送一条不超过 `userErrorMaxChars`（默认 300 字符）的提示，且 SHALL NOT 将其写入 outbox 补发队列。
2. WHILE 同一会话在去重窗口（默认 10 分钟）内重复出现同一错误类别 THE 桥接服务 SHALL 只推送一次完整提示，后续同类失败 SHALL 改为推送一条 ack。
3. WHERE 错误类别为 `unknown` THE 桥接服务 SHALL NOT 对其去重，每次失败都推送完整提示。理由：`unknown` 是 `timeout` / `spawn` / `empty` / `parse` 四种传输层失败与全部未收录错误码的公共兜底桶，各自的提示携带不同的失败种类与退出码；归到一个桶会让"qodercli 没装"抑制掉后续的"限流"，且 ack 里的"未归类"对用户无信息量。2026-11-05 的 5 条刷屏全部是 `model_quota`，`unknown` 本不成灾。
4. WHEN 推送 ack THEN THE 桥接服务 SHALL 在 ack 中带上该类别在窗口内已被抑制的次数与首次提示的时间，且 ack 长度 SHALL NOT 超过 60 字符。
5. IF 错误提示或 ack 本身发送失败 THEN THE 桥接服务 SHALL 只写日志，不得重试或入队，且 SHALL NOT 推进去重窗口。
6. WHEN 不同类别的错误先后出现 THEN THE 桥接服务 SHALL 各自独立计数，不互相抑制。
7. WHEN 去重窗口过期后同一类别再次出现 THEN THE 桥接服务 SHALL 重新推送完整提示并把抑制次数归零。
8. IF 去重窗口时长配置为非法值（非数字、≤0 或无穷） THEN THE 桥接服务 SHALL 回落到默认值，SHALL NOT 让窗口永不过期而导致用户首次失败后永久只收到 ack。

### 需求 4：失败可观测性（P1）

**用户故事：** 作为本机运维者，我希望不用翻日志就能知道最近一次失败是什么类别、什么时候发生的。

#### 验收标准

1. WHEN 用户在本机执行 `qoder-wechat status` THEN THE 桥接服务 SHALL 显示最近一次失败的类别与发生时间。微信内的 `/status` 命令不在本条范围，保持一期输出不变。
2. WHEN 任一次失败发生 THEN THE 桥接服务 SHALL 在日志中记录错误类别、`error_code`、退出码、任务 id、会话 id 和诊断文件路径。
3. WHEN 错误被去重窗口抑制 THEN THE 桥接服务 SHALL 在日志中记录被抑制的次数。
4. THE 桥接服务 SHALL 在 `status` 输出与日志中区分模型额度（`model_quota`）与微信下行额度（既有 `quota`），SHALL NOT 让两者共用同一名称。

## 非功能性需求

### N1 兼容性

THE 桥接服务 SHALL 保持现有文本、媒体、`notify`、会话续接、模型切换等能力不变，且不改变一期已验收的传输层失败处理、`ret=-2` 下行额度处理、毒丸隔离、outbox 上限与 `stop` 行为。

### N2 隐私

THE 桥接服务 SHALL NOT 在用户提示或日志摘要中输出完整任务内容、token 或用户隐私信息；`errors` / `error_message` 英文原文与完整诊断仍只落在本机诊断文件。

### N3 可配置

THE 桥接服务 SHALL 允许配置去重窗口时长，默认 10 分钟，并对非法值回落到默认值。本期新增的配置项**只有这一项**；错误提示字符上限复用一期已有的 `userErrorMaxChars` / `QWB_USER_ERROR_CHARS`（默认 300），不新增。

## 成功标准

1. 复现 `error_code=110` 时，用户收到一条中文提示，明确指向模型额度已用尽，并带"稍后重试或切换模型"建议。
2. 复现 `error_code="max_output_tokens"` 时，用户收到的消息明确标注"被截断"，不再出现"异常退出（退出码 1）"或英文原文。
3. `model_quota` / `output_limit` / `auth` 三类在 10 分钟窗口内最多产生 1 条完整提示，其余为不超过 60 字符的 ack；`unknown` 不去重，每次都发完整提示。完整提示与 ack 均不进入 outbox。
4. `exit=0` 且 `is_error` 为假但 `error_code="max_output_tokens"` 时仍判为失败，半截答案不会被当成完整回答下发。
5. `qoder-wechat status` 能显示最近一次失败的类别与时间，且与既有"下行额度"一行互不混淆。
6. 新增单元测试覆盖四个类别的分类、截断检测（含 `exit=0` 组合）、去重与 ack、`unknown` 不去重、不入队；一期验收用例全部回归通过。

## 与既有文档的关系

- 一期：[`.specs/20261103_桥接稳定性优化`](../20261103_桥接稳定性优化/requirements.md)（0.2.0 已验收）。本需求只补"业务语义失败"这一层，不改动一期已验收的毒丸隔离、`ret=-2` 处理、outbox 上限与 `stop` 行为。
- 一期需求 2 的 7 条验收标准继续有效；与本需求重叠的部分，以本需求为补充，不替换。
