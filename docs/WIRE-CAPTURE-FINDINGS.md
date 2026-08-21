# Wire-capture findings (P1 / P2)

Diagnosis only. Captures from 2026-08-20 todo-7; compared with
`scripts/wire-capture/diff.mjs` on `normalized.ndjson`. No product fix in this
round.

**How to read a citation:** `tool_parallel_two/yorha H2 req frame 07` is
`agentn/H2-1-req-07.bin` (Connect frame index 7 on stream 1). Lifecycle lines
are `lifecycle.ndjson` event indexes on the same stream.

**Instrument limit:** the capture proxy persists only the first 12 client and
first 40 server Connect frames (`idx < 12` / `idx < 40` in
`scripts/wire-capture/proxy.mjs`). Later frames exist as H2 DATA sizes +
timestamps in `lifecycle.ndjson` but were not written as `.bin` / normalized
records. Native success runs are therefore **truncated in the normalized
diff**, not short on the wire.

| Surface                     | native terminal | yorha terminal | agentn H2 DATA (req/res) native | yorha   |
| --------------------------- | --------------- | -------------- | ------------------------------- | ------- |
| `tool_parallel_two`         | success         | STALL          | 85 / 138                        | 35 / 26 |
| `tool_sequential_two_round` | success         | STALL          | 177 / 445                       | 35 / 25 |
| native-trial-1-stall        | STALL (SIGKILL) | —              | 223 / 480                       | —       |
| `cancel_after_first_event`  | success         | success        | 12 / 16                         | 1 / 0   |

---

## Verdicts

### P1-1 — Bridge drives subsequent tool-result turns less aggressively than the CLI

**CONFIRMED.**

After upstream asks the client to execute MCP tools, the CLI keeps sending
substantive client DATA on the same Run. The bridge does not. It answers KV
and `requestContextArgs`, then emits 5 s heartbeats until the 120 s timeout
destroys the stream.

- `tool_parallel_two/yorha H2 res frame 33` and `H2 res frame 37`:
  `execServerMessage.mcpArgs` for `bridge_tool_0_echo_value` (sentinel value in
  args). No later saved client frame is `execClientMessage` (last saved client
  is `H2 req frame 11` `kvClientMessage.setBlobResult`).
- `tool_sequential_two_round/yorha H2 res frame 26`: `mcpArgs` for
  `bridge_tool_1_lookup_code` key `ALPHA`. Same gap: no client MCP result in
  `H2 req frame 00`–`11`.
- Lifecycle, not bins: `tool_parallel_two/yorha` last non-heartbeat DATA is
  res 1352 B at `2026-08-20T10:42:58.419Z` (`+3723 ms` after
  `H2 req frame 00`). After that, 23× 7-byte req DATA every 5 s (bridge
  `clientHeartbeat` interval) until RST. Native at the matching phase already
  sends 149 B + 251 B client DATA at `2026-08-20T10:41:24.226Z` (`+5112 ms`
  after `tool_parallel_two/native H2 req frame 00`) and later 3318 B, 815 B,
  1754 B, 543 B client frames — those indexes are **past the req-12 cap**, so
  they are not in `normalized.ndjson`.
- `tool_parallel_two/native H2 req frame 07`: CLI sends
  `execClientMessage.mcpStateExecResult` in the opening burst. Yorha never
  does in `H2 req frame 00`–`11`.
- Bridge code matches the capture: `handleExecResponse` on `mcpArgs` calls
  `completeTool` and does **not** `sendExec` (`src/backend/cursor-api/exec-responses.ts`).
  `run-execution.ts` keeps the Run open (5 s heartbeats) until `turnEnded` /
  timeout. Upstream will not `turnEnded` without the MCP result. Deadlock.

Native-trial-1-stall does **not** look like this deadlock: it was still
exchanging large req/res DATA at `+116554 ms`, then
`RST_STREAM CANCEL` from SIGKILL. Yorha stops making progress at ~3.7 s.

### P1-2 — Wire-shape divergence stalls upstream (incl. unanswered exec / silent heartbeat)

**CONFIRMED.**

Two independent shape bugs sit under this heading. Either would be enough;
the capture shows both.

**A. `requestContextResult` / `runRequest` envelope (tools + turn structure).**

