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
  emittedStart: boolean;
  emittedArguments: string;
  execId?: string;
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
    private readonly callIdPrefix?: string,
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
    if (slot) {
      slot.started = true;
      this.flushSlot(slot);
    }
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
    slot.started = true;
    const snapshot = stringField(value.argsTextDelta);
    if (!snapshot) return;
    const delta = snapshot.startsWith(slot.arguments)
      ? snapshot.slice(slot.arguments.length)
      : snapshot;
    if (!delta) return;
    slot.arguments += delta;
    this.flushSlot(slot);
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

  completeExec(value: Dict): boolean {
    const call = mcpArgsToToolCall(value);
    if (!this.allowedNames.has(call.function.name)) return false;
    const compatible = this.aliases.get(call.id) ?? this.uniqueCompatibleSlot(call);
    const slot = compatible
      ? this.slot({ envelopeId: compatible.envelopeId, id: call.id, name: call.function.name })
      : this.slot({ envelopeId: call.id, id: call.id, name: call.function.name });
    if (!slot) return false;
    slot.execId ??= call.id;
    this.completeSlot(slot, call);
    return true;
  }

  completedCalls(): ToolCall[] {
    return this.slots.flatMap((slot) => (slot.call ? [slot.call] : []));
  }

  execIdFor(callId: string): string | undefined {
    return this.aliases.get(callId)?.execId;
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
    const visible = this.visibleSlots();
    return visible.length > 0 && completed === visible.length;
  }

  /** A started slot whose completing exec has not arrived yet. */
  hasIncompleteStartedCalls(): boolean {
    return this.visibleSlots().some((slot) => slot.started && !slot.call);
  }

  get emitted(): boolean {
    return this.emit !== undefined && this.visibleSlots().some((slot) => slot.emittedStart);
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
      if (existing.emittedStart) {
        if (existing.name !== identity.name) {
          throw new ToolCallReconciliationError(existing.id);
        }
      } else {
        if (!this.callIdPrefix) existing.id = identity.id;
        existing.name = identity.name;
      }
      return existing;
    }
    const index = this.slots.length;
    const slot: ToolSlot = {
      index,
      envelopeId: identity.envelopeId,
      id: this.callIdPrefix
        ? `call_${this.callIdPrefix.replaceAll('-', '')}_${index}`
        : identity.id,
      name: identity.name,
      arguments: '',
      started: false,
      emittedStart: false,
      emittedArguments: '',
    };
    this.slots.push(slot);
    this.bindAlias(identity.envelopeId, slot);
    this.bindAlias(identity.id, slot);
    this.bindAlias(slot.id, slot);
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
    if (slot.emittedStart) return;
    slot.emittedStart = true;
    this.emit?.({
      type: 'tool_call_start',
      index: this.outputIndex(slot),
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
    slot.started = true;
    let call = canonical;
    if (slot.arguments) {
      if (canonical.function.arguments.startsWith(slot.arguments)) {
        // flushSlot emits any authoritative suffix when this slot is visible.
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
    }
    slot.call = call;
    this.flushSlot(slot);
  }

  private visibleSlots(): ToolSlot[] {
    return Number.isFinite(this.maximumCalls) ? this.slots.slice(0, this.maximumCalls) : this.slots;
  }

  private outputIndex(slot: ToolSlot): number {
    return slot.index;
  }

  private flushSlot(slot: ToolSlot): void {
    if (!this.emit || !this.visibleSlots().includes(slot) || !slot.started) return;
    this.emitStart(slot);
    const argumentsJson = slot.call?.function.arguments ?? slot.arguments;
    if (argumentsJson === slot.emittedArguments) return;
    if (!argumentsJson.startsWith(slot.emittedArguments)) {
      throw new ToolCallReconciliationError(slot.id);
    }
    const delta = argumentsJson.slice(slot.emittedArguments.length);
    slot.emittedArguments = argumentsJson;
    if (delta) {
      this.emit({
        type: 'tool_call_arguments_delta',
        index: this.outputIndex(slot),
        id: slot.id,
        delta,
      });
    }
  }
}
