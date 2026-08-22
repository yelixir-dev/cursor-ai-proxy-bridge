import { isDeepStrictEqual } from 'node:util';
import type { CompletionStreamEvent, ToolCall } from '../types.js';
import { mcpArgsToToolCall } from './mcp-tool-call.js';

type Dict = Record<string, unknown>;
type ToolEmitter = (event: CompletionStreamEvent) => boolean | undefined;

type ToolIdentity = {
  readonly envelopeId: string;
  readonly id: string;
  readonly name: string;
};

/** Per-Run accumulator: mutation is required to reconcile cumulative snapshots. */
type ToolSlot = {
  readonly index: number;
  readonly envelopeId: string;
  id: string;
  name: string;
  arguments: string;
  started: boolean;
  call?: ToolCall;
};

export class ToolCallReconciliationError extends Error {
  constructor(readonly callId: string) {
    super(
      `Cursor completed tool call ${JSON.stringify(callId)} with incompatible partial arguments`,
    );
    this.name = 'ToolCallReconciliationError';
  }
}

function dict(value: unknown): Dict | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function mcpArgs(toolCall: unknown): Dict | undefined {
  const call = dict(toolCall);
  const tool = dict(call?.tool);
  if (tool?.case !== 'mcpToolCall') return undefined;
  return dict(dict(tool.value)?.args);
}

function identityFromUpdate(update: Dict): ToolIdentity | undefined {
  const envelopeId = stringField(update.callId);
  const toolCall = dict(update.toolCall);
  const args = mcpArgs(toolCall);
  const name = stringField(args?.toolName) || stringField(args?.name);
  const id = stringField(args?.toolCallId) || stringField(toolCall?.toolCallId) || envelopeId;
  if (!envelopeId || !id || !name) return undefined;
  return { envelopeId, id, name };
}

function callFromUpdate(update: Dict): ToolCall | undefined {
  const args = mcpArgs(update.toolCall);
  if (!args) return undefined;
  const call = mcpArgsToToolCall(args);
  return call.function.name === 'unknown_tool' ? undefined : call;
}

function semanticallyEqual(left: string, right: string): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(left), JSON.parse(right));
  } catch {
    return false;
  }
}

export class CursorToolStream {
  private readonly slots: ToolSlot[] = [];
  private readonly aliases = new Map<string, ToolSlot>();
  private readonly ignoredEnvelopeIds = new Set<string>();
  private readonly announcedEnvelopeIds = new Set<string>();

  private emit: ToolEmitter | undefined;

  constructor(
    emit: ToolEmitter | undefined,
    private readonly allowedNames: ReadonlySet<string>,
    private readonly maximumCalls: number,
  ) {
    this.emit = emit;
  }

  setEmit(emit: ToolEmitter | undefined): void {
    this.emit = emit;
  }

  start(value: Dict): void {
    const identity = identityFromUpdate(value);
    if (!identity || !this.allowedNames.has(identity.name)) {
      const envelopeId = stringField(value.callId);
      if (envelopeId) this.ignoredEnvelopeIds.add(envelopeId);
      return;
    }
    this.announcedEnvelopeIds.add(identity.envelopeId);
    const slot = this.slot(identity);
    if (slot) this.emitStart(slot);
  }

  partial(value: Dict): void {
    const envelopeId = stringField(value.callId);
    if (!envelopeId || this.ignoredEnvelopeIds.has(envelopeId)) return;
    const identity = identityFromUpdate(value);
    if (identity && !this.allowedNames.has(identity.name)) {
      this.ignoredEnvelopeIds.add(envelopeId);
      return;
    }
    const slot = identity ? this.slot(identity) : this.aliases.get(envelopeId);
    if (!slot) return;
    this.emitStart(slot);
    const snapshot = stringField(value.argsTextDelta);
    if (!snapshot) return;
    const delta = snapshot.startsWith(slot.arguments)
      ? snapshot.slice(slot.arguments.length)
      : snapshot;
    if (!delta) return;
    slot.arguments += delta;
    if (slot.started) {
      this.emit?.({
        type: 'tool_call_arguments_delta',
        index: slot.index,
        id: slot.id,
        delta,
      });
    }
  }

  completeUpdate(value: Dict): void {
    const call = callFromUpdate(value);
    if (!call || !this.allowedNames.has(call.function.name)) return;
    const identity = identityFromUpdate(value) ?? {
      envelopeId: stringField(value.callId) || call.id,
      id: call.id,
      name: call.function.name,
    };
    const slot = this.slot(identity);
    if (slot) this.completeSlot(slot, call);
  }

