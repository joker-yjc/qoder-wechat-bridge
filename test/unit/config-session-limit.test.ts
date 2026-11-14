import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../../src/config.js';

let root = '';
const saved = { ...process.env };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwb-cfg-'));
  process.env.QWB_CONFIG_DIR = root;
  delete process.env.QWB_SESSION_LIST_LIMIT;
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sessionListLimit 配置', () => {
  it('应该默认 10', () => {
    expect(DEFAULT_CONFIG.sessionListLimit).toBe(10);
    expect(loadConfig().sessionListLimit).toBe(10);
  });

  it('应该支持 env 覆盖', () => {
    process.env.QWB_SESSION_LIST_LIMIT = '5';
    expect(loadConfig().sessionListLimit).toBe(5);
  });

  it('应该在非法值时回落默认', () => {
    process.env.QWB_SESSION_LIST_LIMIT = 'abc';
    expect(loadConfig().sessionListLimit).toBe(10);
    process.env.QWB_SESSION_LIST_LIMIT = '-3';
    expect(loadConfig().sessionListLimit).toBe(10);
  });

  it('应该校验配置文件里的非法上限（Minor-9）', () => {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ sessionListLimit: 0 }));
    expect(loadConfig().sessionListLimit).toBe(10);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ sessionListLimit: 5 }));
    expect(loadConfig().sessionListLimit).toBe(5);
  });
});