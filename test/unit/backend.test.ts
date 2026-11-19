import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { backendProfile, resolveConfigDir } from '../../src/bridge/backend.js';

describe('backendProfile', () => {
  it('国际版命令名推导 intl 画像', () => {
    expect(backendProfile('qodercli')).toEqual({
      kind: 'intl',
      memoryEnv: 'QODER_MEMORY_HEADLESS',
      configDirEnv: 'QODER_CONFIG_DIR',
      configDirName: '.qoder',
    });
  });

  it('CN 主程序名推导 cn 画像', () => {
    expect(backendProfile('qoderclicn')).toEqual({
      kind: 'cn',
      memoryEnv: 'QODERCN_MEMORY_HEADLESS',
      configDirEnv: 'QODERCN_CONFIG_DIR',
      configDirName: '.qoder-cn',
    });
  });

  it('CN dispatcher 名推导 cn 画像', () => {
    expect(backendProfile('qodercn').kind).toBe('cn');
  });

  it('绝对路径取 basename 推导', () => {
    expect(backendProfile('/usr/local/bin/qoderclicn').kind).toBe('cn');
    expect(backendProfile('/usr/local/bin/qodercli').kind).toBe('intl');
  });

  it('Windows npm shim 扩展名去除后推导', () => {
    for (const ext of ['.cmd', '.exe', '.bat', '.ps1']) {
      expect(backendProfile(`qoderclicn${ext}`).kind).toBe('cn');
      expect(backendProfile(`qodercli${ext}`).kind).toBe('intl');
    }
  });

  it('大小写不敏感', () => {
    expect(backendProfile('QODERCLICN').kind).toBe('cn');
    expect(backendProfile('QoderCliCn.CMD').kind).toBe('cn');
  });

  it('无法识别的名字回落 intl', () => {
    expect(backendProfile('my-wrapper').kind).toBe('intl');
    expect(backendProfile('qoder').kind).toBe('intl');
  });

  it('空串回落 intl', () => {
    expect(backendProfile('').kind).toBe('intl');
  });
});

describe('resolveConfigDir 覆盖变量按后端', () => {
  beforeEach(() => {
    delete process.env.QODER_CONFIG_DIR;
    delete process.env.QODERCN_CONFIG_DIR;
  });

  afterEach(() => {
    delete process.env.QODER_CONFIG_DIR;
    delete process.env.QODERCN_CONFIG_DIR;
  });

  it('CN 认 QODERCN_CONFIG_DIR 覆盖', () => {
    process.env.QODERCN_CONFIG_DIR = '/tmp/cn-override';
    expect(resolveConfigDir('qoderclicn')).toBe('/tmp/cn-override');
  });

  it('intl 认 QODER_CONFIG_DIR 覆盖', () => {
    process.env.QODER_CONFIG_DIR = '/tmp/intl-override';
    expect(resolveConfigDir('qodercli')).toBe('/tmp/intl-override');
  });

  it('CN 忽略国际版覆盖变量（不跨后端混目录）', () => {
    process.env.QODER_CONFIG_DIR = '/tmp/intl-override';
    expect(resolveConfigDir('qoderclicn')).toBe(path.join(os.homedir(), '.qoder-cn'));
  });

  it('intl 忽略 CN 覆盖变量', () => {
    process.env.QODERCN_CONFIG_DIR = '/tmp/cn-override';
    expect(resolveConfigDir('qodercli')).toBe(path.join(os.homedir(), '.qoder'));
  });

  it('空串与纯空白覆盖视为未设置', () => {
    process.env.QODERCN_CONFIG_DIR = '';
    expect(resolveConfigDir('qoderclicn')).toBe(path.join(os.homedir(), '.qoder-cn'));
    process.env.QODERCN_CONFIG_DIR = '   ';
    expect(resolveConfigDir('qoderclicn')).toBe(path.join(os.homedir(), '.qoder-cn'));
  });

  it('覆盖值两端空白被修剪', () => {
    process.env.QODERCN_CONFIG_DIR = '  /tmp/cn-override  ';
    expect(resolveConfigDir('qoderclicn')).toBe('/tmp/cn-override');
  });

  it('相对路径覆盖按桥接进程 cwd 解析为绝对路径', () => {
    process.env.QODERCN_CONFIG_DIR = 'relcfg';
    expect(resolveConfigDir('qoderclicn')).toBe(path.resolve('relcfg'));
    expect(path.isAbsolute(resolveConfigDir('qoderclicn'))).toBe(true);
  });

  it('无覆盖时按后端取默认目录', () => {
    expect(resolveConfigDir('qoderclicn')).toBe(path.join(os.homedir(), '.qoder-cn'));
    expect(resolveConfigDir('qodercli')).toBe(path.join(os.homedir(), '.qoder'));
  });
});