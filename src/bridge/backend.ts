/**
 * CLI 后端画像：由 qoderBin 命令名推导国际版 / CN 版差异
 * backendProfile 为纯函数；resolveConfigDir 读取 env/home，不执行 CLI、零运行时探测
 * CN 判定依据 @qodercn-ai/qoderclicn 官方包的两个 bin 名
 * @module bridge/backend
 */
import os from 'node:os';
import path from 'node:path';

/** 后端画像 */
export interface BackendProfile {
  /** 后端类别：国际版 / CN 版 */
  kind: 'intl' | 'cn';
  /** headless 长期记忆开关 env 名（CN 包 yo() 前缀函数实测为 QODERCN_） */
  memoryEnv: string;
  /** 用户配置目录覆盖 env 名（两版不同：CN 认 QODERCN_CONFIG_DIR，intl 认 QODER_CONFIG_DIR，真机对照实测） */
  configDirEnv: string;
  /** 用户配置目录名（主目录下；CN 品牌常量 BRAND_USER_CONFIG_DIR_NAME 实测） */
  configDirName: string;
}

/** CN 官方包的两个 bin 名（主程序 + dispatcher） */
const CN_BINS = new Set(['qoderclicn', 'qodercn']);

/** 国际版画像（默认回落） */
const INTL_PROFILE: BackendProfile = {
  kind: 'intl',
  memoryEnv: 'QODER_MEMORY_HEADLESS',
  configDirEnv: 'QODER_CONFIG_DIR',
  configDirName: '.qoder',
};

/** CN 版画像 */
const CN_PROFILE: BackendProfile = {
  kind: 'cn',
  memoryEnv: 'QODERCN_MEMORY_HEADLESS',
  configDirEnv: 'QODERCN_CONFIG_DIR',
  configDirName: '.qoder-cn',
};

/**
 * 推导后端画像；无法识别的 bin 名回落国际版
 * @param bin - 配置的 qoderBin（命令名或路径）
 * @returns 后端画像
 */
export function backendProfile(bin: string): BackendProfile {
  const base = path
    .basename(bin)
    .replace(/\.(cmd|exe|bat|ps1)$/i, '')
    .toLowerCase();
  return CN_BINS.has(base) ? CN_PROFILE : INTL_PROFILE;
}

/**
 * 解析当前后端的用户配置目录：只认本后端的覆盖变量（空串/空白视为未设置），否则取默认目录
 * 不跨后端读覆盖变量，避免桌面 shell 继承的旧后端目录混入
 * @param bin - 配置的 qoderBin
 * @returns 配置目录绝对路径；相对覆盖值按桥接进程 cwd 解析（path.resolve），不展开 ~
 */
export function resolveConfigDir(bin: string): string {
  const profile = backendProfile(bin);
  const override = process.env[profile.configDirEnv]?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), profile.configDirName);
}