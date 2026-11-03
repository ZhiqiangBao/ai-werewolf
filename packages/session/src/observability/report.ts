import type { AuditEntry, Measurement, ObservationEvent, ObservationMetrics, ObservedUsage } from '@werewolf/protocol';
import type { SyntheticTruth } from './synthetic-types';

type Kind = ObservationEvent['kind'];
type Outcome = NonNullable<ObservationEvent['outcome']>;
interface Span {
  kind: Kind;
  id: string;
  runId: string;
  started: boolean;
  finished: boolean;
  terminalOutcome?: Outcome;
  data: ObservationEvent;
  metrics: ObservationMetrics;
  usage?: ObservedUsage;
}
export interface Distribution {
  count: number;
  missing: number;
  missingReasons: Record<string, number>;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
  smallSample: boolean;
}

export function distribution(values: readonly (Measurement | undefined)[], missingReason = 'not_emitted'): Distribution {
  const numbers: number[] = [];
  const missingReasons: Record<string, number> = {};
  for (const value of values) {
    if (value && value.valueMs !== null && Number.isFinite(value.valueMs)) numbers.push(value.valueMs);
    else {
      const reason = value && value.valueMs === null ? value.reason : missingReason;
      missingReasons[reason] = (missingReasons[reason] ?? 0) + 1;
    }
  }
  numbers.sort((a, b) => a - b);
  const rank = (p: number) => numbers.length ? numbers[Math.ceil(p * numbers.length) - 1] : null;
  return { count: numbers.length, missing: values.length - numbers.length, missingReasons,
    p50: rank(0.5), p90: rank(0.9), p95: rank(0.95), max: numbers.at(-1) ?? null, smallSample: numbers.length < 20 };
}

const metricsByKind: Partial<Record<Kind, readonly (keyof ObservationMetrics)[]>> = {
  run: ['runWallMs'], room: ['roomWallMs'],
  wave: ['wavePrepareMs', 'waveAwaitMs', 'waveWallMs'],
  action_segment: ['actionSegmentMs', 'markAskedMs'],
  model_call: ['modelCallMs', 'legacyFirstDeltaMs', 'legacyLatencyMs', 'localPreDispatchMs'],
  adapter_execution: ['adapterExecutionMs'],
  http_attempt: ['requestSendMs', 'headersMs', 'firstBodyByteMs', 'firstStreamContentMs', 'parsedOutputAvailableMs', 'bodyConsumeMs', 'parseMs', 'httpAttemptMs', 'providerQueueMs'],
  backoff: ['backoffMs'],
};

function fold(events: readonly ObservationEvent[]): { spans: Span[]; orphanEnds: number; duplicates: number } {
  const map = new Map<string, Span>();
  let duplicates = 0;
  for (const event of events) {
    const key = JSON.stringify([event.runId, event.kind, event.id]);
    let span = map.get(key);
    if (!span) {
      span = { kind: event.kind, id: event.id, runId: event.runId, started: false, finished: false, data: event, metrics: {} };
      map.set(key, span);
    }
    if (event.phase === 'start') { if (span.started) { duplicates++; continue; } span.started = true; }
    if (event.phase === 'end') { if (span.finished) { duplicates++; continue; } span.finished = true; span.terminalOutcome = event.outcome; }
    span.data = { ...span.data, ...event };
    Object.assign(span.metrics, event.metrics);
    if (event.usage) span.usage = event.usage;
    if (event.phase === 'end' && event.outcome !== 'incomplete' && event.durationMs) {
      const primary: Partial<Record<Kind, keyof ObservationMetrics>> = { run: 'runWallMs', room: 'roomWallMs', wave: 'waveWallMs', action_segment: 'actionSegmentMs', model_call: 'modelCallMs', adapter_execution: 'adapterExecutionMs', http_attempt: 'httpAttemptMs', backoff: 'backoffMs' };
      const name = primary[event.kind];
      if (name && !span.metrics[name]) span.metrics[name] = event.durationMs;
    }
  }
  const spans = [...map.values()];
  return { spans, orphanEnds: spans.filter((x) => x.finished && !x.started).length, duplicates };
}

