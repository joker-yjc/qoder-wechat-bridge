/**
 * 模型目录：内置模型取自 qodercli --list-models，自定义模型取自 Qoder 配置
 * @module models
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from './log.js';
import { cleanEnv } from './bridge/qoder.js';

/** 一个可选模型 */
export interface ModelOption {
  /** 展示名 */
  label: string;
  /** 传给 qodercli -m 的取值 */
  id: string;
  /** 是否自定义 provider 下的模型 */
  custom: boolean;
}

/** Qoder 配置目录 */
function qoderConfigDir(): string {
  return process.env.QODER_CONFIG_DIR ?? path.join(os.homedir(), '.qoder');
}

/**
 * 解析 `qodercli --list-models` 的内置模型
 * 自定义模型在该输出里会被截断，这里只取不含括号的行
 * @param bin - qodercli 路径
 * @returns 内置模型列表
 */
function listBuiltinModels(bin: string): ModelOption[] {
  try {
    const out = execFileSync(bin, ['--list-models'], {
      env: cleanEnv(),
      encoding: 'utf-8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const options: ModelOption[] = [];
    for (const raw of out.split('\n')) {
      const line = raw.trim();
      if (!line || line === 'MODEL' || line.includes('(')) continue;
      options.push({ label: line, id: line, custom: false });
    }
    return options;
  } catch (err) {
    log.warn('读取内置模型列表失败', { error: String(err) });
    return [{ label: 'Auto', id: 'Auto', custom: false }];
  }
}

/**
 * 从 Qoder 配置文件读取自定义 provider 下的模型
 * 结构（非公开契约，按当前版本解析，失败即降级）：
 * providers.<providerId>.models[].model / displayName
 * @returns 自定义模型列表
 */
function listCustomModels(): ModelOption[] {
  try {
    const settingsPath = path.join(qoderConfigDir(), 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      providers?: Record<string, { models?: Array<{ model?: string; displayName?: string }> }>;
    };
    const options: ModelOption[] = [];
    for (const [providerId, provider] of Object.entries(settings.providers ?? {})) {
      for (const model of provider.models ?? []) {
        if (!model.model) continue;
        options.push({
          label: model.displayName ?? model.model,
          id: `${providerId}/${model.model}`,
          custom: true,
        });
      }
    }
    return options;
  } catch (err) {
    log.debug('读取自定义模型失败', { error: String(err) });
    return [];
  }
}

/** 模型目录缓存，避免每次 /model 都拉起 CLI */
let cache: { bin: string; at: number; options: ModelOption[] } | null = null;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * 汇总可选模型
 * @param bin - qodercli 路径
 * @returns 模型列表（内置在前，自定义在后）
 */
export function listModels(bin: string): ModelOption[] {
  if (cache && cache.bin === bin && Date.now() - cache.at < CACHE_TTL_MS) return cache.options;
  const seen = new Set<string>();
  const all = [...listBuiltinModels(bin), ...listCustomModels()];
  const options = all.filter((option) => {
    const key = option.id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  cache = { bin, at: Date.now(), options };
  return options;
}

/**
 * 把用户输入解析成模型 id
 * 支持：序号（从 1 开始）、展示名、id、去掉 [provider] 前缀的名字
 * @param input - 用户输入
 * @param catalog - 模型列表
 * @returns 解析结果
 */
export function resolveModel(
  input: string,
  catalog: ModelOption[],
): { ok: true; option: ModelOption } | { ok: false } {
  const value = input.trim();
  if (!value) return { ok: false };

  if (/^\d+$/.test(value)) {
    const index = Number(value) - 1;
    const option = catalog[index];
    if (option) return { ok: true, option };
    return { ok: false };
  }

  const lower = value.toLowerCase();
  const exact = catalog.find((o) => o.id.toLowerCase() === lower || o.label.toLowerCase() === lower);
  if (exact) return { ok: true, option: exact };

  // 允许只写 "] " 之后的部分，例如 "glm-5.3"
  const afterBracket = catalog.find((o) => {
    const idx = o.label.indexOf('] ');
    return idx >= 0 && o.label.slice(idx + 2).toLowerCase() === lower;
  });
  if (afterBracket) return { ok: true, option: afterBracket };

  return { ok: false };
}

/**
 * 生成 `/model` 的列表文本
 * @param catalog - 模型列表
 * @param currentId - 当前模型 id，空串表示 Auto
 * @returns 可直接发到微信的文本
 */
export function formatModelList(catalog: ModelOption[], currentId: string): string {
  const lines = [`当前模型：${currentId || 'Auto（默认）'}`, '', '发送 /model <序号或名称> 切换：'];
  catalog.forEach((option, index) => {
    lines.push(`${index + 1}. ${option.label}`);
  });
  return lines.join('\n');
}
