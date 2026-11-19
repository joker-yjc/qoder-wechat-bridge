import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => 'Auto\n') }));

import { clearModelCache, listModels } from '../../src/models.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-models-'));
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  delete process.env.QODER_CONFIG_DIR;
  delete process.env.QODERCN_CONFIG_DIR;
  clearModelCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.QODER_CONFIG_DIR;
  delete process.env.QODERCN_CONFIG_DIR;
  clearModelCache();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 写一份含单个自定义 provider 的 settings.json */
function writeSettings(dir: string, providerId: string, model: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ providers: { [providerId]: { models: [{ model, displayName: model }] } } }),
  );
}

describe('listModels 配置目录按后端', () => {
  it('intl 认 QODER_CONFIG_DIR 覆盖', () => {
    const override = path.join(root, 'override-intl');
    writeSettings(override, 'pov-intl', 'm-ov-intl');
    process.env.QODER_CONFIG_DIR = override;
    const options = listModels('/opt/qodercli');
    expect(options.some((o) => o.id === 'pov-intl/m-ov-intl' && o.custom)).toBe(true);
  });

  it('CN 认 QODERCN_CONFIG_DIR 覆盖', () => {
    const override = path.join(root, 'override-cn');
    writeSettings(override, 'pov-cn', 'm-ov-cn');
    process.env.QODERCN_CONFIG_DIR = override;
    const options = listModels('qoderclicn');
    expect(options.some((o) => o.id === 'pov-cn/m-ov-cn' && o.custom)).toBe(true);
  });

  it('CN 忽略国际版覆盖变量，仍读 CN 默认目录', () => {
    const intlOverride = path.join(root, 'override-intl');
    writeSettings(intlOverride, 'pov-intl', 'm-ov-intl');
    process.env.QODER_CONFIG_DIR = intlOverride;
    writeSettings(path.join(root, '.qoder-cn'), 'pcn-default', 'm-cn-default');
    const options = listModels('qodercn');
    expect(options.some((o) => o.id === 'pcn-default/m-cn-default')).toBe(true);
    expect(options.some((o) => o.id === 'pov-intl/m-ov-intl')).toBe(false);
  });

  it('CN 后端默认读 ~/.qoder-cn', () => {
    writeSettings(path.join(root, '.qoder-cn'), 'pcn', 'm-cn');
    const options = listModels('qoderclicn');
    expect(options.some((o) => o.id === 'pcn/m-cn' && o.custom)).toBe(true);
  });

  it('国际版后端默认读 ~/.qoder（绝对路径取 basename）', () => {
    writeSettings(path.join(root, '.qoder'), 'pintl', 'm-intl');
    const options = listModels('/usr/local/bin/qodercli');
    expect(options.some((o) => o.id === 'pintl/m-intl' && o.custom)).toBe(true);
  });

  it('settings.json 损坏时自定义降级为空且内置仍在', () => {
    fs.mkdirSync(path.join(root, '.qoder-cn'), { recursive: true });
    fs.writeFileSync(path.join(root, '.qoder-cn', 'settings.json'), 'not-json');
    const options = listModels('qodercn');
    expect(options.filter((o) => o.custom)).toEqual([]);
    expect(options.some((o) => o.id === 'Auto')).toBe(true);
  });

  it('同 bin 命中缓存、不同 bin 重新读取（缓存按 bin 隔离）', () => {
    const cnDir = path.join(root, '.qoder-cn');
    writeSettings(cnDir, 'pfirst', 'm-first');
    const first = listModels('qoderclicn');
    expect(first.some((o) => o.id === 'pfirst/m-first')).toBe(true);

    // 覆盖目录内容后，同 bin 仍命中旧缓存
    writeSettings(cnDir, 'psecond', 'm-second');
    const cached = listModels('qoderclicn');
    expect(cached.some((o) => o.id === 'pfirst/m-first')).toBe(true);
    expect(cached.some((o) => o.id === 'psecond/m-second')).toBe(false);

    // 同后端不同 bin 写法（dispatcher）键不同，重新读取新目录
    const fresh = listModels('qodercn');
    expect(fresh.some((o) => o.id === 'psecond/m-second')).toBe(true);
    expect(fresh.some((o) => o.id === 'pfirst/m-first')).toBe(false);
  });

  it('内置模型查询把后端配置目录传给子进程 env', () => {
    writeSettings(path.join(root, '.qoder-cn'), 'pcn', 'm-cn');
    listModels('qoderclicn');
    const calls = (execFileSync as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const opts = calls[calls.length - 1]?.[2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.QODERCN_CONFIG_DIR).toBe(path.join(root, '.qoder-cn'));
    expect(opts.env.QODER_CONFIG_DIR).toBeUndefined();
  });
});