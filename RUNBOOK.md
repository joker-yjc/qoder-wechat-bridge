# RUNBOOK

面向本机部署的运维手册。通用安装说明见 [README.md](README.md)。

## 1. 环境要求

| 项 | 要求 | 备注 |
|---|---|---|
| Node | `>= 20` | 低于 20 时用 `n 22` 或安装 LTS |
| qodercli | `>= 1.1.80`，且已 `qodercli login` | 未登录时执行浏览器授权 |
| 微信 | `>= 8.0.69` | 官方 iLink 通道，仅单聊；建议先用小号验证 |

如需切换 Node 版本：`n 22`。

## 2. 目录

| 用途 | 路径 |
|---|---|
| 配置（含 token，600） | `~/.config/qoder-wechat-bridge/config.json` |
| 状态（游标、会话映射、补发队列） | `~/.local/state/qoder-wechat-bridge/state.json` |
| 待补发提醒（notify 排队） | `~/.local/state/qoder-wechat-bridge/pending-notifications.jsonl` |
| 日志 | `~/.local/state/qoder-wechat-bridge/logs/bridge-YYYY-MM-DD.jsonl` |
| 登录二维码 | `~/.local/state/qoder-wechat-bridge/wechat-qr.png` |
| 无 TTY 时的校验码 | `~/.local/state/qoder-wechat-bridge/verify-code.txt` |

## 3. 启动 / 停止

```bash
cd <项目目录>
./启动桥接.command          # 双击也可以
# 或（默认不限定目录，按配置里的模型运行）
node dist/cli.js run
# 临时指定目录
node dist/cli.js run --cwd ~/projects/my-app
```

停止：`Ctrl+C`。

## 4. 常用命令

```bash
node dist/cli.js status                      # 查看配置与会话
node dist/cli.js login                       # 重新扫码（token 过期/换号）
node dist/cli.js notify "需要你确认一下"       # 主动提醒（无窗口时排队）
node dist/cli.js run --permission-mode dont_ask
```

微信内置命令：`/help`（命令总览）、`/status`、`/reset`、`/model`（列出模型）、`/model <序号|名称>`（切换）、`/model default`（恢复 Auto）。

> 自定义 provider 的模型必须写成 `<providerId>/<model>`（如 `qoder-custom-xxxx/glm-5.3`），只写短名会被 Qoder 静默回落到 `auto`；`/model` 内部已做这层映射。

## 5. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `sdk_worker_removed` | 从 Qoder 桌面终端启动，继承了 `QODER_*` | 本包已在拉起 qodercli 时剥离；若仍出现，用 `.command` 从 Finder 启动 |
| `Not logged in · Please run /login` | qodercli 未登录 | `qodercli login`，浏览器授权 |
| `SyntaxError: Invalid regular expression flags` | node 仍是 v16 | `n 22` |
| 扫码后 `binded_redirect` | 该微信号已绑过其它 OpenClaw 形态机器人 | 先解绑，或换号 |
| 收消息正常但回复失败 `ret=-2` | context_token 过期 / 下行额度耗尽 | 属通道限制；结果会进补发队列，下次入站重试 |
| 日志 `-14` | 微信会话过期 | 重新 `login`；不要高频重登（会触发风控） |
| `npm error EACCES ~/.npm/_cacache` | 缓存目录有 root 所有的文件 | 用 `--cache ./.npm-cache`，或自行修复缓存权限 |
| `install-scripts` 拦截 esbuild | npm 11 默认禁止 postinstall | 本项目不依赖 tsx/esbuild，用 `tsc` 构建即可 |

## 6. 观察与验收

```bash
# 实时看日志
tail -f ~/.local/state/qoder-wechat-bridge/logs/bridge-$(date +%F).jsonl
```

验收标准（v0.1）：

1. 微信发一条文本，10 秒内日志出现「收到授权消息」；
2. 若任务较长，微信侧可见「正在输入」；
3. 结果在 ≤9 条消息内回传，单条 ≤2000 字；
4. 第二条消息能延续上下文（`state.json` 中同一 `sessionId`）；
5. 发送 `/status` 能返回工作目录与会话 id。

## 7. 安全

- 当前配置为 `ownerUserId` 单人授权 + `bypass_permissions`，等于"你本人可远程指挥本机"。
- 不要把 `config.json` 提交到仓库或分享；token 权限 600。
- 长期不用请停止进程并在微信侧解绑。