- `tool_parallel_two/native H2 req frame 01` `requestContextResult`:
  `requestContext` has `env`, `supportsMcpAuth`, `gitRepoInfoComplete` — **no
  `tools` array**.
- `tool_parallel_two/yorha H2 req frame 07` `requestContextResult`: same
  object **plus** `tools[0]=bridge_tool_0_echo_value` and
  `tools[1]=bridge_tool_1_lookup_code` (mapper
  `requestContextResult` always attaches `request.tools`). Differ
  `field_presence` on this pair: tens of
  `message.value.message.value.result.value.requestContext.tools[*]` paths
  only-in-yorha.
- `tool_parallel_two/native H2 req frame 00` vs `yorha H2 req frame 00`
  `runRequest`: yorha-only
  `conversationState.rootPromptMessagesJson[0..4]`,
  `conversationState.turns[0..1]`,
  `action.userMessage.conversationStateBlobId`,
  `requestedModel.maxMode` / `builtInModel` /
  `isVariantStringRepresentation`. Native `conversationState` is empty.
  Yorha `userMessage.text` is wrapped in a `<memory_notice>` prefix; native
  is the raw sentinel prompt. Same pattern on
  `tool_sequential_two_round` and `cancel_after_first_event` `H2 req frame 00`.
- Opening KV is inverted: native `H2 req frame 03`–`06` are
  `setBlobResult`; yorha `H2 req frame 01`–`06` are `getBlobResult`
  answering `H2 res frame 01`–`06` `getBlobArgs`. Native first server KV
  (`H2 res frame 02`–`05`) is `setBlobArgs`.

**B. Silent stall after unanswered `mcpArgs` (known mode).**

- Last upstream exec on the stalled yorha Run:
  `tool_parallel_two/yorha H2 res frame 37` `mcpArgs` (second parallel
  echo). First missing expected client frame vs native success: an
  `execClientMessage` MCP result on the same stream (native’s analogous
  bytes appear as 149 B / 251 B req DATA at `+5112 ms`, not in the req-12
  window).
- Heartbeats with zero progress: `tool_parallel_two/yorha` lifecycle last
  res DATA is 9 B at `2026-08-20T10:44:45.491Z` (`mono_ms=117028.6`); last
  req DATA is 7 B at `2026-08-20T10:44:49.706Z`; RST 3.3 s later. Matches
  “unanswered exec subchannel keeps heartbeats but zero progress.”
- `tool_sequential_two_round/yorha H2 res frame 26` is the sequential
  equivalent; last interesting DATA `+4177 ms`, then the same 7 B / 9 B
  heartbeat pair until RST.

Live repro (no OMO): plain chat 3.6 s OK; tool-bearing Run 90 s+ / 0 bytes
(`.omo/evidence/wire-capture/live-repro-tool-call-stall.md`) — same stall
class as B.

### P1-3 — OMO client-side difference (comparator artifact, not bridge)

**REFUTED.**

The stall is on the Cursor `AgentService/Run` stream the bridge itself
opens, not on OMO failing to start a trial.

- Todo-5: OMO’s in-process cursor client **ignores** `CURSOR_API_ENDPOINT`.
  The native lane was therefore driven with **cursor-agent CLI**
  (`--endpoint` / `--agent-endpoint` / `NODE_EXTRA_CA_CERTS`). Native
  captures are CLI wire, not an OMO-provider artifact.
- `tool_parallel_two/yorha H2 req frame 00` is a full `runRequest`;
  `H2 res frame 33` is upstream `mcpArgs`. OMO did reach the bridge; the
  bridge did reach Cursor; Cursor did schedule tools. The hang is after
  that (P1-1 / P1-2).
- Curl live-repro of a tool-bearing OpenAI request against the bridge
  stalls with **no OMO in the path**.
- Native-trial-1-stall (`tool_sequential_two_round/native-trial-1-stall`)
  is a CLI timeout under load (progress until SIGKILL), not the yorha
  heartbeat deadlock. It does not rehabilitate H3.

What H3 would have required and is absent: a yorha capture where agentn
never opens Run, or a curl-to-bridge tool run that completes while OMO
stalls. Neither exists.

---

