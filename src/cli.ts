#!/usr/bin/env node
/**
 * 命令行入口：login / run / status
 * @module cli
 */
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, loadState, migrateLegacyConfig, readRunInfo, statePath, type Config } from './config.js';
import { runService } from './bridge/service.js';
import { formatStopOutcome, describeOwner, isAlive, stopExitCode, stopService } from './bridge/lifecycle.js';
import { AlreadyRunningError, LockIoError } from './bridge/instance-lock.js';
import { login } from './weixin/login.js';
import { notify } from './notify.js';
import { sendMediaFile, sendVoiceFromText } from './weixin/send-media.js';
import { cleanInbox, inboxUsage } from './weixin/media.js';
import { buildStatusLines, formatBytes } from './status.js';
import { log } from './log.js';

/** 帮助文本 */
const HELP = `qoder-wechat-bridge — 把个人微信单聊接到本机 Qoder

用法：
  qoder-wechat <command> [options]

命令：
  login              扫码登录微信，token 保存到配置文件
  run                启动常驻桥接服务
  stop               停止运行中的桥接服务（launchd 托管时只给出命令）
  notify <内容>      主动推送一条提醒（窗口不可用时自动排队）
  send-file <路径>   发送图片/文件/视频（可选 --text 文案）
  send-voice <文本>  [实验性] 本机 TTS 语音（客户端可能不显示）
  clean              清理入站附件（默认 7 天前；--all 全删）
  status             查看配置、会话与待补发队列
  help               显示本帮助

notify 选项：
  --user <id>        目标账号（默认授权账号）
  --text <内容>      与位置参数二选一

send-file 选项：
  --text <文案>      先发一条文案
  --to <id>          目标账号（默认授权账号）

send-voice 选项：
  --voice <name>     发音人，默认 Tingting（macOS say）
  --to <id>          目标账号（默认授权账号）

run 选项（仅本次运行生效，不写入配置文件）：
  --cwd <dir>                 Qoder 工作目录
  --permission-mode <mode>    default | accept_edits | dont_ask | bypass_permissions | auto
  --model <name>              指定模型
  --qoder-bin <path>          qodercli 路径（默认 qodercli）
  --owner <id>                唯一授权发送者 id
  --allow <id,id>             额外允许的发送者
  --timeout-ms <ms>           单任务超时
  --inbox-dir <dir>           入站附件目录
  --base-url <url>            iLink API 地址

通用选项：
  -h, --help                  显示帮助
  -v, --version               显示版本

配置优先级：命令行参数 > 环境变量(QWB_*) > 配置文件 > 默认值
`;

/**
 * 读取包版本号
 * @returns 版本字符串
 */
function readVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    return (JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 极简参数解析：支持 --key=value 与 --key value
 * @param argv - 参数数组
 * @returns 位置参数与选项
 */
function parseArgs(argv: string[]): { positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(arg.slice(2), next);
          i += 1;
        } else {
          flags.set(arg.slice(2), 'true');
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags.set(arg.replace(/^-+/, ''), 'true');
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

/**
 * 把命令行参数转成配置覆盖
 * @param flags - 解析后的选项
 * @returns 配置覆盖对象
 */
function overridesFromFlags(flags: Map<string, string>): Partial<Config> {
  const overrides: Partial<Config> = {};
  const cwd = flags.get('cwd');
  if (cwd) overrides.cwd = cwd;
  const mode = flags.get('permission-mode');
  if (mode) overrides.permissionMode = mode;
  const model = flags.get('model');
  if (model) overrides.qoderModel = model;
  const bin = flags.get('qoder-bin');
  if (bin) overrides.qoderBin = bin;
  const owner = flags.get('owner');
  if (owner) overrides.ownerUserId = owner;
  const allow = flags.get('allow');
  if (allow) overrides.allowFrom = allow.split(',').map((s) => s.trim()).filter(Boolean);
  const timeout = flags.get('timeout-ms');
  if (timeout && Number.isFinite(Number(timeout))) overrides.qoderTimeoutMs = Number(timeout);
  const baseUrl = flags.get('base-url');
  if (baseUrl) overrides.baseUrl = baseUrl;
  const inboxDir = flags.get('inbox-dir');
  if (inboxDir) overrides.inboxDir = inboxDir;
  const token = flags.get('token');
  if (token) overrides.token = token;
  return overrides;
}

/**
 * status 命令
 */
function printStatus(): void {
  const config = loadConfig();
  const state = loadState();
  const personaInfo = (() => {
    try {
      const stat = fs.statSync(config.personaFile);
      return stat.size > 0 ? `${config.personaFile}（${stat.size} 字节）` : '未设置';
    } catch {
      return '未设置';
    }
  })();
  const usage = inboxUsage(config.inboxDir);
  const runInfo = readRunInfo();
  const lines = buildStatusLines(config, state, {
    configFile: configPath(),
    stateFile: statePath(),
    personaInfo,
    inbox: usage,
    home: os.homedir(),
    runInfo,
    runAlive: runInfo ? isAlive(runInfo.pid) : false,
  });
  console.log(lines.join('\n'));
}

/** 入口 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0];

  if (flags.has('version') || flags.has('v') || command === 'version') {
    console.log(readVersion());
    return;
  }
  if (flags.has('help') || flags.has('h') || command === 'help' || command === undefined) {
    console.log(HELP);
    return;
  }

  // 兼容项目内旧配置（data/config.json），只在新位置为空时迁移一次
  migrateLegacyConfig(fileURLToPath(new URL('../data/config.json', import.meta.url)));

  if (command === 'login') {
    const result = await login({ force: flags.has('force') });
    log.info(result.message, result.connected ? { ownerUserId: result.ownerUserId ?? '' } : {});
    process.exit(result.connected ? 0 : 1);
  }

  if (command === 'status') {
    printStatus();
    return;
  }

  if (command === 'notify') {
    const text = positionals.slice(1).join(' ').trim() || (flags.get('text') ?? '').trim();
    if (!text) {
      console.error('用法：qoder-wechat notify "内容" [--user <id>]');
      process.exit(1);
    }
    const result = await notify(text, flags.get('user'));
    console.log(result.message);
    process.exit(result.status === 'error' ? 1 : 0);
  }

  if (command === 'send-file') {
    const filePath = positionals[1];
    if (!filePath) {
      console.error('用法：qoder-wechat send-file <路径> [--text "文案"] [--to <id>]');
      process.exit(1);
    }
    const cfg = loadConfig();
    const st = loadState();
    const target = (flags.get('to') ?? cfg.ownerUserId).trim();
    if (!target) {
      console.error('尚未设置授权账号，请先登录');
      process.exit(1);
    }
    if (target !== cfg.ownerUserId && !cfg.allowFrom.includes(target)) {
      console.error('目标不在授权名单内，已拒绝');
      process.exit(1);
    }
    const contextToken = st.contextTokens?.[target] ?? '';
    if (!contextToken) {
      console.error('没有可用的 context_token：请先给机器人发一条消息，再重试');
      process.exit(1);
    }
    try {
      const result = await sendMediaFile({
        filePath,
        toUserId: target,
        contextToken,
        text: flags.get('text'),
        baseUrl: cfg.baseUrl,
        token: cfg.token,
      });
      console.log(`已发送：${result.kind}（${Math.round(result.bytes / 1024)}KB）${result.textSent ? ' + 文案' : ''}`);
      process.exit(0);
    } catch (err) {
      console.error(`发送失败：${String(err)}`);
      process.exit(1);
    }
  }

  if (command === 'send-voice') {
    const text = positionals.slice(1).join(' ').trim() || (flags.get('text') ?? '').trim();
    if (!text) {
      console.error('用法：qoder-wechat send-voice "文本" [--voice Tingting] [--to <id>]');
      process.exit(1);
    }
    const cfg = loadConfig();
    const st = loadState();
    if (!cfg.token) {
      console.error('尚未登录微信，请先执行 login');
      process.exit(1);
    }
    const target = (flags.get('to') ?? cfg.ownerUserId).trim();
    if (!target) {
      console.error('尚未设置授权账号，请先登录');
      process.exit(1);
    }
    if (target !== cfg.ownerUserId && !cfg.allowFrom.includes(target)) {
      console.error('目标不在授权名单内，已拒绝');
      process.exit(1);
    }
    const contextToken = st.contextTokens?.[target] ?? '';
    if (!contextToken) {
      console.error('没有可用的 context_token：请先给机器人发一条消息，再重试');
      process.exit(1);
    }
    try {
      const result = await sendVoiceFromText({
        text,
        toUserId: target,
        contextToken,
        baseUrl: cfg.baseUrl,
        token: cfg.token,
        voice: flags.get('voice') ?? cfg.ttsVoice,
      });
      console.log(`已发送语音：${(result.durationMs / 1000).toFixed(1)} 秒（silk ${Math.round(result.bytes / 1024)}KB）`);
      process.exit(0);
    } catch (err) {
      console.error(`发送失败：${String(err)}`);
      process.exit(1);
    }
  }

  if (command === 'clean') {
    const cfg = loadConfig();
    const dir = (flags.get('inbox-dir') ?? cfg.inboxDir).trim();
    const days = Number(flags.get('days') ?? 7);
    if (!Number.isFinite(days) || days < 0) {
      console.error('--days 需要非负数字');
      process.exit(1);
    }
    const result = cleanInbox(dir, { all: flags.has('all'), days });
    console.log(`目录：${dir}`);
    console.log(`删除 ${result.removed} 个文件，释放 ${formatBytes(result.bytes)}`);
    return;
  }

  if (command === 'stop') {
    const result = await stopService();
    console.log(formatStopOutcome(result));
    process.exit(stopExitCode(result));
  }

  if (command === 'run') {
    try {
      const handle = await runService(overridesFromFlags(flags));
      log.info('服务已启动', { cwd: handle.config.cwd, mode: handle.config.permissionMode });
    } catch (err) {
      if (err instanceof AlreadyRunningError) {
        console.error(describeOwner(err.owner, err.launchdLabelValue));
        if (err.lockFile) {
          console.error(`如确认没有实例在运行，可删除记录文件后重试：\n  rm "${err.lockFile}"`);
        }
        process.exit(1);
      }
      if (err instanceof LockIoError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    return;
  }

  console.error(`未知命令：${command}\n`);
  console.log(HELP);
  process.exit(1);
}

main().catch((err) => {
  log.error('启动失败', { error: String(err) });
  process.exit(1);
});
