import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { awaitWithAbort } from '../../src/backend/cursor-api/auth.js';
import {
  ConnectFrameDecoder,
  encodeConnectFrame,
} from '../../src/backend/cursor-api/connect-frame.js';
import {
  jsonToProtoValue,
  loadProtoDescriptors,
  ProtoCodec,
} from '../../src/backend/cursor-api/protobuf.js';
import type {
  CursorApiTransport,
  CursorRunStream,
} from '../../src/backend/cursor-api/transport.js';

export const codec = new ProtoCodec(loadProtoDescriptors());
export type Dict = Record<string, unknown>;
export function object(value: unknown): Dict {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
export function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
export function text(value: unknown): string {
  assert.equal(typeof value, 'string');
  return String(value);
}
export const bounded = <T>(promise: Promise<T>): Promise<T> =>
  awaitWithAbort(promise, AbortSignal.timeout(5_000));
export function oneof(value: unknown): { kind: string; value: Dict } {
  const message = object(value);
  return { kind: text(message.case), value: object(message.value) };
}
function frame(kind: string, value: Dict): Buffer {
  return encodeConnectFrame(
    codec.encode('agent.v1.AgentServerMessage', {
      message: { case: kind, value },
    }),
  );
}
function update(kind: string, value: Dict): Buffer {
  return frame('interactionUpdate', { message: { case: kind, value } });
}
export interface WireWrite {
  readonly base64: string;
  readonly decoded: Dict;
}
export interface WireRun {
  readonly endpoint: string;
  readonly token: string;
  readonly requestId: string;
  readonly writes: WireWrite[];
  readonly roots: unknown[];
  readonly stream: WireStream;
}
export class WireStream extends EventEmitter implements CursorRunStream {
  destroyed = false;
  writableEnded = false;
  readonly decoder = new ConnectFrameDecoder();
  constructor(private readonly receive: (bytes: Buffer) => void) {
    super();
  }
  write(chunk: Uint8Array): boolean {
    this.receive(Buffer.from(chunk));
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  destroy(error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (error && this.listenerCount('error')) this.emit('error', error);
    this.emit('close');
  }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writableEnded = true;
    this.emit('close');
  }
}
export interface DiscoveryGate {
  readonly entered: PromiseWithResolvers<void>;
  readonly release: PromiseWithResolvers<void>;
  readonly finished: PromiseWithResolvers<void>;
}
const contexts: Record<string, [string, string]> = {
  'token-A': ['300k', '1m'],
  'token-B': ['500k', '2m'],
  'token-A2': ['700k', '3m'],
};
export class NativeParityTransport implements CursorApiTransport {
  readonly runs: WireRun[] = [];
  readonly unaryRequests: Array<{ path: string; token: string; decoded: Dict }> = [];
  readonly plans: Array<'tool' | 'text'> = [];
  readonly gates = new Map<string, DiscoveryGate>();
  readonly resultGates = new Map<WireStream, DiscoveryGate>();
  readonly pendingGates = new Set<DiscoveryGate>();
  stopped = false;
  holdResult(run: WireRun): DiscoveryGate {
    const gate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
      finished: Promise.withResolvers<void>(),
    };
    this.resultGates.set(run.stream, gate);
    this.pendingGates.add(gate);
    return gate;
  }
  hold(token: string): DiscoveryGate {
    const gate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
      finished: Promise.withResolvers<void>(),
    };
    this.gates.set(token, gate);
    this.pendingGates.add(gate);
    return gate;
  }
  async unary(
    path: string,
    body: Uint8Array,
    _signal?: AbortSignal,
    _bootstrap?: boolean,
    token = '',
  ): Promise<Buffer> {
    const method = path.split('/').at(-1);
    const namespace =
      method === 'GetUsableModels' || method === 'GetDefaultModelForCli'
        ? 'agent.v1.'
        : 'aiserver.v1.';
    this.unaryRequests.push({
      path,
      token,
      decoded: codec.decode(namespace + method + 'Request', Buffer.from(body)),
    });
    const context = contexts[token];
    assert.ok(context, 'Only synthetic identities may reach the transport');
    if (method === 'GetServerConfig')
      return codec.encode('aiserver.v1.GetServerConfigResponse', {
        agentUrlConfig: { agentnUrl: 'https://' + token + '.test' },
      });
    if (method === 'AvailableModels') {
      const gate = this.gates.get(token);
      if (gate) {
        this.gates.delete(token);
        gate.entered.resolve();
        await gate.release.promise;
        gate.finished.resolve();
      }
      return codec.encode('aiserver.v1.AvailableModelsResponse', {
        models: [
          {
            name: 'claude-sonnet-5',
            variants: [false, true].flatMap((isMaxMode) =>
              ['medium', 'high'].map((effort) => ({
                legacySlug: 'claude-sonnet-5-' + effort,
                isMaxMode,
                parameterValues: [
                  { id: 'context', value: context[isMaxMode ? 1 : 0] },
                  { id: 'effort', value: effort },
                ],
              })),
            ),
          },
          {
            name: 'composer-2.5',
            variants: [
              { legacySlug: 'composer-2.5', parameterValues: [{ id: 'fast', value: 'false' }] },
            ],
          },
        ],
      });
    }
    if (method === 'GetUsableModels')
      return codec.encode('agent.v1.GetUsableModelsResponse', {
        models: [
          { modelId: 'claude-sonnet-5-medium', maxMode: false },
          { modelId: 'composer-2.5' },
        ],
      });
    if (method === 'GetDefaultModelForCli')
      return codec.encode('agent.v1.GetDefaultModelForCliResponse', {
        model: { modelId: 'composer-2.5' },
      });
    throw new Error('Unexpected unary method: ' + method);
  }
  async openRun(endpoint: string, requestId: string, token = ''): Promise<CursorRunStream> {
    const plan = this.plans.shift();
    assert.ok(plan, 'Unexpected extra Run (retry or ghost execution)');
    const writes: WireWrite[] = [];
    const roots: unknown[] = [];
    let started = false;
    let answered = false;
    let context: Dict | undefined;
    let pendingRoots = 0;
    const send = (bytes: Buffer) => {
      if (!stream.destroyed && !stream.writableEnded) stream.emit('data', bytes);
    };
    const finish = () =>
      send(
        Buffer.concat([
          update('textDelta', { text: 'synthetic-complete' }),
          update('turnEnded', {}),
          encodeConnectFrame(Buffer.from('{}'), { trailer: true }),
        ]),
      );
    const answer = () => {
      if (!context || pendingRoots || answered) return;
      answered = true;
      if (plan === 'text') {
        finish();
        return;
      }
      const tool = object(array(context.tools)[0]);
      const wireName = text(tool.name);
      const args = {
        name: wireName,
        toolName: wireName,
        providerIdentifier: 'bridge',
        toolCallId: 'exec-tool',
        args: { value: jsonToProtoValue('synthetic-value') },
      };
      send(
        Buffer.concat([
          update('toolCallStarted', {
            callId: 'exec-tool',
            toolCall: {
              tool: { case: 'mcpToolCall', value: { args } },
              toolCallId: 'exec-tool',
            },
          }),
          update('partialToolCall', {
            callId: 'exec-tool',
            argsTextDelta: JSON.stringify({ value: 'synthetic-value' }),
          }),
          frame('execServerMessage', {
            id: 2,
            execId: 'exec-tool',
            message: { case: 'mcpArgs', value: args },
          }),
        ]),
      );
    };
    const stream = new WireStream((bytes) => {
      for (const decodedFrame of stream.decoder.push(bytes)) {
        assert.ok(decodedFrame.payload);
        const decoded = codec.decode('agent.v1.AgentClientMessage', decodedFrame.payload);
        writes.push({ base64: bytes.toString('base64'), decoded });
        const message = oneof(decoded.message);
        // Real duplex writes are delivered after the client's write stack returns.
        queueMicrotask(() => {
          try {
            if (stream.destroyed) return;
            if (message.kind === 'runRequest') {
              assert.equal(started, false, 'One Run request per stream');
              started = true;
              stream.emit('response', { ':status': 200 });
              const ids = array(
                object(message.value.conversationState).rootPromptMessagesJson ?? [],
              );
              pendingRoots = ids.length;
              send(
                frame('execServerMessage', {
                  id: 1,
                  execId: 'context',
                  message: { case: 'requestContextArgs', value: {} },
                }),
              );
              for (const [index, blobId] of ids.entries())
                send(
                  frame('kvServerMessage', {
                    id: index + 10,
                    message: { case: 'getBlobArgs', value: { blobId } },
                  }),
                );
            } else if (message.kind === 'execClientMessage') {
              const exec = oneof(message.value.message);
              if (exec.kind === 'requestContextResult') {
                context = object(oneof(exec.value.result).value.requestContext);
                answer();
              } else if (exec.kind === 'mcpResult') {
                const gate = this.resultGates.get(stream);
                if (gate) {
                  gate.entered.resolve();
                  void gate.release.promise.then(() => {
                    finish();
                    gate.finished.resolve();
                  });
                } else finish();
              } else throw new Error('Unexpected exec reply: ' + exec.kind);
            } else if (message.kind === 'kvClientMessage') {
              const blob = oneof(message.value.message).value.blobData;
              assert.ok(blob instanceof Uint8Array);
              roots.push(JSON.parse(Buffer.from(blob).toString('utf8')));
              pendingRoots -= 1;
              answer();
            }
          } catch (error) {
            stream.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    });
    this.runs.push({ endpoint, token, requestId, writes, roots, stream });
    return stream;
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const gate of this.pendingGates) gate.release.resolve();
    for (const run of this.runs) run.stream.destroy();
  }
}
export function runRequest(run: WireRun): Dict {
  const request = run.writes
    .map((write) => oneof(write.decoded.message))
    .find((message) => message.kind === 'runRequest');
  assert.ok(request);
  return request.value;
}
export function execReplies(run: WireRun, kind: string): Dict[] {
  return run.writes.flatMap((write) => {
    const message = oneof(write.decoded.message);
    if (message.kind !== 'execClientMessage') return [];
    const exec = oneof(message.value.message);
    return exec.kind === kind ? [exec.value] : [];
  });
}
