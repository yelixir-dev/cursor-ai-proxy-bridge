# Wire-capture NDJSON schema (schema_version 1)

One JSON object per line (NDJSON, UTF-8, `\n`-terminated). The on-disk pipeline
is **proxy bins → glue NDJSON → normalize**, not proxy-written NDJSON.

1. **Proxy capture** (`proxy.mjs`) writes:
   - raw Connect-frame payloads as `.bin` files
     (`H2-{id}-{req|res}-{idx}.bin` for streaming Run frames;
     `unary-{host}-{path}-{id}.bin` for HTTP/1.1 unary bodies)
   - H2 stream-lifecycle events as `lifecycle.ndjson`
     (`{ts, mono_ms, conn, stream, event, detail}`)
     The proxy does **not** write per-frame NDJSON (`payload_b64`, `lane`, `dir`,
     …). Frame-bin retention is capped (`MAX_REQ_FRAME_BINS` / `MAX_RES_FRAME_BINS`,
     overridable with `--max-req-bins` / `--max-res-bins`); later frames are still
     parsed and lifecycle-logged.
2. **Lane runners** (`run-native.mjs`, `run-yorha.mjs`) start the proxy pair,
   drive one F3 case, then write `receipt.json` next to the proxy dirs. They do
   **not** convert `.bin` files into NDJSON.
3. **Bin→NDJSON glue** (the live-capture archive step, currently
   `.omo/evidence/wire-capture/_archive-lane.mjs` rather than a committed runner
   step) walks each lane's `agentn/` `H2-*-{req|res}-*.bin` files and emits
   `raw-frames.ndjson` records in the shape below (`payload_b64`, `lane`, `dir`,
   `frame_index`, `flags`, `source_bin`). That file is the input to the
   normalizer.
4. **Normalized records** — produced by `normalize.mjs` from the glued raw
   NDJSON; the only form compared across lanes (native vs yorha).

## Raw capture record (input to the normalizer, output of the bin→NDJSON glue)

| Field          | Type    | Meaning                                                                                                                   |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `lane`         | string  | `native` or `yorha`                                                                                                       |
| `conn`         | number  | proxy connection ordinal                                                                                                  |
| `stream`       | number  | H2 stream id                                                                                                              |
| `dir`          | string  | `client` (to Cursor) or `server` (from Cursor)                                                                            |
| `frame_index`  | number  | 0-based frame ordinal on the stream                                                                                       |
| `flags`        | number  | Connect envelope flags (`0x01` gzip, `0x02` end-stream trailer)                                                           |
| `payload_b64`  | string  | base64 of the Connect frame payload (still gzipped if flagged)                                                            |
| `message_type` | string? | protobuf type; defaults to `agent.v1.AgentClientMessage` for `dir=client`, `agent.v1.AgentServerMessage` for `dir=server` |
| `headers`      | object? | captured request headers                                                                                                  |

## Normalized record (schema_version 1, comparison surface)

| Field            | Type           | Meaning                                                                                                                                                         |
| ---------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version` | number         | always `1`                                                                                                                                                      |
| `lane`           | string \| null | copied from raw record                                                                                                                                          |
| `conn`           | number \| null | copied                                                                                                                                                          |
| `stream`         | number \| null | copied                                                                                                                                                          |
| `dir`            | string \| null | copied                                                                                                                                                          |
| `frame_index`    | number \| null | copied                                                                                                                                                          |
| `flags`          | number \| null | copied                                                                                                                                                          |
| `message_type`   | string         | protobuf type used for decoding                                                                                                                                 |
| `headers`        | object \| null | headers with sensitive values redacted (below)                                                                                                                  |
| `payload_sha256` | string \| null | sha256 of the canonical (key-sorted) JSON of `decoded_fields`; identical logical frames share the digest even when raw bytes differ. `null` on error records    |
| `decoded_fields` | object \| null | normalized protobuf field tree (`{message: {case, value}}` oneof shape from the repo codec), or `{trailer: ...}` for end-stream frames. `null` on error records |
| `error`          | object?        | present only on error records: `{kind, message}` with kind one of `malformed_record`, `gzip_decode`, `truncated_payload`, `decode_error`                        |

### Normalization rules

Applied recursively to `decoded_fields` and non-redacted header values.
Placeholders are keyed by **first occurrence within one capture file**, so the
same logical value keeps one placeholder across all frames of that capture:

- UUIDs (`8-4-4-4-12` hex) -> `<uuid:N>`
- W3C `traceparent` values -> `<trace:N>`
- bare hex ids >= 16 chars (blob ids, checksums) -> `<hex:N>`
- binary blobs (`bytes` fields) -> `<bytes:N>` keyed by content digest
- numeric values of fields whose name matches `time|timestamp|_at$|date`, and
  ISO-8601 timestamp strings -> `<ts>`
- headers `authorization`, `proxy-authorization`, `cookie`, `x-apis-key`,
  `x-blob-encryption-key`, `x-client-key`, `x-cursor-checksum`,
  `x-cursor-privacy-mode`, `traceparent` -> `<redacted>`

Normalization is idempotent and deterministic: two captures of the same
logical run differing only in UUIDs/timestamps/tokens normalize to
byte-identical NDJSON.

### Error records

Malformed input never aborts the run: the offending line yields a record with
`decoded_fields: null`, `payload_sha256: null`, and a typed `error`, and
processing continues. The CLI exits non-zero if any error record was emitted.

## Raw `.bin` retention policy

Raw frame bytes (`.bin` files captured by the proxy) are retained un-normalized
under the capture directory for forensic re-decode, but:

- they are **never committed** (evidence lives under gitignored `.omo/`), and
- they may contain live auth tokens — treat them as secrets, keep them local,
  and delete them once the normalized NDJSON + diff report for a capture round
  is archived;
- only normalized NDJSON (with redacted headers and placeholder ids) may be
  copied into committed fixtures or shared reports.
