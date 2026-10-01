# Completion metrics

`GET /admin/metrics` returns read-only, in-memory counters for admitted
`POST /v1/chat/completions` requests. It uses the same client authentication
policy as `/admin/config`; it does not introduce another key or change routing.

Requests that fail authentication, request validation, or model admission are
not counted. Requests rejected by the completion concurrency limiter are counted
as `rate_limited`.

## Labels

Each series has a canonical public model ID, a `stream` boolean, and a route:

- `direct`: the caller explicitly sent `x-cursor-bridge-route: direct`.
- `litellm`: the forwarding client explicitly sent `x-cursor-bridge-route: litellm`.
- `unknown`: the header was absent or did not contain either accepted value.

The route is a caller-supplied observability tag, not an authenticated identity.
The bridge does not infer it from loopback addresses, authorization keys, or
user-agent strings. Configure a forwarding client to carry the tag when that
distinction is needed; existing untagged clients continue unchanged.

Model labels are bounded to 128 distinct models per process. Additional model
names are aggregated into `__other__`, preserving route and streaming labels.
Neither prompts, tool arguments, credentials, arbitrary header values, nor
individual request histories are retained.

## Counters and lifetime

- `requests`: admitted attempts, including concurrency-limited attempts.
- `in_flight`: attempts without a terminal outcome.
- `success`, `backend_error`, `aborted`, `rate_limited`: terminal outcome counts.
- `latency_ms`: completed count, total, maximum, and average elapsed time.

Success is determined by the completion lifecycle, not merely HTTP status.
An SSE response that starts with HTTP 200 but later errors increments
`backend_error`. A disconnected client increments `aborted` after cleanup.
Latency uses a monotonic clock and includes all terminal outcomes.

Counters reset on service restart. `since` identifies the current process's
observation window. There is no persistence, background sampler, or scheduled
warmup associated with this endpoint.
