#!/usr/bin/env node
const mode = process.env.FAKE_QODER_MODE ?? 'ok';
const ok = (result) => {
  process.stdout.write(JSON.stringify(result));
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
  default:
    process.exitCode = 2;
}
