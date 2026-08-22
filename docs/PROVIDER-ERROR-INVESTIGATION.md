# Cursor `ERROR_PROVIDER_ERROR` retry and diagnostics investigation

Date: 2026-08-23
Baseline: `33bbaa8`
Status: implemented and verified

## Executive verdict

The feedback correctly identified an observability gap, but its proposed
default retry policy is too broad.

`ERROR_PROVIDER_ERROR` with explicit `isRetryable:false` and nested provider
status `400` should remain terminal by default:

- the normally-run installed Cursor CLI throws explicit non-retryable errors;
- its retry-all inference branch is a hidden, default-off,
  internal-training option with an additional identity allowlist;
- Cursor's public SDK guide treats `isRetryable` as authoritative and says not
  to retry when it is false;
- public Cursor reports show provider 400 errors caused by deterministic custom
  endpoint routing or key configuration, while Cursor's status history confirms
  that real model-provider outages also occur.

The investigation did find a more serious bridge bug. Connect's canonical
`ErrorDetails.value` is base64 protobuf. The bridge previously inspected only
optional JSON `debug` data, so a spec-compliant value-only provider 400 or
account-limit error hid `isRetryable:false` and was retried three times through
the outer `resource_exhausted` code. Each retry could also move to another
weighted credential.

That canonical-path bug, the credential movement, diagnostics gap, and raw-log
leak are now fixed.

## What the upstream fields mean

The observed envelope has three separate layers:

```json
{
  "code": "resource_exhausted",
  "details": [
    {
      "type": "aiserver.v1.ErrorDetails",
      "debug": {
        "error": "ERROR_PROVIDER_ERROR",
        "details": {
          "isRetryable": false,
          "additionalInfo": {
            "providerStatusCode": "400"
          }
        }
      }
    }
  ]
}
```

- `resource_exhausted` is the outer Connect code.
- `ERROR_PROVIDER_ERROR` is Cursor's private fine-grained enum; installed
  bundles consistently map it to enum number 57.
- `isRetryable` is an explicit optional protobuf field. `false` is encoded on
  the wire; it is not a missing-field default.
- `providerStatusCode` is an arbitrary string map value from Cursor's custom
  details. It is not the outer HTTP status or Connect code.
- `terminal=true` is bridge state for the final Connect EndStream error. It
  means that Run is over, not that opening a new Run is forbidden.

The official Connect protocol requires each detail to carry `type` and base64
protobuf `value`; `debug` is optional and clients must not depend on it.

## Root cause before this change

`src/backend/cursor-api/retry.ts` recursively inspected unknown JSON details:

1. any visible `isRetryable:false` vetoed retry;
2. known readable rate/usage strings vetoed retry;
3. otherwise `resource_exhausted` became a server error with three retries.

This worked for debug-expanded details but failed for canonical protobuf bytes.
The base64 string contained no readable boolean or enum name, so permanent
errors fell through to step 3.

The same retry loop re-entered weighted credential routing on every attempt.
With two equal keys, one OpenAI request could alternate `A -> B -> A -> B`.

## Implemented policy

| Error shape                                                                            | Default                | Experimental flag    | Credential/backend/model                |
| -------------------------------------------------------------------------------------- | ---------------------- | -------------------- | --------------------------------------- |
| Provider error, `isRetryable:false`, nested provider status 400                        | terminal 502           | still terminal       | no rotate, no CLI flip, no model change |
| Provider error, `isRetryable:false`, valid nested provider status 500-599              | terminal 502           | bounded server retry | same credential and requested model     |
| Provider error, retry marker true or absent, outer retryable Connect code              | existing bounded retry | unchanged            | same credential and requested model     |
| Permanent rate/usage enum or conflicting/malformed detail                              | terminal               | terminal             | no rotate or flip                       |
| True auth HTTP 401/403 or Connect `unauthenticated` without provider/permanent overlay | existing auth failover | unchanged            | one credential failover                 |
| Transport failure                                                                      | existing one retry     | unchanged            | same credential                         |

The experimental option is:

```bash
CURSOR_BRIDGE_RETRY_PROVIDER_5XX=1
```

It is off by default and deliberately narrower than Cursor's hidden
retry-all-inference mode. Provider identity must come from the authoritative
detail or the validated response header. One parsed provider detail must
independently prove both of:

- explicit boolean `false`;
- valid three-digit nested provider status 500-599.

The outer Connect code must be `resource_exhausted`. Permanent details,
cross-detail proof splicing, status or retry-marker conflicts, malformed
protobuf, and post-visible-output failures all remain terminal. For explicit
`isRetryable:false` provider details, missing status and provider 400/429 also
remain terminal. The existing maximum of three server retries and exponential
backoff applies. This flag does not control direct HTTP 5xx failures or provider
errors whose retry marker is true/absent; those continue through the existing
classifier.

## Implementation details

### Canonical details decoding

`src/backend/cursor-api/provider-error-protobuf.ts` contains a bounded decoder
for the fields needed from `aiserver.v1.ErrorDetails` and
`CustomErrorDetails`:

- enum number;
- optional retry marker;
- allowlisted `providerStatusCode`.

