import { describe, expect, it, vi } from 'vitest';
import type { RunInfo } from '../../src/config.js';
import {
  findLaunchdServices,
  formatStopOutcome,
  isAlive,
  isBridgeProcess,
  launchdLabel,
  listBridgeProcesses,
  parseLaunchctlList,
  parsePsOutput,
  planStop,
  stopExitCode,
  stopService,
  type BridgeProcess,
  type LaunchdService,
} from '../../src/bridge/lifecycle.js';

/** 构造运行记录 */
function runInfo(pid: number): RunInfo {
  return { pid, ppid: 0, startedAt: '', cwd: '' };
}

/** 构造进程 */
function proc(pid: number, command = 'node /usr/local/bin/qoder-wechat run'): BridgeProcess {
  return { pid, command };
}

/** 构造 launchd 服务 */
function service(pid: number, label = 'com.example.qoder-wechat'): LaunchdService {
  return { pid, label, domain: 'gui/501' };
}

describe('解析发现结果', () => {
  it('应该只保留桥接 run 进程', () => {
    const output = [
      '  123 node /usr/local/bin/qoder-wechat run',
      '  124 node /usr/local/bin/qoder-wechat stop',
      '  125 node dist/cli.js run',
      '  126 vim',
      '  127 /bin/zsh -c cd /tmp && node dist/cli.js run',
      '  128 C:\\node\\node.exe dist\\cli.js run',
      'not-a-process',
    ].join('\n');

    expect(parsePsOutput(output).map((process) => process.pid)).toEqual([123, 125, 128]);
  });

  it('应该只保留桥接 launchd 标签并支持未运行实例', () => {
    const output = [
      '123\t0\tcom.example.qoder-wechat',
      '-\t0\tcom.example.other',
      '456\t0\tcom.example.wechat-bridge',
    ].join('\n');

    const services = parseLaunchctlList(output, 'gui/501');
    expect(services).toEqual([
      { pid: 123, label: 'com.example.qoder-wechat', domain: 'gui/501' },
      { pid: 456, label: 'com.example.wechat-bridge', domain: 'gui/501' },
    ]);
  });
});

describe('planStop', () => {
  it('应该在什么都没发现时返回 idle', () => {
    const decision = planStop({
      runInfo: null,
      runInfoAlive: false,
      runInfoIsBridge: false,
      processes: [],
      launchd: [],
    });
    expect(decision).toEqual({ kind: 'idle', staleRunInfo: undefined });
  });

  it('应该在 run.json 失效时返回 idle 并带 stale pid', () => {
    const decision = planStop({
      runInfo: runInfo(10),
      runInfoAlive: false,
      runInfoIsBridge: false,
      processes: [],
      launchd: [],
    });
    expect(decision).toEqual({ kind: 'idle', staleRunInfo: 10 });
  });

  it('应该在只有一个手动实例时发信号', () => {
    const decision = planStop({
      runInfo: null,
      runInfoAlive: false,
      runInfoIsBridge: false,
      processes: [proc(1)],
      launchd: [],
    });
    expect(decision).toEqual({ kind: 'signal', pids: [1], extra: [], staleRunInfo: undefined });
  });

  it('应该在 run.json 有效时优先停止主实例并报告额外实例', () => {
    const decision = planStop({
      runInfo: runInfo(1),
      runInfoAlive: true,
      runInfoIsBridge: true,
      processes: [proc(1), proc(2)],
      launchd: [],
    });
    expect(decision).toEqual({
      kind: 'signal',
      pids: [1],
      extra: [proc(2)],
      staleRunInfo: undefined,
    });
  });

  it('应该在 run.json 有效但进程列表缺失时补上主实例', () => {
    const decision = planStop({
      runInfo: runInfo(1),
      runInfoAlive: true,
      runInfoIsBridge: true,
      processes: [],
      launchd: [],
    });
    expect(decision).toEqual({
      kind: 'signal',
      pids: [1],
      extra: [],
      staleRunInfo: undefined,
    });
  });

  it('应该在多个手动实例时报告冲突', () => {
    const decision = planStop({
      runInfo: null,
      runInfoAlive: false,
      runInfoIsBridge: false,
      processes: [proc(1), proc(2)],
      launchd: [],
    });
    expect(decision.kind).toBe('conflict');
  });

  it('应该优先返回 launchd 托管并区分额外手动实例', () => {
    const decision = planStop({
      runInfo: runInfo(1),
      runInfoAlive: true,
      runInfoIsBridge: true,
      processes: [proc(1), proc(2)],
      launchd: [service(1)],
    });
    expect(decision).toEqual({
      kind: 'supervised',
      supervised: [service(1)],
      extra: [proc(2)],
    });
  });
});

describe('formatStopOutcome', () => {
  it('应该输出 idle / stopped / timeout', () => {
    expect(formatStopOutcome({ kind: 'idle', message: '未运行' })).toBe('未运行');
    expect(formatStopOutcome({ kind: 'stopped', pids: [1], waitedMs: 20 })).toContain('已停止');
    expect(formatStopOutcome({ kind: 'timeout', pids: [1], waitedMs: 20 })).toContain('第二次信号');
  });

  it('应该输出 launchd 的停止、验证、恢复与兜底命令', () => {
    const text = formatStopOutcome({
      kind: 'supervised',
      supervised: [service(1)],
      extra: [proc(2)],
    });

    expect(text).toContain('launchctl bootout gui/501/com.example.qoder-wechat');
    expect(text).toContain('launchctl print gui/501/com.example.qoder-wechat');
    expect(text).toContain('launchctl bootstrap gui/501');
    expect(text).toContain('pkill -TERM -f "qoder-wechat run"');
    expect(text).toContain('kill -TERM 2');
  });

  it('应该输出冲突与权限不足的精确命令', () => {
    expect(
      formatStopOutcome({ kind: 'conflict', processes: [proc(1), proc(2)], detail: '冲突' }),
    ).toContain('kill -TERM 2');
    expect(formatStopOutcome({ kind: 'permission', pids: [1], reason: 'EPERM' })).toContain('kill -TERM 1');
  });
});

