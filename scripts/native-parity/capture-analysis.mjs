/* global Buffer */
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { toolsFor } from '../native-parity-mcp.mjs';
import { json, readLines, sha } from './shared.mjs';

function fieldShape(value) {
  if (Array.isArray(value)) return value.map(fieldShape);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, fieldShape(value[key])]),
    );
  return typeof value;
}

export function analyzeFrames(rows, codec, caseId) {
  const profile = {};
  let initialStream;
  const frames = rows.filter((row) => row.event === 'frame');
  const kinds = {};
  const shapes = [];
  const execs = [];
  const closes = [];
  const declarations = new Set();
  const expected = toolsFor(caseId).map((tool) => tool.name);
  const inspectDefinitions = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.mcpMetaToolOptions?.enabled === true) {
      for (const server of value.mcpMetaToolOptions.mcpDescriptors ?? []) {
        for (const tool of server.tools ?? []) {
          if (expected.includes(tool.toolName)) declarations.add(tool.toolName);
        }
      }
    }
    if ('inputSchema' in value || 'inputSchemaJson' in value) {
      for (const name of expected)
        if (
          [value.name, value.toolName].some(
            (raw) => typeof raw === 'string' && (raw === name || raw.endsWith(`_${name}`)),
          )
        )
          declarations.add(name);
    }
    for (const child of Object.values(value)) inspectDefinitions(child);
  };
  let decodeErrors = 0;
  let trailers = 0;
  let trailerErrors = 0;
  for (const frame of frames) {
    try {
      let payload = Buffer.from(frame.payload_b64, 'base64');
      if (frame.flags & 1) payload = gunzipSync(payload);
      if (frame.flags & 2) {
        trailers++;
        if (JSON.parse(payload.toString()).error) trailerErrors++;
        continue;
      }
      const decoded = codec.decode(
        frame.dir === 'client' ? 'agent.v1.AgentClientMessage' : 'agent.v1.AgentServerMessage',
        payload,
      );
      const message = decoded.message;
      if (frame.dir === 'client' && message?.case === 'runRequest') {
        if (profile.run && caseId !== 'cancel') throw new Error('multiple_initial_runs');
        if (!profile.run) {
          profile.run = message.value;
          initialStream = JSON.stringify([frame.conn, frame.stream]);
        }
      }
      if (frame.dir === 'client' && message?.case === 'execClientMessage') {
        const result = message.value.message;
        if (result?.case === 'requestContextResult' && result.value.result?.case === 'success') {
          if (initialStream === JSON.stringify([frame.conn, frame.stream])) {
            if (profile.context) throw new Error('multiple_initial_contexts');
            profile.context = result.value.result.value.requestContext;
          }
        }
      }
      if (frame.dir === 'client') inspectDefinitions(decoded);
      const kind = `${frame.dir}:${message?.case ?? 'unknown'}`;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      shapes.push({ kind, shape_sha256: sha(JSON.stringify(fieldShape(decoded))) });
      if (
        frame.dir === 'client' &&
        message?.case === 'execClientControlMessage' &&
        message.value.message?.case === 'streamClose'
      ) {
        closes.push({
          conn: frame.conn,
          stream: frame.stream,
          id: message.value.message.value.id ?? 0,
          sequence: frame.sequence,
        });
      }
      if (message?.case === 'execServerMessage' || message?.case === 'execClientMessage') {
        const value = message.value;
        const arm = value.message ?? value.result ?? value.args;
        execs.push({
          dir: frame.dir,
          stream: frame.stream,
          conn: frame.conn,
          id: value.id ?? 0,
          arm: arm?.case ?? null,
          success: arm?.case === 'mcpResult' && arm.value?.result?.case === 'success',
          sequence: frame.sequence,
        });
      }
    } catch {
      decodeErrors++;
    }
  }
  const requests = execs.filter((exec) => exec.dir === 'server' && exec.arm === 'mcpArgs');
  const execFailures = [];
  for (const reply of execs.filter((exec) => exec.dir === 'client')) {
    const close = closes.find(
      (item) => item.conn === reply.conn && item.stream === reply.stream && item.id === reply.id,
    );
    if (!close) execFailures.push('exec_close_missing');
    else if (close.sequence <= reply.sequence) execFailures.push('exec_close_before_result');
  }
  const results = execs.filter((exec) => exec.dir === 'client' && exec.arm === 'mcpResult');
  const unanswered = requests.filter(
    (request) =>
      !results.some(
        (result) =>
          result.conn === request.conn &&
          result.stream === request.stream &&
          result.id === request.id &&
          result.success &&
          result.sequence > request.sequence,
      ),
  );
  const failures = [];
  if (!frames.length || decodeErrors || trailerErrors) failures.push('wire_validation_failed');
  if (
    expected.length &&
    (expected.some((name) => !declarations.has(name)) || requests.length < 2 || unanswered.length)
  )
    failures.push('external_mcp_wire_incomplete');
  if (caseId !== 'cancel' && !trailers) failures.push('missing_terminal_trailer');
  const parallelOverlap = requests.some((a, index) =>
    requests
      .slice(index + 1)
      .some(
        (b) =>
          a.conn === b.conn &&
          a.stream === b.stream &&
          !results.some(
            (r) =>
              r.conn === a.conn &&
              r.stream === a.stream &&
              r.id === a.id &&
              r.sequence < b.sequence,
          ),
      ),
  );
  return {
    frame_count: frames.length,
    kinds,
    shape_sequence_sha256: sha(JSON.stringify(shapes)),
    decode_errors: decodeErrors,
    trailers,
    trailer_errors: trailerErrors,
    declared_tools: [...declarations].sort(),
    mcp_requests: requests.length,
    mcp_results: results.length,
    mcp_unanswered: unanswered.length,
    parallel_overlap_observed: parallelOverlap,
    failures,
    shapes,
    profile,
    exec_failures: execFailures,
  };
}

export async function wireSummary(laneDir, caseId, codec) {
  const result = analyzeFrames(
    readLines(path.join(laneDir, 'agentn/exact-wire.ndjson')),
    codec,
    caseId,
  );
  json(path.join(laneDir, 'wire-shapes.json'), result.shapes);
  json(path.join(laneDir, 'client-profile.json'), result.profile);
  delete result.shapes;
  delete result.profile;
  result.failures.push(...result.exec_failures);
  return result;
}
