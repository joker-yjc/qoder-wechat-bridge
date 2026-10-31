@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 node，请安装 Node.js 20 或更高版本
  pause
  exit /b 1
)

node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo 需要 Node.js 20 或更高版本
  pause
  exit /b 1
)

call npm run build
if errorlevel 1 (
  pause
  exit /b 1
)

echo.
echo 启动桥接服务…（Ctrl+C 停止）
node dist\cli.js run
pause
