import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { detectNodeChange, nodeFingerprint, runPreflight } from '../../src/bridge/preflight.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-qodercli.mjs', import.meta.url));

beforeAll(() => {
  if (process.platform !== 'win32') fs.chmodSync(fixture, 0o755);
});

afterEach(() => {
  delete process.env.FAKE_QODER_MODE;
});

describe('nodeFingerprint', () => {
  it('应该记录当前 Node 的路径、inode 与版本', () => {
    const fingerprint = nodeFingerprint();
    expect(fingerprint.path).toBe(process.execPath);
    expect(fingerprint.version).toBe(process.versions.node);
    expect(fingerprint.ino).toBeGreaterThan(0);
  });

  it('应该在 stat 失败时回退为 0', () => {
    const fingerprint = nodeFingerprint({
      statFile: () => {
        throw new Error('missing');
      },
    });
    expect(fingerprint.ino).toBe(0);
    expect(fingerprint.mtimeMs).toBe(0);
  });
});

describe('detectNodeChange', () => {
  const base = { path: '/node', ino: 1, mtimeMs: 1, version: '24.0.0' };

  it('应该识别路径、inode 与版本变化', () => {
    expect(detectNodeChange(base, { ...base, path: '/other' })).toBe('path');
    expect(detectNodeChange(base, { ...base, ino: 2 })).toBe('inode');
    expect(detectNodeChange(base, { ...base, version: '24.1.0' })).toBe('version');
  });

  it('应该在无变化时返回 null', () => {
    expect(detectNodeChange(base, { ...base })).toBeNull();
  });
});

describe('runPreflight', () => {
  const deps = {
    nodeVersion: '24.0.0',
    execPath: '/node',
    statFile: () => ({ ino: 1, mtimeMs: 1 }),
    resolveBin: () => '/bin/qodercli',
    runVersion: async () => '1.1.81',
  };

  it('应该在 Node 版本过低时失败', async () => {
    const result = await runPreflight({
      qoderBin: 'qodercli',
      versionTimeoutMs: 100,
      deps: { ...deps, nodeVersion: '18.19.0' },
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.kind)).toContain('node_version');
    expect(result.node.major).toBe(18);
    expect(result.qodercli).toEqual({ path: '/bin/qodercli', version: '1.1.81' });
  });

  it('应该在 qodercli 缺失时失败', async () => {
    const result = await runPreflight({
      qoderBin: 'qodercli',
      versionTimeoutMs: 100,
      deps: { ...deps, resolveBin: () => null },
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.kind)).toEqual(['qoder_missing']);
    expect(result.qodercli).toBeNull();
  });

  it('应该在版本检查失败时失败', async () => {
    const result = await runPreflight({
      qoderBin: 'qodercli',
      versionTimeoutMs: 100,
      deps: { ...deps, runVersion: async () => null },
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.kind)).toEqual(['qoder_version']);
  });

  it('应该在全部通过时返回路径与版本', async () => {
    const result = await runPreflight({ qoderBin: 'qodercli', versionTimeoutMs: 100, deps });

    expect(result).toMatchObject({
      ok: true,
      node: { version: '24.0.0', major: 24, execPath: '/node' },
      qodercli: { path: '/bin/qodercli', version: '1.1.81' },
      failures: [],
    });
  });

  it('应该用默认实现检查绝对路径与 which', async () => {
    const absolute = await runPreflight({ qoderBin: process.execPath, versionTimeoutMs: 5_000 });
    expect(absolute.ok).toBe(true);
    expect(absolute.qodercli?.path).toBe(process.execPath);

    const viaPath = await runPreflight({ qoderBin: 'node', versionTimeoutMs: 5_000 });
    expect(viaPath.ok).toBe(true);
    expect(viaPath.qodercli?.version).toContain('v');
  });

  it('应该在命令不存在时返回 qoder_missing', async () => {
    const result = await runPreflight({
      qoderBin: 'definitely-not-a-real-qodercli-xyz',
      versionTimeoutMs: 100,
    });
    expect(result.failures.map((failure) => failure.kind)).toEqual(['qoder_missing']);
  });

  it('应该在默认版本检查超时时返回 qoder_version', async () => {
    process.env.FAKE_QODER_MODE = 'timeout';
    const result = await runPreflight({ qoderBin: fixture, versionTimeoutMs: 100 });
    expect(result.failures.map((failure) => failure.kind)).toEqual(['qoder_version']);
  });

  it('应该在 win32 分支使用 where 并优雅失败', async () => {
    const result = await runPreflight({
      qoderBin: 'node',
      versionTimeoutMs: 100,
      deps: { platform: 'win32' },
    });
    expect(result.failures.map((failure) => failure.kind)).toEqual(['qoder_missing']);
  });
});