It rejects oversized, noncanonical base64, malformed lengths, field zero,
nonminimal varints, tag overflow, unsupported wire encodings, malformed nested
map entries, and repeated `CustomErrorDetails` messages whose merge could erase
retry evidence. Canonical binary wins over debug fallback.

Known permanent enum numbers corresponding to the existing bridge denylist are
recognized even when the optional retry marker is absent.

### Retry and routing safety

- Every server or transport retry within one Cursor Run pins the originating
  credential.
- Authoritative nested Connect and HTTP denials are inspected before accepting
  an outer transport-looking wrapper as retryable.
- Sticky continuation still uses its original credential.
- Provider-shaped Connect and HTTP permission failures cannot disable or rotate
  credentials.
- Provider errors do not count as fatal Auto transport/auth failures and cannot
  flip subsequent requests to `cursor-cli`.
- Plain Connect `unauthenticated` errors still trigger Auto's existing auth
  fallback after credential handling, without exposing their raw message.
- Retries preserve the requested model and never silently fail over to another
  model.

### Diagnostics and redaction

JSON errors and SSE error frames expose these bounded snake-case fields:

```json
{
  "connect_code": "resource_exhausted",
  "upstream_error_type": "ERROR_PROVIDER_ERROR",
  "upstream_retryable": false,
  "provider_status_code": "400"
}
```

Trace records use `upstream_error_code`, `upstream_error_type`,
`upstream_retryable`, `provider_status_code`, and `run_request_id`. Safe warning
logs use `connectCode`, `upstreamErrorType`, `upstreamRetryable`,
`providerStatusCode`, and `runRequestId`. The upstream Run UUID remains in the
client-facing `error.request_id`.

Raw provider title/detail text, the full `additionalInfo` map, base64 values,
buttons, URLs, metadata, messages, and stacks are not serialized. Redaction
also applies when a `ConnectRpcError` is wrapped in another error or permanent
precedence suppresses the provider type.

## Stall correlation verdict

The previous 240/300-second no-terminal stalls are not proven to be this
provider error.

A single attempt cannot both:

- receive a terminal provider error; and
- remain open without `turnEnded` or an EndStream envelope.

They can share an upstream incident, route, load condition, or malformed state,
but that requires correlation by downstream request ID, upstream Run UUID,
attempt index, model, credential slot, and frame sequence. Timing overlap in an
aggregate session log is insufficient.

Independent public reports show no-`turnEnded` and event-delivery stalls without
an `ERROR_PROVIDER_ERROR` envelope:

- <https://github.com/can1357/oh-my-pi/issues/6772>
- <https://github.com/can1357/oh-my-pi/issues/7719>

Keep timeout/stall diagnostics and provider-error diagnostics as separate
classes until a shared request/attempt trace proves linkage.

## Verification

- Focused adversarial package: 66/66 passed.
- Full `npm run verify`: passed.
- Final full test run: 75 files / 712 tests passed.
- Typecheck, ESLint, Prettier, strict-assertion gate, and build: passed.
- Manual live HTTP driver:
  - JSON provider failure: HTTP 502 with allowlisted fields and Run UUID;
  - midstream SSE failure: HTTP 200 stream with structured error event;
  - no secret sentinel in response or logs;
  - default and opt-in explicit-false provider 400 remained terminal;
  - opt-in provider 503 classified as server-retryable.
- Multiple hostile review rounds exercised canonical/debug forms, permanent enums,
  conflicting and split details, malformed protobuf tags, header masking,
  credential rotation, Auto fallback, and direct/wrapped log leakage.

## Residual limits

1. No public or local captured example proves that
   `providerStatusCode` carries 5xx in production. The experimental flag is
   insurance and should remain off until measured.
2. Connect `debug` is noncontractual. Capture and hash a real canonical
   `value` plus leading metadata before expanding policy.
3. Cursor's hidden retry mode may resume from a conversation checkpoint. The
   bridge currently opens a fresh root Run, so the experimental path is not
   full wire-level parity for checkpoint-bearing failures.
4. Historical stalls require frame-level evidence. Do not infer provider
   failure from elapsed time alone.
5. The private enum inventory can evolve. Unknown canonical enum values without
   an explicit retry marker remain subject to the existing outer Connect-code
   policy until their semantics are added.

## Primary sources

- Connect protocol and EndStream error details:
  <https://connectrpc.com/docs/protocol/>
- Cursor SDK error handling:
  <https://raw.githubusercontent.com/cursor/plugins/main/cursor-sdk/skills/cursor-sdk/references/error-handling.md>
- Cursor-hosted deterministic provider-400/custom endpoint report:
  <https://forum.cursor.com/t/147219.json>
- Cursor-hosted provider error with explicit false:
  <https://forum.cursor.com/t/cursor-provider-error/159023/1.json>
- Cursor-hosted error 57 with retryable true:
  <https://forum.cursor.com/t/persistent-connection-error/149848/1.json>
- Cursor model-provider outage example:
  <https://status.cursor.com/incidents/8gbqbmsmq7cy>
- Reverse-engineered enum snapshot, supporting evidence only:
  <https://github.com/funny-vibes/agent-vibes/blob/5c6c621b785ba6c2dfbaa3db1d175b6d8b4e08bf/apps/protocol-bridge/proto/aiserver/v1.proto#L9295>
