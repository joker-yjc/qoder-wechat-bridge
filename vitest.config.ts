import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { LOG_LEVEL: 'error' },
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // 未触达的通道/入口模块只做类型与构建校验；核心出站与运维逻辑纳入 95% 行覆盖门禁
      include: [
        'src/config.ts',
        'src/status.ts',
        'src/commands.ts',
        'src/diagnostics.ts',
        'src/notify.ts',
        'src/bridge/outbox.ts',
        'src/bridge/outbound.ts',
        'src/bridge/error-class.ts',
        'src/bridge/error-dedup.ts',
        'src/bridge/failure.ts',
        'src/bridge/qoder.ts',
        'src/bridge/preflight.ts',
        'src/bridge/lifecycle.ts',
        'src/bridge/instance-lock.ts',
        'src/bridge/sessions.ts',
        'src/bridge/commands/help.ts',
        'src/bridge/commands/reset.ts',
        'src/bridge/commands/status.ts',
        'src/bridge/commands/model.ts',
        'src/bridge/commands/sessions.ts',
        'src/bridge/commands/switch.ts',
        'src/bridge/commands/new.ts',
        'src/bridge/commands/rename.ts',
        'src/bridge/commands/delete.ts',
        'src/bridge/service.ts',
        'src/weixin/client.ts',
        'src/weixin/errors.ts',
      ],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        lines: 95,
      },
    },
  },
});