  completeExec(value: Dict): void {
    const call = mcpArgsToToolCall(value);
    if (!this.allowedNames.has(call.function.name)) return;
    const compatible = this.aliases.get(call.id) ?? this.uniqueCompatibleSlot(call);
    const slot = compatible
      ? this.slot({ envelopeId: compatible.envelopeId, id: call.id, name: call.function.name })
      : this.slot({ envelopeId: call.id, id: call.id, name: call.function.name });
    if (slot) this.completeSlot(slot, call);
  }

  completedCalls(): ToolCall[] {
    return this.slots.flatMap((slot) => (slot.call ? [slot.call] : []));
  }

  frameCounts(): { announced: number; completed: number } {
    return {
      announced: this.announcedEnvelopeIds.size,
      completed: this.completedCalls().length,
    };
  }

  batchComplete(parallel: boolean): boolean {
    const completed = this.completedCalls().length;
    if (!parallel) return completed > 0;
    return this.slots.length > 0 && completed === this.slots.length;
  }

  /** A started slot whose completing exec has not arrived yet. */
  hasIncompleteStartedCalls(): boolean {
    return this.slots.some((slot) => slot.started && !slot.call);
  }

  get emitted(): boolean {
    return this.emit !== undefined && this.slots.some((slot) => slot.started);
  }

  private slot(identity: ToolIdentity): ToolSlot | undefined {
    const byEnvelope = this.aliases.get(identity.envelopeId);
    const byId = this.aliases.get(identity.id);
    if (byEnvelope && byId && byEnvelope !== byId) {
      throw new ToolCallReconciliationError(identity.id);
    }
    const existing = byEnvelope ?? byId;
    if (existing) {
      this.bindAlias(identity.envelopeId, existing);
      this.bindAlias(identity.id, existing);
      if (existing.started && this.emit) {
        if (existing.name !== identity.name) {
          throw new ToolCallReconciliationError(existing.id);
        }
      } else {
        existing.id = identity.id;
        existing.name = identity.name;
      }
      return existing;
    }
    if (this.slots.length >= this.maximumCalls) return undefined;
    const slot: ToolSlot = {
      index: this.slots.length,
      envelopeId: identity.envelopeId,
      id: identity.id,
      name: identity.name,
      arguments: '',
      started: false,
    };
    this.slots.push(slot);
    this.bindAlias(identity.envelopeId, slot);
    this.bindAlias(identity.id, slot);
    return slot;
  }

  private uniqueCompatibleSlot(authoritative: ToolCall): ToolSlot | undefined {
    const candidates = this.slots.filter(
      (slot) =>
        slot.name === authoritative.function.name &&
        (authoritative.function.arguments.startsWith(slot.arguments) ||
          semanticallyEqual(slot.arguments, authoritative.function.arguments)),
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private bindAlias(alias: string, slot: ToolSlot): void {
    const existing = this.aliases.get(alias);
    if (existing && existing !== slot) throw new ToolCallReconciliationError(alias);
    this.aliases.set(alias, slot);
  }

  private emitStart(slot: ToolSlot): void {
    if (slot.started) return;
    slot.started = true;
    this.emit?.({
      type: 'tool_call_start',
      index: slot.index,
      id: slot.id,
      name: slot.name,
    });
  }

  private completeSlot(slot: ToolSlot, authoritative: ToolCall): void {
    const canonical: ToolCall = {
      ...authoritative,
      id: slot.id,
      function: { ...authoritative.function, name: slot.name },
    };
    if (slot.call) {
      if (!isDeepStrictEqual(slot.call, canonical)) {
        throw new ToolCallReconciliationError(slot.id);
      }
      return;
    }
    this.emitStart(slot);
    let call = canonical;
    if (slot.arguments) {
      if (canonical.function.arguments.startsWith(slot.arguments)) {
        const delta = canonical.function.arguments.slice(slot.arguments.length);
        if (delta) {
          slot.arguments += delta;
          this.emit?.({
            type: 'tool_call_arguments_delta',
            index: slot.index,
            id: slot.id,
            delta,
          });
        }
      } else if (semanticallyEqual(slot.arguments, canonical.function.arguments)) {
        call = {
          ...canonical,
          function: { ...canonical.function, arguments: slot.arguments },
        };
      } else {
        throw new ToolCallReconciliationError(slot.id);
      }
    } else {
      slot.arguments = canonical.function.arguments;
      this.emit?.({
        type: 'tool_call_arguments_delta',
        index: slot.index,
        id: slot.id,
        delta: slot.arguments,
      });
    }
    slot.call = call;
  }
}
