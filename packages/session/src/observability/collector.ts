import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AdapterObservationEvent, CancelReason, DecideObservationPort, Measurement, ObservationClock,
  ObservationEvent, ObservationFields, ObservationMetrics, ObservationOutcome, ObservationRef, ObservabilityOptions } from '@werewolf/protocol';
import type { RoomReadRecord } from '../room-types';
import type { SeatRecord } from '../store';
import { ObservationIdentities } from './identity';

export const measured = (valueMs: number): Measurement => ({ valueMs: Math.max(0, valueMs), source: 'client' });
export const missing = (reason: 'not_observable' | 'not_applicable' | 'not_emitted' | 'cancelled_before_point' | 'failed_before_point' | 'incomplete' = 'not_observable'): Measurement => ({ valueMs: null, reason });
type Kind = ObservationEvent['kind'];
type SpanData = ObservationFields & { parentId?: string };

const metricNames = new Set(['gateWaitMs','pacingWaitMs','plannedWaitMs','wavePrepareMs','localPreDispatchMs','actionSegmentMs',
  'markAskedMs','modelCallMs','adapterExecutionMs','requestEncodeMs','serializeMs','requestSendMs','headersMs','firstBodyByteMs',
  'firstStreamContentMs','legacyFirstDeltaMs','legacyLatencyMs','parsedOutputAvailableMs','bodyConsumeMs','parseMs','httpAttemptMs','backoffMs',
  'waveAwaitMs','memberTailWaitMs','waveWallMs','persistenceMs','providerQueueMs','roomWallMs','runWallMs']);
const idNames = ['id','parentId','runId','roomRef','seatRef','waveId','workId','decisionRef','actionId','actionSegmentId','callId','requestId','httpAttemptId','causedByCallId','providerId','modelKey'] as const;
const enumFields: Record<string, readonly string[]> = {
  kind: ['run','room','wave','work','action_segment','model_call','engine_action','adapter_execution','http_request','http_attempt','backoff','local_span'],
  phase: ['start','end','point'], apiProtocol: ['chat_completions','responses','anthropic_messages'], purpose: ['listen','action'],
  outcome: ['success','invalid_tool','timeout','cancelled','http_error','network_error','parse_error','local_error','stale','incomplete','await_rejected','empty','accepted','rejected','fallback','skipped'],
  cancelReason: ['pause','end','decision_changed','dispose','unknown'], actionKind: ['normal','interrupt','automatic'],
  variantReason: ['initial','stream_unsupported','tool_choice_unsupported','json_format_unsupported'],retryReason: ['network','429','5xx'],
  operation: ['store_load','store_save','audit_read','audit_append','request_encode','serialize','parse','gate_wait','pacing_wait'],
  firstContentKind: ['reply','thinking','tool_name','tool_arguments'], bodyEndKind: ['protocol_end','eof','error','cancelled','discarded'],
  providerQueueContract: ['synthetic_v1'],
};

function measurement(value: unknown): Measurement | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (typeof row.valueMs === 'number' && Number.isFinite(row.valueMs) && row.valueMs >= 0 && ['client','provider_reported','synthetic'].includes(String(row.source))) {
    return { valueMs: row.valueMs, source: row.source as 'client' };
  }
  if (row.valueMs === null && ['not_observable','not_applicable','not_emitted','cancelled_before_point','failed_before_point','incomplete','legacy','collector_dropped'].includes(String(row.reason))) {
    return { valueMs: null, reason: row.reason as 'not_observable' };
  }
}

