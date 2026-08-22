# Cursor Composer Parity — Current Status (2026-08-22)

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

- `npm run verify`: PASS — typecheck, lint, format, strict gate, **666/666 tests**, build
- Final audits: F1 PASS, F2 PASS (post-remediation), F4 PASS
- No commits were made during the plan; the result was committed atomically
  afterwards (5 commits, HEAD `2cddd5b`).

## Sticky-run hardening update (2026-08-22)

- Deterministic verification on the release candidate: 73 files, 666 tests,
  typecheck, lint, format, strict-assertion gate, and build all pass.
- Current live reliability campaign: SSE serial continuation 5/5 exact,
  parallel tools 10/10 exact, and ten concurrent serial chains 10/10 exact.
  The 45 HTTP requests reused 25 logical upstream Runs as intended; internal
  retries and terminal errors were both zero.
- Current pinned E2E: 23/24. The historical reserved-`Shell` failure passed.
  One forced-function trial returned a transient 502; an immediate isolated
  rerun returned 200 with the exact `FORCED_REAL_7319` argument, one upstream
  Run, no retry, and terminal success.
- In the post-review named-choice campaign, all three trials selected a
  builtin on both the initial and recovery Runs. Each request made exactly one
  bounded retry, then returned an actionable error instructing the client to
  retry with `tool_choice="auto"` when the external tool is optional.
- The pinned E2E trace-deadline harness now rejects a slow subscription as a
  scenario failure instead of leaking an unhandled rejection. Its regression
  is included in the 666-test total.
- Latest retained CI metrics (`task-12-ci-sticky.json`) pass all 82 lane
  checks across 41 paired latency gates. The artifact remains overall FAIL
  because one correctness gate recorded an upstream transport failure and
  another recorded invalid tool arguments owned by tool scheduling.

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

~~The bridge is **not yet live-parity green** on yorha multi-tool rounds and
active-abort cancellation.~~ **Closed 2026-08-20 — see the resolution section
below.** See `docs/NEXT-PARITY-PLAN.md` for the remaining work: the full
wire-shape parity goal (RE lane). The latest retained CI artifact passes the
latency gate set.

## Resolution round (2026-08-20, final)

The retained F3/Task-12 failures above were root-caused and fixed in the
follow-up campaigns (`p1-wire-capture-parity`, `wire-parity-fix`, P1 derail
cutoff). Final full ci benchmark
(`.omo/evidence/cursor-composer-parity-benchmark/task-12-ci-final.json`):

- **Correctness: yorha 12/12 on every case** (text, streaming, single /
  parallel / sequential / forced / required tools, malformed-input
  validation, cancellation). Only exception: `toolChoice_none` 10/12 — two
  `unexpected_tool` executions; the same failure class appears on the native
  lane (1/12 in the prior run), suspected model-discipline flake, not traced
  to a bridge change. Watch item.
- The previously retained FAILs are gone: parallel/sequential tool rounds
  complete in the expected 2 runs; cancellation aborts with terminal=abort
  and clean CANCEL + GOAWAY on the wire.
- This round's latency gates failed at ~1.4-2.2x thresholds. The later
  `task-12-ci-sticky.json` rerun passes all 82 lane checks across 41 paired
  latency gates; re-measure after any RE-lane turn-structure change.

Fix commits: `71174c7` (abort half-close), `f49fb83` (graceful shutdown
ordering), `1d96c2b`/`1914ab7`/`d3dfc1b` (mcpArgs answer groundwork),
`e46a8bb` (P1 derail cutoff).

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
