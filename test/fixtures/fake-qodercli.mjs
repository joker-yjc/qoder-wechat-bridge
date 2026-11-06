#!/usr/bin/env node
const mode = process.env.FAKE_QODER_MODE ?? 'ok';
const ok = (result) => {
  process.stdout.write(JSON.stringify(result));
};

// 2026-11-05 真实样本：额度耗尽（error_code 为数字 110），退出码 1 与 0 两种形态共用
const QUOTA_110 = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  num_turns: 1,
  stop_reason: 'stop_sequence',
  result: '',
  session_id: 'sess-quota',
  modelUsage: { '<synthetic>': { inputTokens: 0, outputTokens: 0 } },
  permission_denials: [],
  errors: [
    "You've reached your daily usage limit for Chat. Come back tomorrow to continue working with me. Report Issue (input /feedback)",
  ],
  error_code: 110,
  error_message: 'Billing daily count exceeded',
};

switch (mode) {
  case 'ok':
    ok({ type: 'result', result: 'hello', session_id: 's1', modelUsage: { 'model-x': 1 } });
    process.exitCode = 0;
    break;
  case 'exit1':
    ok({ type: 'result', result: 'partial', session_id: 's3' });
    process.exitCode = 1;
    break;
  case 'is_error':
    ok({ type: 'result', is_error: true, result: 'boom\nstack', session_id: 's2' });
    process.exitCode = 0;
    break;
  case 'parse':
    process.stdout.write('not-json');
    process.exitCode = 0;
    break;
  case 'empty':
    process.exitCode = 0;
    break;
  case 'empty-fail':
    process.exitCode = 1;
    break;
  case 'stderr-261k':
    process.stderr.write('x'.repeat(261_000));
    process.exitCode = 1;
    break;
  case 'timeout':
    setTimeout(() => {}, 10_000);
    break;
  // 以下 5 个模式取自本机真实诊断样本：
  // ~/.local/state/qoder-wechat-bridge/logs/diagnostics/2026-11-05/ 与 .../2026-11-06/
  case 'quota-110':
    ok(QUOTA_110);
    process.exitCode = 1;
    break;
  case 'quota-110-exit0':
    ok(QUOTA_110);
    process.exitCode = 0;
    break;
  case 'max-output-tokens':
    ok({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 4,
      stop_reason: 'max_tokens',
      result: '',
      session_id: 'sess-truncated',
      modelUsage: { 'qoder-custom/Qwen3.8-27B': { inputTokens: 0, outputTokens: 0 } },
      permission_denials: [],
      errors: [
        'The model reached its output token limit and the response is incomplete. Please try again or break the task into smaller parts.',
      ],
      error_code: 'max_output_tokens',
    });
    process.exitCode = 1;
    break;
  case 'max-output-tokens-exit0':
    ok({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'max_tokens',
      result: 'half answer',
      session_id: 'sess-truncated-exit0',
      error_code: 'max_output_tokens',
    });
    process.exitCode = 0;
    break;
  case 'auth-failed':
    ok({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: 'stop_sequence',
      result: '',
      session_id: 'sess-auth',
      errors: ['Authentication failed for the current account.'],
      error_code: 'authentication_failed',
    });
    process.exitCode = 1;
    break;
  case 'semantic-unknown':
    ok({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: 'stop_sequence',
      result: '',
      session_id: 'sess-unknown',
      errors: ['Rate limit exceeded, please slow down.'],
      error_code: 'rate_limit',
    });
    process.exitCode = 1;
    break;
  case 'resume-failed':
    ok({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: 'stop_sequence',
      result: '',
      session_id: 'sess-resume',
      errors: ['No such session: resume not found'],
      error_code: 'invalid_request',
    });
    process.exitCode = 1;
    break;
  default:
    process.exitCode = 2;
}
