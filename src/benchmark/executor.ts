import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { BridgeHandle } from './bridge-process.js';
import { createCancellationTrigger } from './cancellation.js';
import { emptyTrialChild, trialChildFromResults } from './child-trace.js';
import { malformedProbe } from './malformed-probe.js';
import { observeEvents, sha256Hex } from './normalize.js';
import { OmoProcessError, runOmoTrial, type OmoSpawn, type TimedOmoEvent } from './omo-process.js';
import type { OmoComparatorInspection } from './comparator-inspection.js';
import { buildTrialPrompt } from './schedule.js';
import type { LaneTrialRequest, LaneTrialSample } from './trial-record.js';

export interface ExecutorContext {
  bridge: BridgeHandle;
  authStorePath: string;
  modelStorePath: string;
  omoBin: string;
  trialTimeoutMs: number;
  cancellationBarrierTimeoutMs?: number;
  tempRoot: string;
  signal: AbortSignal;
  onComparatorInspection?: (inspection: OmoComparatorInspection) => void;
}

function toRawEvents(events: readonly TimedOmoEvent[]): unknown[] {
  return events.map((event) => ({ ...event.value, atMs: event.atMs }));
}

function countMessageEnds(events: readonly TimedOmoEvent[]): number {
  return events.filter((event) => event.value.type === 'message_end').length;
}

export function makeExecutor(ctx: ExecutorContext) {
  return async (request: LaneTrialRequest): Promise<LaneTrialSample> => {
    if (request.testCase.kind === 'malformed') return malformedProbe(ctx, request);
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener('abort', forwardAbort, { once: true });
    const wrappedSpawn: OmoSpawn = (command, args, options) => spawn(command, args, options);
    const traceScope = ctx.bridge.beginTraceScope();
    let backendChanged = false;
    const unsubscribeBackendChange = traceScope.subscribeBackendChange(() => {
      backendChanged = true;
      controller.abort();
    });
    const cancellation =
      request.testCase.oracle.kind === 'cancellation'
        ? createCancellationTrigger({
            lane: request.lane,
            after: request.testCase.oracle.after,
            timeoutMs: ctx.cancellationBarrierTimeoutMs ?? Math.min(10_000, ctx.trialTimeoutMs),
            abort: () => controller.abort(),
            barrier: traceScope,
            externalSignal: ctx.signal,
          })
        : null;
    const started = performance.now();
    const elapsed = (): number => performance.now() - started;
    const runLaneTrial = (sentinel: string, omoSeed: string) =>
      runOmoTrial(
        {
          provider: request.lane === 'yorha' ? 'yorha' : 'cursor',
          model: 'composer-2.5',
          prompt: buildTrialPrompt(request.testCase, sentinel),
          seed: omoSeed,
          authStorePath: ctx.authStorePath,
          modelStorePath: ctx.modelStorePath,
          bridgeBaseUrl: `${ctx.bridge.baseUrl}/v1`,
          timeoutMs: ctx.trialTimeoutMs,
          command: ctx.omoBin,
          signal: controller.signal,
          tempRoot: ctx.tempRoot,
        },
        {
          spawn: wrappedSpawn,
          ...(cancellation ? { onEvent: cancellation.onEvent } : {}),
          ...(ctx.onComparatorInspection
            ? { onComparatorInspection: ctx.onComparatorInspection }
            : {}),
        },
      );
    try {
      const results =
        request.concurrency === 1
          ? [await runLaneTrial(request.sentinel, request.omoSeed)]
          : await Promise.all([
              runLaneTrial(request.sentinel, request.omoSeed),
              runLaneTrial(request.peerSentinels[0] ?? request.sentinel, `${request.omoSeed}-peer`),
            ]);
      await cancellation?.settle();
      if (request.lane === 'yorha') {
        await traceScope.waitForRunOpen(1_000, controller.signal);
      }
      const traceJoin = request.lane === 'yorha' ? await traceScope.finish() : null;
      const trace = traceScope.snapshot();
      const upstreamRuns =
        request.lane === 'yorha'
          ? (traceJoin?.attributed_run_count ?? 0)
          : results.reduce((total, result) => total + countMessageEnds(result.events), 0);
      const rawBatches = results.map((result) => toRawEvents(result.events));
      const sentinels = [request.sentinel, ...request.peerSentinels];
      const isolatedSentinels =
        request.concurrency === 2
          ? sentinels.filter((sentinel, index) => {
              const visibleText = observeEvents(rawBatches[index] ?? []).visibleText;
              return (
                visibleText.includes(sentinel) &&
                sentinels.every((peer, peerIndex) =>
                  peerIndex === index ? true : !visibleText.includes(peer),
                )
              );
            })
          : null;
      return {
        rawEvents: rawBatches.flat(),
        durationMs: elapsed(),
        upstreamRuns,
        failureClass:
          cancellation?.outcome() === 'barrier_timeout'
            ? 'harness_failure'
            : backendChanged || trace.flips > 0
              ? 'backend_flip'
              : null,
        promptHash: sha256Hex(request.prompt),
        httpStatus: null,
        isolatedSentinels,
        traceJoin,
        childReport: trialChildFromResults(results),
      };
    } catch (error) {
      if (error instanceof OmoProcessError) {
        await cancellation?.settle();
        const traceJoin = request.lane === 'yorha' ? await traceScope.finish() : null;
        const details = error.details;
        const childReport = details ? trialChildFromResults([details]) : emptyTrialChild();
        const cancellationOutcome = cancellation?.outcome();
        if (backendChanged) {
          return {
            rawEvents: toRawEvents(details?.events ?? []),
            durationMs: details?.durationMs ?? elapsed(),
            upstreamRuns: traceJoin?.attributed_run_count ?? 0,
            failureClass: 'backend_flip',
            promptHash: null,
            httpStatus: null,
            isolatedSentinels: null,
            traceJoin,
            childReport,
          };
        }
        if (error.failureClass === 'cancel_failed' && cancellationOutcome === 'cancel_sent') {
          const abortAt = elapsed();
          return {
            rawEvents: [
              ...toRawEvents(details?.events ?? []),
              { type: 'aborted', atMs: abortAt },
              { type: 'agent_end', atMs: abortAt },
            ],
            durationMs: abortAt,
            upstreamRuns: traceJoin?.attributed_run_count ?? 0,
            failureClass: null,
            promptHash: null,
            httpStatus: null,
            isolatedSentinels: null,
            traceJoin,
            childReport,
          };
        }
        return {
          rawEvents: toRawEvents(details?.events ?? []),
          durationMs: details?.durationMs ?? elapsed(),
          upstreamRuns: traceJoin?.attributed_run_count ?? 0,
          failureClass:
            cancellationOutcome === 'barrier_timeout' ? 'harness_failure' : error.failureClass,
          promptHash: null,
          httpStatus: null,
          isolatedSentinels: null,
          traceJoin,
          childReport,
        };
      }
      throw error;
    } finally {
      cancellation?.stop();
      unsubscribeBackendChange();
      ctx.signal.removeEventListener('abort', forwardAbort);
    }
  };
}