/** 类型外的输入也重新投影为白名单，不复制任意对象或原始字符串。 */
export function whitelistObservation(event: ObservationEvent): ObservationEvent {
  const source = event as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { schemaVersion: 1 };
  for (const key of idNames) if (typeof source[key] === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(source[key])) out[key] = source[key];
  for (const [key, values] of Object.entries(enumFields)) if (values.includes(String(source[key]))) out[key] = source[key];
  for (const key of ['atMs','wallTimeMs','correctionAttempt','variantIndex','attemptIndex','status','members','httpAttemptsStarted','httpAttemptsFinished','compatibilityFallbacks']) {
    const value = source[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  const duration = measurement(source.durationMs); if (duration) out.durationMs = duration;
  if (source.metrics && typeof source.metrics === 'object') {
    const metrics: Record<string, Measurement> = {};
    for (const [key, value] of Object.entries(source.metrics)) { const m = measurement(value); if (metricNames.has(key) && m) metrics[key] = m; }
    out.metrics = metrics;
  }
  if (source.features && typeof source.features === 'object') {
    const f = source.features as Record<string, unknown>;
    out.features = { stream: f.stream === true, responseFormat: f.responseFormat === true,
      toolChoice: ['auto','required','none'].includes(String(f.toolChoice)) ? f.toolChoice : 'none',
      ...(['cold','warm'].includes(String(f.compatibilityMemory)) ? { compatibilityMemory: f.compatibilityMemory } : {}) };
  }
  if (source.usage && typeof source.usage === 'object') {
    const u = source.usage as Record<string, unknown>, usage: Record<string, unknown> = {};
    for (const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens']) usage[key] = typeof u[key] === 'number' && Number.isFinite(u[key]) && u[key] >= 0 ? u[key] : null;
    usage.completeness = ['complete','partial','unknown'].includes(String(u.completeness)) ? u.completeness : 'unknown';
    if (typeof u.sourceHttpAttemptId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(u.sourceHttpAttemptId)) usage.sourceHttpAttemptId = u.sourceHttpAttemptId;
    out.usage = usage;
  }
  return out as unknown as ObservationEvent;
}

export class ObservationSpan {
  readonly started: number;
  endedAt?: number;
  constructor(readonly owner: RoomObservability, readonly kind: Kind, readonly ref: ObservationRef, readonly id: string, readonly fields: SpanData) {
    this.started = owner.clock.monotonicMs();
    owner.record({ ...ref, ...fields, kind, id, phase: 'start', atMs: this.started } as ObservationEvent);
  }
  finish(outcome: ObservationOutcome = 'success', metrics: ObservationMetrics = {}, fields: SpanData = {}, atMs?: number): void {
    if (this.endedAt !== undefined) return;
    this.endedAt = atMs ?? this.owner.clock.monotonicMs();
    this.owner.record({ ...this.ref, ...this.fields, ...fields, kind: this.kind, id: this.id, phase: 'end', atMs: this.endedAt,
      outcome, durationMs: measured(this.endedAt - this.started), metrics } as ObservationEvent);
  }
  elapsed(): number { return Math.max(0, this.owner.clock.monotonicMs() - this.started); }
}

export class RoomObservability {
  readonly clock: ObservationClock;
  readonly runId = `run-${randomUUID()}`;
  readonly stats = { callbackErrors: 0, lateEvents: 0, activeSpans: 0 };
  private readonly identities: ObservationIdentities;
  private readonly rooms = new Map<string, ObservationSpan>();
  private readonly decisions = new Map<string, string>();
  private readonly active = new Map<string, ObservationEvent>();
  private readonly endedCalls = new Map<string, number>();
  private readonly expiredCalls = new Set<string>();
  private next = 0;
  private closed = false;
  private readonly run: ObservationSpan;
  private readonly expiry: ReturnType<typeof setInterval>;

  constructor(private readonly options: ObservabilityOptions) {
    this.clock = {
      monotonicMs: () => { try { const value = options.clock?.monotonicMs() ?? performance.now(); if (Number.isFinite(value)) return value; } catch { this.stats.callbackErrors++; } return performance.now(); },
      wallTimeMs: () => { try { const value = options.clock?.wallTimeMs() ?? Date.now(); if (Number.isFinite(value)) return value; } catch { this.stats.callbackErrors++; } return Date.now(); },
    };
    this.identities = new ObservationIdentities(options.mappingPath ?? 'data/diagnostics/identity-map.json', options.providerAlias, options.providerAliases);
    this.run = this.begin('run', { schemaVersion: 1, runId: this.runId, roomRef: 'all' });
    this.expiry = setInterval(() => this.expire(), 1000);
    this.expiry.unref?.();
  }

  id(kind: string): string { return `${this.runId}:${kind}:${++this.next}`; }
  room(rec: Pick<RoomReadRecord, 'id'>): ObservationSpan {
    let span = this.rooms.get(rec.id);
    if (!span) {
      span = this.begin('room', { schemaVersion: 1, runId: this.runId, roomRef: `r${this.rooms.size + 1}` });
      this.rooms.set(rec.id, span);
    }
    return span;
  }
  ref(rec: Pick<RoomReadRecord, 'id'>, seat?: number, decision?: string): ObservationRef {
    const base = this.room(rec).ref;
    let decisionRef: string | undefined;
    if (decision) {
      const key = `${rec.id}:${decision}`;
      decisionRef = this.decisions.get(key);
      if (!decisionRef) { decisionRef = `d${this.decisions.size + 1}`; this.decisions.set(key, decisionRef); }
    }
    return { ...base, ...(seat === undefined ? {} : { seatRef: `s${seat}` }), ...(decisionRef ? { decisionRef } : {}) };
  }
  provider(cfg: SeatRecord): Pick<ObservationFields, 'providerId' | 'modelKey' | 'apiProtocol'> {
    try { return { providerId: this.identities.provider(cfg.baseUrl), modelKey: this.identities.model(cfg.model || 'mock'), apiProtocol: cfg.apiProtocol ?? 'chat_completions' }; }
    catch { this.stats.callbackErrors++; return { providerId: 'unknown', modelKey: 'unknown', apiProtocol: cfg.apiProtocol ?? 'chat_completions' }; }
  }
  begin(kind: Kind, ref: ObservationRef, fields: SpanData = {}, id = this.id(kind)): ObservationSpan {
    return new ObservationSpan(this, kind, ref, id, fields);
  }
  record(event: ObservationEvent): void {
    try {
      if (this.closed) { this.stats.lateEvents++; return; }
      if (event.phase === 'start') {
        const endedAt = event.callId ? this.endedCalls.get(event.callId) : undefined;
        if (this.active.has(event.id) || event.callId && (this.expiredCalls.has(event.callId) || endedAt !== undefined &&
          (event.kind === 'model_call' || this.clock.monotonicMs() - endedAt >= 60_000))) { this.stats.lateEvents++; return; }
        this.active.set(event.id, event);
      } else if (event.phase === 'end') {
        if (!this.active.delete(event.id)) { this.stats.lateEvents++; return; }
        if (event.kind === 'model_call') this.endedCalls.set(event.id, event.atMs);
      } else if (!this.active.has(event.id)) { this.stats.lateEvents++; return; }
      this.stats.activeSpans = this.active.size;
      this.options.sink.emit(whitelistObservation(event.kind === 'run' || event.kind === 'room' ? { ...event, wallTimeMs: this.clock.wallTimeMs() } : event));
    } catch { this.stats.callbackErrors++; }
  }
  adapter(ref: ObservationRef): DecideObservationPort {
    return { clock: this.clock, callId: ref.callId!, emit: (event: AdapterObservationEvent) => this.record({ ...ref, ...event } as ObservationEvent) };
  }
  measure<T>(operation: 'store_load' | 'store_save' | 'audit_read' | 'audit_append', rec: Pick<RoomReadRecord, 'id'> | undefined, work: () => T): T {
    const span = this.begin('local_span', rec ? this.ref(rec) : this.run.ref, { operation });
    try { const result = work(); span.finish('success', { persistenceMs: measured(span.elapsed()) }); return result; }
    catch (error) { span.finish('local_error', { persistenceMs: measured(span.elapsed()) }); throw error; }
  }
  private expire(): void {
    const now = this.clock.monotonicMs();
    for (const [id, endedAt] of this.endedCalls) if (now - endedAt >= 60_000) {
      for (const event of [...this.active.values()]) if (event.callId === id) this.record({ ...event, phase: 'end', atMs: now, outcome: 'incomplete', durationMs: measured(now - event.atMs) });
      this.endedCalls.delete(id);
      this.expiredCalls.add(id);
    }
  }
  finish(): void {
    if (this.closed) return;
    clearInterval(this.expiry);
    for (const span of this.rooms.values()) span.finish('success', { roomWallMs: measured(span.elapsed()) });
    this.run.finish('success', { runWallMs: measured(this.run.elapsed()) });
    const now = this.clock.monotonicMs();
    for (const event of [...this.active.values()]) this.record({ ...event, phase: 'end', atMs: now, outcome: 'incomplete', durationMs: measured(now - event.atMs) });
    this.closed = true;
    this.endedCalls.clear();
    this.expiredCalls.clear();
    this.decisions.clear();
  }
}