describe('stopExitCode', () => {
  it('应该按结果返回退出码', () => {
    expect(stopExitCode({ kind: 'idle', message: '' })).toBe(0);
    expect(stopExitCode({ kind: 'stopped', pids: [1], waitedMs: 1 })).toBe(0);
    expect(stopExitCode({ kind: 'timeout', pids: [1], waitedMs: 1 })).toBe(1);
    expect(stopExitCode({ kind: 'supervised', supervised: [service(1)], extra: [] })).toBe(2);
    expect(stopExitCode({ kind: 'conflict', processes: [], detail: '' })).toBe(2);
    expect(stopExitCode({ kind: 'permission', pids: [], reason: '' })).toBe(2);
  });
});

describe('stopService', () => {
  it('应该在 idle 时清理失效运行记录', async () => {
    const clear = vi.fn();
    const result = await stopService(0, {
      readRunInfo: () => runInfo(10),
      isAlive: () => false,
      listBridgeProcesses: () => [],
      findLaunchdServices: () => [],
      clearRunInfo: clear,
    });

    expect(result.kind).toBe('idle');
    expect(clear).toHaveBeenCalledWith(10);
  });

  it('应该在手动实例退出后返回 stopped', async () => {
    let alive = true;
    const result = await stopService(100, {
      readRunInfo: () => null,
      isAlive: () => alive,
      isBridgeProcess: () => false,
      listBridgeProcesses: () => [proc(1)],
      findLaunchdServices: () => [],
      clearRunInfo: () => undefined,
      kill: () => {
        alive = false;
      },
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(result).toEqual({ kind: 'stopped', pids: [1], waitedMs: 0 });
  });

  it('应该在等待轮询后确认退出', async () => {
    let alive = true;
    const result = await stopService(100, {
      readRunInfo: () => null,
      isAlive: () => alive,
      isBridgeProcess: () => false,
      listBridgeProcesses: () => [proc(1)],
      findLaunchdServices: () => [],
      clearRunInfo: () => undefined,
      kill: () => undefined,
      sleep: async () => {
        alive = false;
      },
      now: () => 0,
    });

    expect(result.kind).toBe('stopped');
  });

  it('应该在进程未退出时返回 timeout', async () => {
    const result = await stopService(0, {
      readRunInfo: () => null,
      isAlive: () => true,
      isBridgeProcess: () => false,
      listBridgeProcesses: () => [proc(1)],
      findLaunchdServices: () => [],
      clearRunInfo: () => undefined,
      kill: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(result.kind).toBe('timeout');
  });

  it('应该在 kill 抛错时返回 permission', async () => {
    const result = await stopService(0, {
      readRunInfo: () => null,
      isAlive: () => true,
      isBridgeProcess: () => false,
      listBridgeProcesses: () => [proc(1)],
      findLaunchdServices: () => [],
      clearRunInfo: () => undefined,
      kill: () => {
        throw new Error('EPERM');
      },
    });

    expect(result).toMatchObject({ kind: 'permission', pids: [1], reason: 'EPERM' });
  });

  it('应该在 launchd 托管时返回 supervised', async () => {
    const result = await stopService(0, {
      readRunInfo: () => null,
      listBridgeProcesses: () => [],
      findLaunchdServices: () => [service(1)],
    });

    expect(result.kind).toBe('supervised');
  });

  it('应该在多个手动实例时返回 conflict', async () => {
    const result = await stopService(0, {
      readRunInfo: () => null,
      listBridgeProcesses: () => [proc(1), proc(2)],
      findLaunchdServices: () => [],
    });

    expect(result.kind).toBe('conflict');
  });

  it('应该在主实例停止后报告其它实例冲突', async () => {
    let primaryAlive = true;
    const result = await stopService(100, {
      readRunInfo: () => runInfo(1),
      isAlive: (pid) => (pid === 1 ? primaryAlive : true),
      isBridgeProcess: () => true,
      listBridgeProcesses: () => [proc(1), proc(2)],
      findLaunchdServices: () => [],
      clearRunInfo: () => undefined,
      kill: () => {
        primaryAlive = false;
      },
      sleep: async () => undefined,
      now: () => 0,
    });

    expect(result).toMatchObject({ kind: 'conflict', processes: [proc(2)] });
  });

  it('应该用默认依赖处理空发现结果', async () => {
    const result = await stopService(0, {
      readRunInfo: () => null,
      listBridgeProcesses: () => [],
      findLaunchdServices: () => [],
    });
    expect(result.kind).toBe('idle');
  });
});

describe('真实进程探测', () => {
  it('应该正确判断当前进程存活', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(0)).toBe(false);
  });

  it('应该返回进程列表且不把测试进程当成桥接', () => {
    expect(Array.isArray(listBridgeProcesses())).toBe(true);
    expect(isBridgeProcess(process.pid)).toBe(false);
    expect(isBridgeProcess(process.ppid)).toBe(false);
    expect(isBridgeProcess(1, 'win32')).toBe(false);
    expect(listBridgeProcesses('win32')).toEqual([]);
  });

  it('应该按平台处理 launchd 发现', () => {
    expect(findLaunchdServices('linux')).toEqual([]);
    expect(Array.isArray(findLaunchdServices())).toBe(true);
    expect(launchdLabel(process.pid)).toBeNull();
  });
});