## Per-surface frame diff (normalized, first 12/40 only)

Differ: native = capture A, yorha = capture B. Lifecycle deltas omitted
here (DATA-count mismatch is the stall, not a sequencing bug).

### `tool_parallel_two`

`frames 52/52`, matched 40, missing 12, extra 12.

Missing from yorha vs native: `client:unknown` at native `H2 req frame 02`
and `08` (raw protobuf field 5, codec-empty); native
`H2 req frame 07` `mcpStateExecResult`; native `H2 res frame 31`–`39`
still `interactionUpdate` text/token (CLI still composing “calling it
twice”). Extra on yorha: three more `kvClientMessage`; `H2 res frame 33`
and `37` `execServerMessage.mcpArgs`; trailing `setBlobArgs`.

Native server text at `H2 res frame 06` is thinking “I will call the
echo_value tool twice…”. Yorha thinking at `H2 res frame 11` is the same
intent, then `H2 res frame 28` `partialToolCall`, `31` `toolCallStarted`,
`33` `mcpArgs`.

**Last upstream frame (yorha stall):** saved `H2 res frame 39`
`kvServerMessage.setBlobArgs` after the second `mcpArgs`. **First missing
expected frame:** client MCP result for `H2 res frame 33` (native’s next
substantive client DATA is the 149 B req at `+5112 ms`).

### `tool_sequential_two_round`

Same opening divergence as parallel (`H2 req frame 00` / `01` vs yorha
`07`, KV get vs set). Yorha `H2 res frame 26` `mcpArgs` lookup_code.
Yorha `H2 res frame 30` is codec-unknown (raw field 3, a blob-sized
payload); `H2 res frame 31`–`39` are empty `interactionUpdate`. Native
`H2 res frame 06`–`39` stay in thinking/text “Searching for the
lookup_code tool…”.

**Last upstream frame (yorha stall):** `H2 res frame 39` empty
`interactionUpdate` (after `mcpArgs` + KV). **First missing expected
frame:** client MCP result for `H2 res frame 26`.

### `tool_sequential_two_round/native-trial-1-stall`

Complete capture, SIGKILL at ~120 s. Opening bins match native success:
`H2 req frame 00` runRequest (lookup_code / ALPHA), `H2 req frame 01`
`requestContextResult`, `H2 req frame 07` field-7 empty (heartbeat-class),
`H2 res frame 39` still textDelta `" then"`. Lifecycle: 223 req / 480 res
DATA, last res 101 B at `2026-08-20T10:47:16.065Z`, then
`RST_STREAM CANCEL` origin=downstream at `2026-08-20T10:47:16.340Z`. This
is a wall-clock kill of a **still-progressing** CLI Run, not the yorha
heartbeat deadlock. Informative as a negative control for P1-1.

### `cancel_after_first_event`

Native: 52 normalized frames, full sentinel streamed as `textDelta`
(`H2 res frame 13` `"B"` … `H2 res frame 37` `"9"`). Close `NO_ERROR`,
**no RST**.

Yorha: only `H2 req frame 00` `runRequest`. Zero res frames. RST
`INTERNAL_ERROR` 721 ms later.

---

## P2 — RST_STREAM vs terminal DATA

Bridge abort dispatch (`src/backend/cursor-api/run-execution.ts`
`onAbort` → `stream.destroy(error)`). Observed H2 mapping:
`destroy()` → RST error_code **2 INTERNAL_ERROR**, not CANCEL (8).

### Native `cancel_after_first_event`

| Event                          | ts (UTC)                 | mono_ms  | note                                                              |
| ------------------------------ | ------------------------ | -------- | ----------------------------------------------------------------- |
| stream open                    | 2026-08-20T10:51:25.234Z | 2771.345 | POST `/agent.v1.AgentService/Run`                                 |
| first DATA (`H2 req frame 00`) | 2026-08-20T10:51:25.238Z | 2775.403 | 835 B req                                                         |
| last DATA                      | 2026-08-20T10:51:28.551Z | 6087.725 | 28 B **res**                                                      |
| close                          | 2026-08-20T10:51:28.559Z | 6096.536 | `rst_code=0 NO_ERROR`; `req_data_frames=12`, `res_data_frames=16` |
| RST_STREAM                     | —                        | —        | **none**                                                          |

