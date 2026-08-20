# Cursor Composer Parity — Current Status (2026-08-20)

Scope: deterministic native Cursor Composer vs yorha bridge benchmark, bridge
remediation, and final verification. Plan:
`.omo/plans/cursor-composer-parity-benchmark.md` (local only; `.omo/` is
gitignored). Evidence: `.omo/evidence/cursor-composer-parity-benchmark/`.

## Verdict

`COMPLETE_WITH_RETAINED_FAILS` — all 16 plan checkboxes closed; Task 12 (live
E2E/CI) and F3 (live manual QA) closed via explicit user override with retained
FAIL verdicts. No bridge-product defect was found in any retained failure.

## What improved (objective)

| Area                                | Change                                                                                         | Evidence                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Composer metadata / tool scheduling | Aligned with native comparator                                                                 | Task 1–2 regression tests                          |
| Conversation history                | Flat strings → structured history mapping                                                      | Task 3                                             |
| HTTP/2                              | Healthy session reuse across runs (CI: ~99.1% reuse)                                           | Task 4, Task 12 CI                                 |
| Tool streaming                      | Incremental tool decision/argument streaming                                                   | Task 10 (508 tests)                                |
| Lifecycle                           | Cancellation, retry, usage, backend attribution (`cursor-api` consistent)                      | Task 11                                            |
| Parallel tool settlement            | `setImmediate` timing drain → authoritative `turnEnded` / Connect trailer boundary             | F2 R2 integrated verifier, mutation kills          |
| Validation retry                    | Request-scoped semantic-output gate blocks credential replay after visible output              | F2 security remediation                            |
| Type/quality gates                  | non-null / `any` / suppressions 67 → 0; `check:strict` in `verify`                             | `scripts/check-strict-assertions.mjs`              |
| Security housekeeping               | `.env` 0600, credential inventory removed from health, bounded response memory                 | F2 security track                                  |
| Benchmark infra                     | native-vs-yorha harness, hermetic comparator (omo-ai beta.9), raw→sanitized→forensics pipeline | `src/benchmark/`, `scripts/benchmark-composer.mjs` |

## Quality numbers

- `npm run verify`: PASS — typecheck, lint, format, strict gate, **508/508 tests**, build
- Final audits: F1 PASS, F2 PASS (post-remediation), F4 PASS
- No commits were made during the plan; the result was committed atomically
  afterwards (5 commits, HEAD `2cddd5b`).

## Retained live failures (accepted, NOT green)

### Task 12 (pinned E2E + hermetic CI)

- Pinned E2E: 21/24 passed, exit 1 — 0 bridge-product failures; ownership:
  upstream/model runtime stall, live-model argument/scheduling variance.
- Hermetic beta.9 CI: 446/456 trials, 90/104 gates, exit 1 — 0 bridge-product
  correctness failures; 8 failed latency gates; H2 reuse 99.1%.
- Override: `task-12-user-override-closure.json`.

### F3 (real OMO native-vs-yorha manual QA, R6 final)

| Surface                        | Result                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| text                           | PASS                                                                                                         |
| malformed forced tool boundary | PASS (400, 0 upstream runs)                                                                                  |
| parallel two tool (yorha)      | FAIL — 120s timeout, 1 upstream run (native: 6 runs, PASS)                                                   |
| sequential tool result (yorha) | FAIL — 120s timeout                                                                                          |
| incremental tool arguments     | FAIL — blocked by trial 5                                                                                    |
| cancellation and next capacity | FAIL — `live_completion_raced_abort` (terminal success raced abort; deterministic vitest companion 3/3 PASS) |

Same signature across R3–R6; forensics: no bridge-product defect, no
deterministic remediation available.
Override: `f3-user-override-closure.json` (SHA `1af195a4…`).

## Constraints honored

No relay/provider-alias product, no test weakening, OpenAI + CLI fallback
behavior preserved, protected PIDs 28107/66013 untouched, prior artifacts
preserved byte-for-byte.

## Known open gap (next work)

The bridge is **not yet live-parity green** on yorha multi-tool rounds and
active-abort cancellation. See `docs/NEXT-PARITY-PLAN.md` for the follow-up
planning seed, including the full native-parity goal and CLI reverse
engineering option.

## Wire-capture round (2026-08-20)

Diagnosis only — P1/P2 remain unsolved. The wire-capture method is executed;
the follow-up is a fix plan derived from the findings.

- Toolkit landed in `scripts/wire-capture/` (TLS capture proxy, cert
  generation, H2 lifecycle logging, NDJSON schema/normalizer, frame differ,
  native and yorha lane runners).
- Live captures: 6 lane-surface pairs (`tool_parallel_two`,
  `tool_sequential_two_round`, `cancel_after_first_event` × native/yorha)
  archived under `.omo/evidence/wire-capture/` with per-surface SHA-256
  manifests.
- Findings: `docs/WIRE-CAPTURE-FINDINGS.md` (commit `e6ffcf4`).
- Conformance test: `tests/wire-conformance-replay.test.ts` replays the
  captured native Run request fixture
  (`tests/fixtures/wire/native-tool-parallel-run-request.ndjson`) against
  the bridge. Documented bridge-superset extra field paths live as
  `BRIDGE_RUN_REQUEST_EXTRA_FIELD_PATHS` in that test (companion list in
  `.omo/evidence/wire-capture/task-9-happy.json`).
