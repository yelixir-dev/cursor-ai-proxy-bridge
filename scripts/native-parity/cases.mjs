import path from 'node:path';
const CASES = ['chat', 'parallel', 'sequential', 'cancel'];

export function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !['--case', '--evidence-dir'].includes(argv[i]) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith('--') ||
      parsed[argv[i]]
    )
      throw new Error('invalid_arguments');
    parsed[argv[i]] = argv[i + 1];
  }
  if (!CASES.includes(parsed['--case']) || !parsed['--evidence-dir'])
    throw new Error('usage: --case chat|parallel|sequential|cancel --evidence-dir NEW_DIRECTORY');
  return { caseId: parsed['--case'], evidenceDir: path.resolve(parsed['--evidence-dir']) };
}

export function promptFor(caseId) {
  return {
    chat: 'Reply with exactly WIRE_OK. Do not use tools.',
    parallel:
      'Call echo_value twice in parallel in the same assistant turn, once with {"value":"WIRE_A"} and once with {"value":"WIRE_B"}. After both results, reply with exactly DONE. Do not use any other tools.',
    sequential:
      'Call lookup_code with {"key":"ALPHA"}. Wait for its result, then call finish_code with {"code":<the exact returned string>}. The second argument must come from the first result. After the second result, reply with exactly DONE. Do not use any other tools.',
    cancel: 'Write the integers from 1 through 10000, one integer per line. Do not use tools.',
  }[caseId];
}

export function validateCase(caseId, result, { requireRecovery = false } = {}) {
  const failures = [];
  const calls = result.calls ?? [];
  if (result.toolErrors) failures.push('tool_errors');
  if (result.unexpectedNativeTools) failures.push('unexpected_native_tools');
  if (caseId === 'cancel') {
    if (requireRecovery && !result.recovery?.ok) failures.push('post_cancel_recovery_failed');
    if (!result.cancelled || !result.text) failures.push('no_text_trigger');
    if (!result.upstreamClosedBeforeCleanup) failures.push('upstream_not_closed_before_cleanup');
    if (calls.length) failures.push('unexpected_tools');
  } else {
    if (!result.terminal) failures.push('no_successful_terminal');
    if (result.text?.trim() !== (caseId === 'chat' ? 'WIRE_OK' : 'DONE'))
      failures.push('wrong_final_text');
    if (caseId === 'chat' && calls.length) failures.push('unexpected_tools');
    if (caseId === 'parallel') {
      if (
        result.rounds &&
        (result.rounds[0]?.toolCount !== 2 ||
          result.rounds.slice(1).some((round) => round.toolCount))
      )
        failures.push('calls_not_in_same_turn');
      if (
        calls.length !== 2 ||
        calls.some((c) => c.name !== 'echo_value' || c.result !== c.args.value) ||
        JSON.stringify(calls.map((c) => c.args.value).sort()) !==
          JSON.stringify(['WIRE_A', 'WIRE_B'])
      )
        failures.push('parallel_call_mismatch');
    }
    if (caseId === 'sequential') {
      if (
        calls.length !== 2 ||
        calls[0]?.name !== 'lookup_code' ||
        calls[0]?.args.key !== 'ALPHA' ||
        calls[1]?.name !== 'finish_code' ||
        calls[1]?.args.code !== calls[0]?.result ||
        calls[1]?.result !== 'DONE'
      )
        failures.push('dependent_call_mismatch');
    }
  }
  return { ok: failures.length === 0, failures };
}
