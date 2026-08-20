# Next Parity Plan — Planning Seed (new session)

Goal for the follow-up session: make the yorha bridge **theoretically and
practically indistinguishable from native cursor-agent CLI** on the wire and in
behavior. The user's position: there is no reason full parity is impossible;
CLI reverse engineering is in scope if needed.

## Open problems to solve (from retained FAILs)

### P1 — yorha multi-tool round stalls (F3 parallel/sequential timeout)

- Symptom: yorha lane times out at 120s with `upstream_runs: 1` while the same
  surface on native completes with `upstream_runs: 6`.
- Hypotheses to test:
  1. Bridge does not drive subsequent tool-result turns as aggressively as the
     native CLI (waits for something the CLI does not wait for).
  2. Wire-shape divergence (tool_result encoding, turn structure, scheduling
     metadata) makes upstream stall rather than error.
  3. OMO yorha-lane client-side behavior differs from native lane (comparator
     issue, not bridge issue) — must be ruled out with wire capture.
- Method: differential wire capture — record native CLI ↔ Cursor Connect
  frames and bridge ↔ Cursor frames for the identical prompt/tool fixture,
  then diff frame-by-frame (headers, message ordering, tool result envelope,
  Run lifecycle).
  **EXECUTED (2026-08-20).** Results:
  [`docs/WIRE-CAPTURE-FINDINGS.md`](WIRE-CAPTURE-FINDINGS.md) (commit
  `e6ffcf4`). Diagnosis only — P1 is **not** solved; the follow-up is a
  fix plan derived from those findings.
  - H1 **CONFIRMED**: yorha lane never answers the server's `mcpArgs`
    exec request; heartbeats until RST — the known silent-stall mode.
  - H2 **CONFIRMED**: yorha `requestContextResult` carries
    `bridge_tool_*` fields native never sends.
  - H3 **REFUTED**: curl repro stalls without OMO.

### P2 — cancellation races completion (F3 `live_completion_raced_abort`)

- Symptom: abort issued after `run_stream_open`, but terminal `success`
  arrives before the abort lands; deterministic vitest abort path passes 3/3.
- Hypotheses:
  1. Abort signal reaches upstream later than the native CLI's abort path
     (extra hop, queue flush ordering, or H2 stream reset semantics).
  2. Trigger timing: current driver aborts on first content; native may abort
     earlier in the lifecycle.
- Method: capture native CLI abort wire behavior (RST_STREAM timing vs data
  frames) and align bridge abort dispatch to the same point in the frame
  stream; then re-run the live cancellation surface.
  **EXECUTED (2026-08-20).** Results:
  [`docs/WIRE-CAPTURE-FINDINGS.md`](WIRE-CAPTURE-FINDINGS.md) (commit
  `e6ffcf4`). Diagnosis only — P2 is **not** solved; the follow-up is a
  fix plan derived from those findings.
  - Native cancel closes `NO_ERROR` without RST.
  - Yorha RST `INTERNAL_ERROR` 721 ms in with 0 response DATA.

### P3 — CI latency gates (Task 12: 8 failed latency gates)

- Local overhead measured sub-millisecond, but paired median ratios/CI
  thresholds failed on some surfaces.
- Method: once P1/P2 wire parity is proven, re-measure; investigate whether
  residual is bridge scheduling overhead or account/upstream variance.

## Reverse-engineering lane (if wire capture shows unexplained divergence)

1. Extract the cursor-agent CLI's exact Connect protocol usage (frame
   ordering, headers, envelope fields, startup sequence) from local captures
   and/or binary inspection.
2. Produce a protocol-conformance test: replay the captured native byte
   stream against the bridge and require byte/frame-level equivalence.
3. Only then claim "indistinguishable from native".

## Acceptance bar (carried over from this plan)

- Headless wire signal indistinguishable from real CLI, proven by
  differential evidence.
- Tool planning/execution behavior and practical performance match native.
- Full F3 live manual QA PASS (all 6 surfaces) with no timeout/race — no
  override this time unless explicitly authorized again.
- `npm run verify` green; no test weakening; no relay/provider-alias product.

## Reference evidence

- Status doc: `docs/PARITY-STATUS.md`
- Plan (local): `.omo/plans/cursor-composer-parity-benchmark.md`
- Evidence (local): `.omo/evidence/cursor-composer-parity-benchmark/`
  - F3 R6 report SHA `68b243d1…`, forensics `f3-r6-forensics.json`
  - Task 12 override `task-12-user-override-closure.json`
  - F2 R2 integrated verifier `verify-f2-r2-integrated.json`
