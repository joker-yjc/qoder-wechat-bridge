/**
 * 扫码登录：取二维码、展示、轮询状态、落盘 token 与账号标识
 * @module weixin/login
 */
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { ensureDirs, loadConfig, saveConfig, stateDir } from '../config.js';
import { log } from '../log.js';
import { getBotQrcode, pollQrStatus } from './client.js';

/** 固定登录地址 */
const LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
/** 一轮登录的总时限 */
const LOGIN_DEADLINE_MS = 8 * 60_000;
/** 二维码最多刷新次数 */
const MAX_REFRESH = 3;
/** 无 TTY 时等待校验码的文件 */
const VERIFY_CODE_FILE = path.join(stateDir(), 'verify-code.txt');

/** 登录结果 */
export interface LoginResult {
  connected: boolean;
  message: string;
  token?: string;
  baseUrl?: string;
  botId?: string;
  ownerUserId?: string;
}

/**
 * 用系统默认方式打开文件（macOS / Windows / Linux）
 * @param filePath - 文件路径
 */
function openFile(filePath: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  execFile(opener, [filePath], (err) => {
    if (err) log.debug('自动打开二维码失败（可手动打开）', { filePath, error: String(err) });
  });
}

/**
 * 展示二维码：终端 ASCII + PNG 留档 + 系统默认应用打开
 * @param content - 二维码内容
 * @param asciiSmall - 终端是否用紧凑模式
 */
async function showQr(content: string, asciiSmall = true): Promise<void> {
  qrcodeTerminal.generate(content, { small: asciiSmall });
  ensureDirs();
  const png = path.join(stateDir(), 'wechat-qr.png');
  await QRCode.toFile(png, content, { width: 560, margin: 2 });
  log.info('二维码已生成', { content, png: `QR_IMAGE:${png}` });
  openFile(png);
}

/**
 * 读取手机端提示的校验数字：有 TTY 走交互，无 TTY 等文件
 * @returns 校验码
 */
async function readVerifyCode(): Promise<string> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('请输入手机微信上显示的数字后回车：');
      return answer.trim();
    } finally {
      rl.close();
    }
  }
  log.warn('当前无交互终端，请在 60 秒内把校验码写入文件', { file: VERIFY_CODE_FILE });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(VERIFY_CODE_FILE)) {
      const code = fs.readFileSync(VERIFY_CODE_FILE, 'utf-8').trim();
      fs.rmSync(VERIFY_CODE_FILE, { force: true });
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return '';
}

/**
 * 执行一次完整扫码登录
 * @param opts - 是否强制刷新二维码
 * @returns 登录结果
 */
export async function login(opts: { force?: boolean } = {}): Promise<LoginResult> {
  const initial = await getBotQrcode('3');
  if (!initial.qrcode) {
    return { connected: false, message: `取二维码失败：${initial.errmsg ?? '响应缺少 qrcode'}` };
  }
  let qrcode = initial.qrcode;
  let content = initial.qrcode_img_content || initial.qrcode;
  let apiBase = LOGIN_BASE_URL;
  let refreshes = 0;
  let scannedHint = false;
  let verifyCode: string | undefined;

  await showQr(content);
  log.info('请用微信扫描二维码（建议先用小号试探；主号绑定后该号会被机器人接管）', {
    url: content,
  });

  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const status = await pollQrStatus(apiBase, qrcode, verifyCode);
    switch (status.status) {
      case 'wait':
        break;
      case 'scaned':
        if (verifyCode) verifyCode = undefined;
        if (!scannedHint) {
          process.stdout.write('\n已扫码，正在验证…\n');
          scannedHint = true;
        }
        break;
      case 'need_verifycode':
        verifyCode = await readVerifyCode();
        continue;
      case 'expired': {
        refreshes += 1;
        if (refreshes > MAX_REFRESH) return { connected: false, message: '二维码多次失效，请稍后重试' };
        const next = await getBotQrcode('3');
        if (!next.qrcode) return { connected: false, message: '刷新二维码失败' };
        qrcode = next.qrcode;
        content = next.qrcode_img_content || next.qrcode;
        scannedHint = false;
        await showQr(content);
        break;
      }
      case 'verify_code_blocked': {
        refreshes += 1;
        if (refreshes > MAX_REFRESH) return { connected: false, message: '校验码错误次数过多，流程已停止' };
        verifyCode = undefined;
        const next = await getBotQrcode('3');
        if (!next.qrcode) return { connected: false, message: '刷新二维码失败' };
        qrcode = next.qrcode;
        content = next.qrcode_img_content || next.qrcode;
        scannedHint = false;
        await showQr(content);
        break;
      }
      case 'scaned_but_redirect':
        if (status.redirect_host) apiBase = `https://${status.redirect_host}`;
        break;
      case 'binded_redirect':
        return {
          connected: false,
          message: '该微信号已绑定过其他 OpenClaw 形态的机器人，请先解绑再试',
        };
      case 'confirmed': {
        if (!status.ilink_bot_id || !status.bot_token) {
          return { connected: false, message: '登录已确认但响应缺少 bot_token / ilink_bot_id' };
        }
        const config = loadConfig();
        config.token = status.bot_token;
        config.baseUrl = status.baseurl || LOGIN_BASE_URL;
        config.botId = status.ilink_bot_id;
        if (status.ilink_user_id) config.ownerUserId = status.ilink_user_id;
        saveConfig(config);
        return {
          connected: true,
          message: '登录成功，token 已保存',
          token: config.token,
          baseUrl: config.baseUrl,
          botId: config.botId,
          ownerUserId: config.ownerUserId,
        };
      }
      default:
        log.debug('未知扫码状态，继续等待', { status: status.status });
        break;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { connected: false, message: '登录超时，请重试' };
}