Ordering: **terminal DATA, then graceful close. RST never sent.** Last
res DATA is 8.8 ms before close. Native streamed the full cancel sentinel
(`H2 res frame 13`–`37`) — completion won; the driver abort did not reset
the CLI stream.

### Yorha `cancel_after_first_event`

| Event                               | ts (UTC)                 | mono_ms  | note                                                            |
| ----------------------------------- | ------------------------ | -------- | --------------------------------------------------------------- |
| stream open                         | 2026-08-20T10:51:40.335Z | 6906.712 | same path                                                       |
| first/only DATA (`H2 req frame 00`) | 2026-08-20T10:51:40.339Z | 6910.738 | 1096 B req                                                      |
| RST (downstream)                    | 2026-08-20T10:51:41.060Z | 7631.480 | error_code **2 INTERNAL_ERROR**                                 |
| close                               | 2026-08-20T10:51:41.060Z | 7631.815 | `rst_code=2`; `res_data_frames=0`; `last_res_data_mono_ms=null` |
| RST (upstream echo)                 | 2026-08-20T10:51:41.061Z | 7632.535 | error_code 2                                                    |

Ordering: **RST with no server DATA at all.** Abort landed 720.7 ms after
`runRequest`, before the first upstream frame. This is `stream.destroy()`
from `onAbort`, not a completion race on this trial.

### Stalled tool surfaces (timeout, not user abort)

`tool_parallel_two/yorha`: last res DATA `2026-08-20T10:44:45.491Z`
(`mono_ms=117028.608`), last req DATA `2026-08-20T10:44:49.706Z`
(7 B heartbeat), RST downstream INTERNAL_ERROR
`2026-08-20T10:44:53.016Z` (`mono_ms=124553.622`). **RST after idle
heartbeats; no terminal success frame.** Sequential yorha is the same
shape (`last_res_data_mono_ms=117428.712`, RST at `124481.397`).

`tool_parallel_two/native` success: last res DATA then close NO_ERROR
(`2026-08-20T10:41:50.610Z` DATA, `10:41:50.619Z` close). No RST.

`native-trial-1-stall`: last res DATA `2026-08-20T10:47:16.065Z`, RST
**CANCEL (8)** origin=downstream `2026-08-20T10:47:16.340Z` (275 ms later).
CLI/OS kill uses CANCEL; bridge timeout/abort uses INTERNAL_ERROR.

---

## What a fix must change (evidence, not a patch)

1. Answer `mcpArgs` on the **same Run** with an `execClientMessage` MCP
   result (or finish the Run and start a new one with tool results — the
   CLI does the former). Today `completeTool` + wait-for-`turnEnded`
   deadlocks (`H2 res frame 33`/`37` unanswered).
2. Stop advertising OpenAI tools inside `requestContextResult` if the CLI
   does not (`H2 req frame 01` native vs `07` yorha). That is what makes
   Cursor emit `mcpArgs` for `bridge_tool_*`.
3. Align `runRequest.conversationState` / `requestedModel` extra fields
   and the `<memory_notice>` prefix with the CLI (`H2 req frame 00`).
4. Abort: `stream.destroy()` → RST INTERNAL_ERROR, often **before** any
   res DATA. Native cancel did not RST and let terminal DATA through.
   Matching native means RST CANCEL (8) at a comparable point in the
   DATA stream, or not RST after a terminal frame.

---

## Differ / capture QA

- `node scripts/wire-capture/diff.mjs` exit 1 on all three native-vs-yorha
  pairs (expected divergence).
- Frame-only reports:
  `.omo/evidence/wire-capture/task-8-diffs/*-frames-only.json`.
- Self-check: `.omo/evidence/wire-capture/task-8-happy.json`.

---

## Fix round (plan `wire-parity-fix`, 2026-08-20)

Committed fixes (see `.omo/plans/wire-parity-fix.md` todos 1-8):

- `71174c7` abort: `stream.destroy(error)` -> graceful `end()` half-close on
  the signal path (upstream RST INTERNAL_ERROR eliminated).