function counts(spans: readonly Span[]) {
  const started = spans.filter((s) => s.started).length;
  const completed = spans.filter((s) => s.started && s.finished && s.terminalOutcome !== 'incomplete');
  const outcomes: Record<string, number> = {};
  for (const span of completed) {
    const outcome: Outcome | 'unknown' = span.terminalOutcome ?? 'unknown';
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  const http = spans.filter((span) => span.kind === 'http_attempt' && span.started);
  const noContent: Record<string, number> = {};
  for (const span of http) {
    const value = span.metrics.firstStreamContentMs;
    if (value && value.valueMs !== null) continue;
    const reason = value && value.valueMs === null ? value.reason : !span.finished || span.terminalOutcome === 'incomplete' ? 'incomplete' : 'not_emitted';
    noContent[reason] = (noContent[reason] ?? 0) + 1;
  }
  return { started, finished: completed.length, incomplete: started - completed.length, outcomes,
    successRate: completed.length ? (outcomes.success ?? 0) / completed.length : null,
    ...(http.length ? { noFirstContent: { count: Object.values(noContent).reduce((a, b) => a + b, 0), reasons: noContent } } : {}) };
}

function featureBreakdown(spans: readonly Span[]) {
  const requests = spans.filter((span) => span.kind === 'http_request' && span.started);
  const buckets = new Map<string, { stream: boolean | null; compatibilityMemory: 'cold' | 'warm' | 'unknown'; requests: Span[]; attempts: Span[] }>();
  for (const request of requests) {
    const stream = request.data.features?.stream ?? null;
    const compatibilityMemory = request.data.features?.compatibilityMemory ?? 'unknown';
    const key = JSON.stringify([stream, compatibilityMemory]);
    const bucket = buckets.get(key) ?? { stream, compatibilityMemory, requests: [], attempts: [] };
    bucket.requests.push(request);
    bucket.attempts.push(...spans.filter((span) => span.kind === 'http_attempt' && span.runId === request.runId && span.data.requestId === request.id));
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(({ requests: groupRequests, attempts, ...dimensions }) => ({ ...dimensions, requests: counts(groupRequests), httpAttempts: counts(attempts) }));
}

function measurements(spans: readonly Span[]) {
  const byName: Record<string, (Measurement | undefined)[]> = {};
  for (const span of spans.filter((s) => s.started)) {
    const localByOperation: Record<string, readonly (keyof ObservationMetrics)[]> = {
      store_load: ['persistenceMs'], store_save: ['persistenceMs'], audit_read: ['persistenceMs'], audit_append: ['persistenceMs'],
      request_encode: ['requestEncodeMs'], serialize: ['serializeMs'], parse: ['parseMs'], gate_wait: ['gateWaitMs', 'plannedWaitMs'], pacing_wait: ['pacingWaitMs', 'plannedWaitMs'],
    };
    const names = span.kind === 'local_span' ? (localByOperation[span.data.operation ?? ''] ?? (span.metrics.memberTailWaitMs ? ['memberTailWaitMs'] : [])) : (metricsByKind[span.kind] ?? []);
    for (const metric of names) {
      const name = span.kind === 'local_span' && metric === 'parseMs' ? 'adapterParseMs' : metric;
      let value = span.metrics[metric];
      if (metric === 'providerQueueMs' && value?.valueMs !== null && value !== undefined &&
          (value.source !== 'synthetic' || span.data.providerQueueContract !== 'synthetic_v1'))
        value = { valueMs: null, reason: 'not_observable' };
    (byName[name] ??= []).push(value ?? (!span.finished || span.terminalOutcome === 'incomplete' ? { valueMs: null, reason: 'incomplete' } : undefined));
    }
  }
  return Object.fromEntries(Object.entries(byName).map(([key, values]) => [key, distribution(values)]));
}

const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
function usageSummary(spans: readonly Span[]) {
  const sources = new Map<string, ObservedUsage>();
  const callsWithUsage = new Set<string>();
  const attempts = new Map(spans.filter((span) => span.kind === 'http_attempt' && span.started).map((span) => [JSON.stringify([span.runId, span.id]), span]));
  const totals = Object.fromEntries(usageFields.map((key) => [key, { total: null, eligible: attempts.size, known: 0, missing: attempts.size, coverage: null }])) as Record<typeof usageFields[number], { total: number | null; eligible: number; known: number; missing: number; coverage: number | null }>;
  let duplicateSources = 0, unknownSources = 0, unknownSnapshots = 0;
  for (const span of spans) {
    const usage = span.usage;
    if (!usage) continue;
    if (usage.completeness === 'unknown' && usageFields.every((field) => usage[field] === null)) { unknownSnapshots++; continue; }
    const source = usage.sourceHttpAttemptId;
    if (!source) { unknownSources++; continue; }
    const key = JSON.stringify([span.runId, source]);
    const previous = sources.get(key);
    if (previous) duplicateSources++;
    // Snapshots are cumulative; merge field presence, do not add snapshots.
    sources.set(key, previous ? { ...previous, ...usage,
      inputTokens: usage.inputTokens ?? previous.inputTokens, outputTokens: usage.outputTokens ?? previous.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? previous.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens ?? previous.cacheWriteTokens } : usage);
  }
  for (const [key, usage] of sources) {
    const attempt = attempts.get(key);
    if (!attempt) continue;
    if (attempt.data.callId) callsWithUsage.add(JSON.stringify([attempt.runId, attempt.data.callId]));
    for (const field of usageFields) {
      const value = usage[field];
      if (value !== null && Number.isFinite(value)) { totals[field].total = (totals[field].total ?? 0) + value; totals[field].known++; }
    }
  }
  for (const field of usageFields) {
    totals[field].missing = totals[field].eligible - totals[field].known;
    totals[field].coverage = totals[field].eligible ? totals[field].known / totals[field].eligible : null;
  }
  const callCount = spans.filter((s) => s.kind === 'model_call' && s.started).length;
  return { eligibleHttpAttempts: attempts.size, uniqueSources: [...sources.keys()].filter((key) => attempts.has(key)).length,
    orphanSources: [...sources.keys()].filter((key) => !attempts.has(key)).length, duplicateSources, unknownSources, unknownSnapshots, callsWithUsage: callsWithUsage.size,
    callsWithoutUsage: Math.max(0, callCount - callsWithUsage.size), legacyCallsUnknown: spans.filter((span) => span.kind === 'model_call' && span.started && span.runId.startsWith('legacy-')).length, fields: totals };
}

/** Convert only fields whose historical meaning is known; never copy private audit payloads. */
export function legacyAuditObservations(rows: readonly AuditEntry[], roomRef: string, existing: readonly ObservationEvent[] = []): ObservationEvent[] {
  const known = new Set(existing.filter((event) => event.kind === 'model_call').map((event) => JSON.stringify([event.runId, event.id])));
  const result: ObservationEvent[] = [];
  for (const row of rows) {
    if (row.observation?.callId && known.has(JSON.stringify([row.observation.runId, row.observation.callId]))) continue;
    const id = `legacy-${row.id}`;
    const ref = { schemaVersion: 1 as const, runId: `legacy-${roomRef}`, roomRef, callId: id };
    const common = { ...ref, kind: 'model_call' as const, id, providerId: 'unknown', modelKey: 'unknown',
      ...(row.apiProtocol ? { apiProtocol: row.apiProtocol } : {}), ...(row.purpose ? { purpose: row.purpose } : {}) };
    result.push({ ...common, phase: 'start', atMs: row.at });
    const failure = { timeout: 'timeout', cancelled: 'cancelled', http: 'http_error', network: 'network_error', invalid_tool: 'invalid_tool' } as const;
    const outcome = row.ok ? 'success' as const : row.failureKind ? failure[row.failureKind] : undefined;
    result.push({ ...common, phase: 'end', atMs: row.at, ...(outcome ? { outcome } : {}),
      metrics: { modelCallMs: { valueMs: null, reason: 'legacy' },
        legacyLatencyMs: typeof row.latencyMs === 'number' && Number.isFinite(row.latencyMs) && row.latencyMs >= 0
          ? { valueMs: row.latencyMs, source: 'client' } : { valueMs: null, reason: 'legacy' },
        legacyFirstDeltaMs: typeof row.firstDeltaMs === 'number' && Number.isFinite(row.firstDeltaMs)
          ? { valueMs: row.firstDeltaMs, source: 'client' } : { valueMs: null, reason: 'legacy' } } });
  }
  return result;
}

/** Reports only numeric/enumerated diagnostic data, never audit or message content. */
export function buildObservationReport(events: readonly ObservationEvent[], options: { syntheticTruth?: readonly SyntheticTruth[] } = {}) {
  const { spans, orphanEnds, duplicates } = fold(events);
  const truth = new Map((options.syntheticTruth ?? []).filter((item) => item.source === 'synthetic' && item.planned?.capacity === 1 && typeof item.queueMs === 'number' && Number.isFinite(item.queueMs) && item.queueMs >= 0)
    .map((item) => [item.attemptId, item]));
  for (const span of spans) if (span.kind === 'http_attempt') {
    const record = truth.get(span.id);
    if (record && typeof record.queueMs === 'number') {
      span.metrics.providerQueueMs = { valueMs: record.queueMs, source: 'synthetic' };
      span.data = { ...span.data, providerQueueContract: 'synthetic_v1' };
    }
  }
  const calls = spans.filter((s) => s.kind === 'model_call');
  const callsByKey = new Map(calls.map((s) => [JSON.stringify([s.runId, s.id]), s]));
  const groups = new Map<string, { providerId: string; modelKey: string; apiProtocol: string; purpose: string; spans: Span[] }>();
  for (const span of spans) {
    const callId = span.kind === 'model_call' ? span.id : span.data.callId;
    const call = callId ? callsByKey.get(JSON.stringify([span.runId, callId])) : undefined;
    if (!call) continue;
    const dimensions = { providerId: call.data.providerId ?? 'unknown', modelKey: call.data.modelKey ?? 'unknown', apiProtocol: call.data.apiProtocol ?? 'unknown', purpose: call.data.purpose ?? 'unknown' };
    const key = JSON.stringify(Object.values(dimensions));
    const group = groups.get(key) ?? { ...dimensions, spans: [] };
    group.spans.push(span);
    groups.set(key, group);
  }
  const layers = Object.fromEntries([...new Set(spans.map((s) => s.kind))].map((kind) => [kind, counts(spans.filter((s) => s.kind === kind))]));
  const total = (kind: Kind, name: keyof ObservationMetrics) => {
    const values = spans.filter((s) => s.kind === kind && s.started && s.finished && s.terminalOutcome !== 'incomplete')
      .map((s) => s.metrics[name]?.valueMs).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    return values.length ? values.reduce((sum, n) => sum + n, 0) : null;
  };
  return {
    schemaVersion: 1 as const, reportKind: 'observed' as const, layers, duplicates, orphanEnds,
    measurements: measurements(spans), usage: usageSummary(spans),
    successfulMeasurements: measurements(spans.filter((s) => s.terminalOutcome === 'success')),
    unsuccessfulMeasurements: measurements(spans.filter((s) => s.finished && s.terminalOutcome !== 'success')),
    sumModelCallMs: total('model_call', 'modelCallMs'), sumHttpAttemptMs: total('http_attempt', 'httpAttemptMs'),
    groups: [...groups.values()].map(({ spans: members, ...dimensions }) => ({ ...dimensions,
      calls: counts(members.filter((s) => s.kind === 'model_call')),
      httpAttempts: counts(members.filter((s) => s.kind === 'http_attempt')),
      features: featureBreakdown(members), measurements: measurements(members), usage: usageSummary(members),
    })),
  };
}

export function renderObservationReport(summary: ReturnType<typeof buildObservationReport>): string {
  const fmt = (value: number | null | undefined) => value == null ? 'N/A' : Number.isInteger(value) ? String(value) : value.toFixed(2);
  const label = (value: string) => value.replace(/[|\r\n]/g, ' ');
  const rows = ['# 本机观测报告', '', '仅汇总实际输入记录；合成服务数据不代表真实提供方。', '',
    `重复记录：${summary.duplicates}；缺少起点的终态：${summary.orphanEnds}。模型调用累计 ${fmt(summary.sumModelCallMs)} ms，HTTP 尝试累计 ${fmt(summary.sumHttpAttemptMs)} ms；二者可能嵌套且并行，不能相加或作为墙钟时间。`, '',
    '| 接入方 | 模型 | 协议 | 用途 | 开始 | 完成 | 未完成 | 成功率 |', '| --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...summary.groups.map((g) => `| ${label(g.providerId)} | ${label(g.modelKey)} | ${label(g.apiProtocol)} | ${label(g.purpose)} | ${g.calls.started} | ${g.calls.finished} | ${g.calls.incomplete} | ${g.calls.successRate === null ? 'N/A' : `${(100 * g.calls.successRate).toFixed(1)}%`} |`),
    '', '| 层级 | 开始 | 完成 | 未完成 | 各终态数量 |', '| --- | ---: | ---: | ---: | --- |',
    ...Object.entries(summary.layers).map(([kind, count]) => `| ${kind} | ${count.started} | ${count.finished} | ${count.incomplete} | ${Object.entries(count.outcomes).map(([outcome, n]) => `${outcome}: ${n}`).join('，') || 'N/A'} |`),
    '', '| 指标 | 有效 | 缺失 | P50 ms | P90 ms | P95 ms | 最大 ms |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(summary.measurements).map(([name, d]) => `| ${name}${d.smallSample ? '（小样本）' : ''} | ${d.count} | ${d.missing} | ${fmt(d.p50)} | ${fmt(d.p90)} | ${fmt(d.p95)} | ${fmt(d.max)} |`),
    '', '| usage 字段 | 已知总量 | HTTP 来源数 | 已知 | 未知 | 覆盖率 |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(summary.usage.fields).map(([name, value]) => `| ${name} | ${fmt(value.total)} | ${value.eligible} | ${value.known} | ${value.missing} | ${value.coverage === null ? 'N/A' : `${(value.coverage * 100).toFixed(1)}%`} |`),
    '', `有已知 usage 的调用 ${summary.usage.callsWithUsage}，未知 ${summary.usage.callsWithoutUsage}；历史来源不完整的调用 ${summary.usage.legacyCallsUnknown}。缓存读写是输入的分类信息，不再加到输入总量。`,
    '', '缺失原因、无首内容数量、流式与兼容记忆分组及各状态分布见 summary.json。客户端未观测到的提供方队列保持未知；仅显式契约的合成真值可计为 synthetic。', ''];
  return rows.join('\n');
}
