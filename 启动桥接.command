#!/bin/bash
# 启动 qoder-wechat-bridge（双击运行，或在终端执行）
# 首次运行会提示扫码登录；之后直接进入常驻循环。
set -euo pipefail

cd "$(dirname "$0")"

# 使用当前 PATH 里的 Node；若默认版本低于 20，可取消下一行注释并改成你的 Node 22 路径
# export PATH="/path/to/node22/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js >= 20"
  exit 1
fi

node -e 'const m=+process.versions.node.split(".")[0]; if(m<20){console.error("需要 Node >= 20，当前 "+process.version);process.exit(1)}'

npm run build

echo
echo "启动桥接服务…（Ctrl+C 停止）"
echo "配置：~/.config/qoder-wechat-bridge/config.json"
echo "工作目录：$(node dist/cli.js status | sed -n 's/^工作目录：//p')"
echo

node dist/cli.js run