- `1d96c2b` run-messages: answer `mcpArgs` with `mcpResult` on the same Run's
  exec channel (descriptor groundwork in `1914ab7` / `d3dfc1b`); `9d99e84`
  prunes the wire-conformance test companion list accordingly (post-fix
  capture: mcpResult 3/3 tool cases).
- `f49fb83` client disconnect / process shutdown: SIGTERM previously left
  the h2 session and its half-closed Run stream dangling (`index.ts` never
  called `backend.shutdown()`), so the peer observed RST INTERNAL_ERROR (2)
  and no GOAWAY. Now `close()` awaits `backend.shutdown()`;
  `H2SessionPool.shutdown()` destroys lingering settled streams (RST CANCEL,
  the allowed worst case) and waits for the session `close` event (bounded
  1 s) instead of the `closed` flag, which flips the moment `close()` is
  called and let `process.exit(0)` race the RST/GOAWAY flush. Post-fix
  cancel capture (`task-8-happy.json`): downstream rst CANCEL + GOAWAY
  NO_ERROR; regression tests `tests/cursor-api-shutdown-graceful.test.ts`
  (RED before, GREEN after) and `tests/cursor-api-client-disconnect.test.ts`.

Todo 9 (streaming+tools stall: stream+required 0 bytes / stream+auto no
DONE, socket FIN ~38.6 s) **no longer reproduces** on the current tree:
curl stream+required x3, stream+auto, and tool round-trip all emit full
`tool_calls` + `[DONE]`; the e2e suite passes (`streaming indexed tool
calls`, `tool-declared text streams`, TTFB/usage, abort reap); the OMO
harness cases `tool_parallel_two` and `tool_sequential_two_round` complete
with exit 0 and no stall. No code change was made for todo 9; evidence in
`.omo/evidence/wire-parity-fix/task-9-happy.json`. If the stall resurfaces,
capture debug-level bridge logs plus the agentn lifecycle for the stalled
stream id before changing code.

## P1 resolution (2026-08-20, commit e46a8bb)

The remaining stall mode after the fix round: on tool-continuation runs the
model's calls are typed `mcpToolCall` (the bridge advertises OpenAI tools via
`requestContextResult.tools`, providerIdentifier `bridge`), so upstream asks
the bridge to execute them in-turn via `execServerMessage mcpArgs`. The
empty-success `mcpResult` left the server-side turn without tool output; the
model kept generating on the phantom result and never yielded, the client saw
silence, OMO aborted (~4-9 s) and retried, and retries produced duplicate
tool calls (Task-12 ci: sequential 1/12, history-replay 8/12).

Fix: keep the empty answer (required for parallel batches, which the server
serializes through per-call mcpArgs), but finish the turn the moment the
model emits text/thinking after a `toolCallCompleted` that followed an empty
exec answer — the derail signature. New sibling tool announcements reset the
flag, so late-announced parallel calls still flow. Post-fix ci run: yorha
12/12 on every tool case except parallel 10/12, both failures being upstream
5xx retry storms with both calls correctly executed (evidence
`.omo/evidence/wire-parity-fix/p1-derail-cutoff.json`).

## Post-sticky re-measure (2026-08-21, B lane)

Same toolkit, `tool_sequential_two_round`, current main (sticky Run):

| metric | pre-sticky yorha | post-sticky yorha |
| --- | --- | --- |
| runRequest frames | 5 (retry storm) | **1** |
| requestContextResult | 5 | **1** |
| textDelta frames | 102 (derail garbage) | 25 (the real answer) |
| KV blob churn | ~55 get/set pairs | 14/6 |
| mcpResult | none (stall) or empty | **populated** `content[0].text="A-17"` |
| terminal | RST after 120s heartbeat storm | clean trailer |

The populated `mcpResult` client frame decodes as
`f2{1:id, 11:mcpResult{1:success{1:content[{1:text{1:"A-17"}}]}}}` — the
same envelope grammar as native `grepResult` (echo id, result oneof, no
execId echo). Native CLI still never exercises MCP on this surface, so a
frame-for-frame CLI diff is not meaningful; the parity claim is against the
pi-ai/native-client exec grammar, which now matches.

Captures: `/tmp/wc-post-sticky/surface-*` (not committed; regenerate with
`run-yorha.mjs`/`run-native.mjs` + `_archive-lane.mjs`).
