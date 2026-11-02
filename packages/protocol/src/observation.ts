import type { ApiProtocol } from './index';

export interface ObservationClock {
  monotonicMs(): number;
  wallTimeMs(): number;
}

export type MissingReason = 'not_observable' | 'not_applicable' | 'not_emitted' |
  'cancelled_before_point' | 'failed_before_point' | 'incomplete' | 'legacy' | 'collector_dropped';
export type Measurement = { valueMs: number; source: 'client' | 'provider_reported' | 'synthetic' } |
  { valueMs: null; reason: MissingReason };

export interface ObservationRef {
  schemaVersion: 1;
  runId: string;
  roomRef: string;
  seatRef?: string;
  waveId?: string;
  workId?: string;
  decisionRef?: string;
  actionId?: string;
  actionSegmentId?: string;
  callId?: string;
  requestId?: string;
  httpAttemptId?: string;
}

export type ObservationOutcome = 'success' | 'invalid_tool' | 'timeout' | 'cancelled' |
  'http_error' | 'network_error' | 'parse_error' | 'local_error' | 'stale' | 'incomplete' |
  'await_rejected' | 'empty' | 'accepted' | 'rejected' | 'fallback' | 'skipped';
export type CancelReason = 'pause' | 'end' | 'decision_changed' | 'dispose' | 'unknown';
export type VariantReason = 'initial' | 'stream_unsupported' | 'tool_choice_unsupported' | 'json_format_unsupported';
export type FirstContentKind = 'reply' | 'thinking' | 'tool_name' | 'tool_arguments';
export type BodyEndKind = 'protocol_end' | 'eof' | 'error' | 'cancelled' | 'discarded';

export interface ObservationMetrics {
  gateWaitMs?: Measurement;
  pacingWaitMs?: Measurement;
  plannedWaitMs?: Measurement;
  wavePrepareMs?: Measurement;
  localPreDispatchMs?: Measurement;
  actionSegmentMs?: Measurement;
  markAskedMs?: Measurement;
  modelCallMs?: Measurement;
  adapterExecutionMs?: Measurement;
  requestEncodeMs?: Measurement;
  serializeMs?: Measurement;
  requestSendMs?: Measurement;
  headersMs?: Measurement;
  firstBodyByteMs?: Measurement;
  firstStreamContentMs?: Measurement;
  legacyFirstDeltaMs?: Measurement;
  parsedOutputAvailableMs?: Measurement;
  bodyConsumeMs?: Measurement;
  parseMs?: Measurement;
  httpAttemptMs?: Measurement;
  backoffMs?: Measurement;
  waveAwaitMs?: Measurement;
  memberTailWaitMs?: Measurement;
  waveWallMs?: Measurement;
  persistenceMs?: Measurement;
  providerQueueMs?: Measurement;
  roomWallMs?: Measurement;
  runWallMs?: Measurement;
}

export interface ObservedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  completeness: 'complete' | 'partial' | 'unknown';
  sourceHttpAttemptId?: string;
}

export interface ObservationFeatures {
  stream: boolean;
  toolChoice: 'auto' | 'required' | 'none';
  responseFormat: boolean;
  compatibilityMemory?: 'cold' | 'warm';
}

export interface ObservationFields {
  providerId?: string;
  modelKey?: string;
  apiProtocol?: ApiProtocol;
  purpose?: 'listen' | 'action';
  correctionAttempt?: number;
  cancelReason?: CancelReason;
  causedByCallId?: string;
  actionKind?: 'normal' | 'interrupt' | 'automatic';
  variantIndex?: number;
  variantReason?: VariantReason;
  attemptIndex?: number;
  status?: number;
  retryReason?: 'network' | '429' | '5xx';
  operation?: 'store_load' | 'store_save' | 'audit_read' | 'audit_append' |
    'request_encode' | 'serialize' | 'parse' | 'gate_wait' | 'pacing_wait';
  firstContentKind?: FirstContentKind;
  bodyEndKind?: BodyEndKind;
  features?: ObservationFeatures;
  metrics?: ObservationMetrics;
  usage?: ObservedUsage;
  members?: number;
  httpAttemptsStarted?: number;
  httpAttemptsFinished?: number;
  compatibilityFallbacks?: number;
  providerQueueContract?: 'synthetic_v1';
}

interface SpanEvent extends ObservationFields {
  id: string;
  parentId?: string;
  requestId?: string;
  httpAttemptId?: string;
  phase: 'start' | 'end' | 'point';
  atMs: number;
  durationMs?: Measurement;
  outcome?: ObservationOutcome;
}

/** 固定字段联合；端口不接收 URL、正文、错误字符串或任意元数据。 */
export type AdapterObservationEvent = SpanEvent & (
  { kind: 'adapter_execution' } | { kind: 'http_request' } | { kind: 'http_attempt' } |
  { kind: 'backoff' } | { kind: 'local_span' }
);

export type ObservationEvent = ObservationRef & (AdapterObservationEvent | (SpanEvent & (
  { kind: 'run' } | { kind: 'room' } | { kind: 'wave' } | { kind: 'work' } |
  { kind: 'action_segment' } | { kind: 'model_call' } | { kind: 'engine_action' }
)));

export interface ObservationSink { emit(event: ObservationEvent): void }

export interface DecideObservationPort {
  clock: ObservationClock;
  callId: string;
  emit(event: AdapterObservationEvent): void;
}

export interface ObservabilityOptions {
  sink: ObservationSink;
  clock?: ObservationClock;
  /** 本机稳定映射不进入报告；缺省使用 data/diagnostics/identity-map.json。 */
  mappingPath?: string;
  /** 同源不同接入路由只能通过显式的非敏感分组键区分。 */
  providerAlias?: (normalizedOrigin: string) => string | undefined;
}
