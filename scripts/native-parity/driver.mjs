/* global AbortController, process */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { toolsFor } from '../native-parity-mcp.mjs';
import { compareClientProfiles } from '../native-profile-compare.mjs';
import { makeLoader } from '../webpack-shim.mjs';
import { collectTypes } from '../protos/bundle.mjs';
import { buildDescriptorOutput } from '../protos/descriptors.mjs';
import { ROOT, MCP, json, sha } from './shared.mjs';
import { promptFor, validateCase } from './cases.mjs';
import {
  buildBridge,
  generateCaptureCerts,
  hashedAccount,
  minimalEnvironment,
} from './prerequisites.mjs';
import { captureLane } from './capture-lane.mjs';
import { wireSummary } from './capture-analysis.mjs';

export async function runLive(options) {
  if (!process.env.CURSOR_AUTH_TOKEN) throw new Error('CURSOR_AUTH_TOKEN_required');
  const account = hashedAccount(process.env.CURSOR_AUTH_TOKEN);
  const cli = fs.realpathSync(
    process.env.NATIVE_PARITY_CURSOR_BIN ?? path.join(os.homedir(), '.local/bin/cursor-agent'),
  );
  fs.accessSync(cli, fs.constants.X_OK);
  if (fs.existsSync(options.evidenceDir)) throw new Error('evidence_directory_must_be_new');
  fs.mkdirSync(options.evidenceDir, { recursive: true, mode: 0o700 });
  const rawDir = path.join(options.evidenceDir, 'private');
  fs.mkdirSync(rawDir, { mode: 0o700 });
  const nextCode = `NEXT_${randomBytes(16).toString('hex')}`;
  const prompt = promptFor(options.caseId);
  json(path.join(rawDir, 'fixture.json'), { prompt, tools: toolsFor(options.caseId), nextCode });
  const summary = {
    schema_version: 1,
    case: options.caseId,
    model: 'composer-2.5',
    cli_version: path.basename(path.dirname(cli)),
    cli_bundle_sha256: sha(fs.readFileSync(path.join(path.dirname(cli), 'index.js'))),
    account,
    prompt_sha256: sha(prompt),
    tools_sha256: sha(JSON.stringify(toolsFor(options.caseId))),
    workspace_identical: true,
    baseline_context_identical: false,
    lanes: {},
    cleanup: [],
    ok: false,
  };
  const controller = new AbortController();
  let temporaryRoot;
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    summary.build = await buildBridge(rawDir, summary.cleanup, controller.signal);
    if (summary.build.descriptor_bundle_version !== summary.cli_version)
      throw new Error('descriptor_cli_version_mismatch');
    const { ProtoCodec } = await import(
      pathToFileURL(path.join(ROOT, 'dist/backend/cursor-api/protobuf.js')).href
    );
    const types = collectTypes(makeLoader(path.dirname(cli)));
    const codec = new ProtoCodec(
      buildDescriptorOutput({
        types,
        bundleVersion: summary.cli_version,
        extractedAt: new Date().toISOString(),
        selected: new Map([...types.keys()].map((name) => [name, '*'])),
      }),
    );
    const certs = await generateCaptureCerts(
      path.join(rawDir, 'certs'),
      summary.cleanup,
      controller.signal,
    );
    // Short paths avoid the installed CLI's long-data-path fallback to /tmp/.cursor.
    // Outside the repo, so ancestor .git/context/direnv files cannot leak into either lane.
    temporaryRoot = fs.mkdtempSync('/tmp/np-');
    fs.chmodSync(temporaryRoot, 0o700);
    const workspace = path.join(temporaryRoot, 'workspace');
    const cursorDir = path.join(workspace, '.cursor');
    for (const lane of ['native', 'yorha']) {
      const laneDir = path.join(rawDir, lane);
      fs.mkdirSync(laneDir);
      const home = path.join(temporaryRoot, 'home');
      fs.rmSync(home, { recursive: true, force: true });
      fs.mkdirSync(home);
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.mkdirSync(cursorDir, { recursive: true });
      const env = minimalEnvironment(home, certs.caCrt);
      // Only the MCP subprocess receives the fixture's opaque next argument.
      json(path.join(cursorDir, 'mcp.json'), {
        mcpServers: toolsFor(options.caseId).length
          ? {
              bridge: {
                command: process.execPath,
                args: [MCP],
                env: {
                  NATIVE_PARITY_CASE: options.caseId,
                  NATIVE_PARITY_NEXT_CODE: nextCode,
                  NATIVE_PARITY_MCP_AUDIT: path.join(rawDir, 'native/mcp-audit.jsonl'),
                },
              },
            }
          : {},
      });
      const workspaceSnapshot = fs.readFileSync(path.join(cursorDir, 'mcp.json'));
      fs.writeFileSync(path.join(laneDir, 'workspace-mcp.json'), workspaceSnapshot, {
        mode: 0o600,
      });
      const receipts = summary.cleanup;
      try {
        const result = await captureLane({
          ...options,
          lane,
          laneDir,
          workspace,
          certs,
          cli,
          env,
          prompt,
          nextCode,
          receipts,
          signal: controller.signal,
        });
        json(path.join(laneDir, 'result.json'), result);
        const oracle = validateCase(options.caseId, result, { requireRecovery: lane === 'yorha' });
        const wire = await wireSummary(laneDir, options.caseId, codec);
        const expectedRuns = options.caseId === 'cancel' && lane === 'yorha' ? 2 : 1;
        if (wire.kinds['client:runRequest'] !== expectedRuns)
          wire.failures.push('unexpected_run_count');
        if (wire.failures.length) {
          oracle.ok = false;
          oracle.failures.push(...wire.failures);
        }
        summary.lanes[lane] = {
          oracle,
          wire,
          workspace_sha256: sha(workspaceSnapshot),
          text_sha256: sha(result.text),
          calls: result.calls.map((call) => ({
            name: call.name,
            args_sha256: sha(JSON.stringify(call.args)),
            result_sha256: sha(call.result),
          })),
          cancelled: result.cancelled,
          upstream_closed_before_cleanup: result.upstreamClosedBeforeCleanup,
          terminal: result.terminal,
          recovery: result.recovery ?? null,
          rounds: result.rounds ?? null,
        };
      } catch (error) {
        fs.writeFileSync(path.join(laneDir, 'failure.private.log'), String(error.stack ?? error), {
          mode: 0o600,
        });
        summary.lanes[lane] = { oracle: { ok: false, failures: ['lane_runtime_failure'] } };
      }
      if (controller.signal.aborted || summary.cleanup.some((receipt) => !receipt.ok)) break;
    }
    const a = summary.lanes.native;
    const b = summary.lanes.yorha;
    const profile = (lane) => {
      const file = path.join(rawDir, lane, 'client-profile.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    };
    summary.profile_comparison = compareClientProfiles(profile('native'), profile('yorha'), {
      freshRepositories: true,
    });
    summary.baseline_context_identical = summary.profile_comparison.ok;
    summary.diff = {
      kind_count_deltas: Object.fromEntries(
        [...new Set([...Object.keys(a?.wire?.kinds ?? {}), ...Object.keys(b?.wire?.kinds ?? {})])]
          .sort()
          .map((kind) => [kind, (b?.wire?.kinds[kind] ?? 0) - (a?.wire?.kinds[kind] ?? 0)]),
      ),
      comparable_inputs: true,
      identical_wire_shapes: Boolean(
        a?.wire && b?.wire && a.wire.shape_sequence_sha256 === b.wire.shape_sequence_sha256,
      ),
      identical_tool_results: Boolean(
        a?.calls && b?.calls && JSON.stringify(a.calls) === JSON.stringify(b.calls),
      ),
      baseline_differences_are_not_runtime_failure: true,
    };
    summary.ok = Boolean(
      a?.oracle.ok &&
      b?.oracle.ok &&
      summary.profile_comparison.ok &&
      summary.cleanup.every((receipt) => receipt.ok),
    );
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (temporaryRoot) {
      const receipt = { role: 'isolated-home-and-workspace', ok: false };
      summary.cleanup.push(receipt);
      try {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        receipt.ok = true;
      } catch {
        receipt.error = 'temporary_cleanup_failed';
      }
    }
    summary.ok = summary.ok && summary.cleanup.every((receipt) => receipt.ok);
    json(path.join(options.evidenceDir, 'summary.json'), summary);
  }
  return summary;
}
