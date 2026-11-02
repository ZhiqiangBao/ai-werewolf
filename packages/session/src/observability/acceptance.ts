import type { ObservationEvent, Measurement } from '@werewolf/protocol';
import type { SyntheticTruth } from './synthetic-types';

export interface BaselineEvidence {
  manifest: {
    completed: boolean; scenario: string; protocol: string; seed: string; repetition: number; warmup: boolean; runId?: string;
    roomCount: number; workloadSha256: string; sourceRevision: string; sourceRevisionEnd?: string;
    sourceSha256?: string; sourceSha256End?: string; sourceChangedDuringRun?: boolean;
    collector: { dropped: number; writeErrors: number; bufferedRecords: number; bufferedBytes: number };
    observability?: { callbackErrors: number; activeSpans: number } | null;
    collectorRuntime?: { callbackErrors: number; activeSpans: number } | null;
  };
  observations: ObservationEvent[];
  truth: (SyntheticTruth & { runId?: string })[];
}

export interface BaselineAcceptanceOptions {
  expectedSourceSha256?: string;
  expectedSourceRevision?: string;
}

const scenarios = ['S01', 'S02', 'S03'] as const;
const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const;
const expectedKeys = scenarios.flatMap((scenario) => protocols.map((protocol) => `${scenario}/${protocol}`));
const metrics = ['headersMs', 'firstBodyByteMs', 'firstStreamContentMs', 'bodyConsumeMs'] as const;
const runPattern = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const attemptPattern = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:call:\d{1,20}:\d{1,20}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const revisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const kinds = new Set(['run', 'room', 'wave', 'work', 'action_segment', 'model_call', 'engine_action', 'adapter_execution', 'http_request', 'http_attempt', 'backoff', 'local_span']);
const outcomes = new Set(['success', 'invalid_tool', 'timeout', 'cancelled', 'http_error', 'network_error', 'parse_error', 'local_error', 'stale', 'incomplete', 'await_rejected', 'empty', 'accepted', 'rejected', 'fallback', 'skipped']);
const missingReasons = new Set(['not_observable', 'not_applicable', 'not_emitted', 'cancelled_before_point', 'failed_before_point', 'incomplete', 'legacy', 'collector_dropped']);
const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validCount = (value: unknown): value is number => validNumber(value) && Number.isInteger(value);
const value = (measurement: Measurement | undefined) => measurement?.valueMs;
function validMeasurement(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const item = input as { valueMs?: unknown; source?: unknown; reason?: unknown };
  return validNumber(item.valueMs) ? typeof item.source === 'string' && ['client', 'provider_reported', 'synthetic'].includes(item.source)
    : item.valueMs === null && typeof item.reason === 'string' && missingReasons.has(item.reason);
}

const quantile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
};

/** 检查未知扩展字段中的数值，避免 NaN、Infinity 或负值落入误差／噪声判定。 */
function invalidNumberCount(input: unknown): number {
  if (typeof input === 'number') return validNumber(input) ? 0 : 1;
  if (Array.isArray(input)) return input.reduce((sum, item) => sum + invalidNumberCount(item), 0);
  if (!input || typeof input !== 'object') return 0;
  return Object.values(input).reduce<number>((sum, item) => sum + invalidNumberCount(item), 0);
}

function attemptIdValid(id: unknown, runId: string): id is string {
  if (typeof id !== 'string' || !id.startsWith(`${runId}:call:`)) return false;
  return /^\d{1,20}:\d{1,20}$/.test(id.slice(`${runId}:call:`.length));
}

interface Integrity {
  truthRaw: number; truthUnique: number; httpStartsRaw: number; httpStartsUnique: number; httpEndsRaw: number; httpEndsUnique: number;
  duplicateTruth: number; duplicateHttpStarts: number; duplicateHttpEnds: number;
  truthWithoutStart: string[]; truthWithoutEnd: string[]; httpStartsWithoutTruth: string[]; httpEndsWithoutTruth: string[];
  crossRunTruth: number; crossRunObservations: number; invalidAttemptIds: number; invalidRoots: number;
  invalidNumericValues: number; invalidRequiredFields: number; invalidTruthIds: number; invalidHttpStartIds: number; invalidHttpEndIds: number; manifestRunIdMismatch: number;
}

interface Inspection {
  runId: string | null;
  integrity: Integrity;
  truthIds: Set<string>;
  starts: Set<string>;
  ends: Set<string>;
  orphanEnds: number;
  duplicateStarts: number;
  duplicateEnds: number;
  unfinished: number;
  incompleteTerminals: number;
  matched: number;
  errors: Record<string, { absolute: number[]; medianRatios: number[]; p95Ratios: number[]; missing: number }>;
}

const difference = (left: Set<string>, right: Set<string>) => [...left].filter((id) => !right.has(id)).sort();
const safeAttempt = (id: string) => attemptPattern.test(id) ? id : '<invalid-attempt-id>';
const safeComposite = (id: string) => {
  const slash = id.indexOf('/'), run = id.slice(0, slash), attempt = id.slice(slash + 1);
  return slash > 0 && runPattern.test(run) && attemptPattern.test(attempt) ? `${run}/${attempt}` : '<invalid-run-or-attempt-id>';
};
const counts = (values: readonly string[]) => {
  const unique = new Set(values);
  return { unique, duplicates: values.length - unique.size };
};

function inspect(row: BaselineEvidence): Inspection {
  const observations = Array.isArray(row.observations) ? row.observations : [];
  const truths = Array.isArray(row.truth) ? row.truth : [];
  const rootStarts = observations.filter((event) => event?.kind === 'run' && event.phase === 'start');
  const rootEnds = observations.filter((event) => event?.kind === 'run' && event.phase === 'end');
  const root = rootStarts.length === 1 ? rootStarts[0] : undefined;
  const runId = typeof root?.runId === 'string' && runPattern.test(root.runId) ? root.runId : null;
  const manifestRunIdMismatch = Object.prototype.hasOwnProperty.call(row.manifest, 'runId') && row.manifest.runId !== runId ? 1 : 0;
  const invalidRoots = runId && rootEnds.length === 1 && rootEnds[0].runId === runId && rootEnds[0].id === root?.id &&
    typeof root.id === 'string' && root.id.startsWith(`${runId}:run:`) && /^\d+$/.test(root.id.slice(`${runId}:run:`.length)) && rootEnds[0].outcome === 'success' ? 0 : 1;
  let crossRunTruth = 0, crossRunObservations = 0, invalidAttemptIds = 0, invalidRequiredFields = 0;
  const invalidNumericValues = invalidNumberCount(row.manifest) + invalidNumberCount(observations) + invalidNumberCount(truths);
  const rawStarts = observations.filter((event) => event?.kind === 'http_attempt' && event.phase === 'start');
  const rawEnds = observations.filter((event) => event?.kind === 'http_attempt' && event.phase === 'end');
  const startRows = rawStarts.map((event) => event.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const endRows = rawEnds.map((event) => event.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const truthRows: string[] = [];
  const truthMap = new Map<string, SyntheticTruth>();
  for (const entry of truths) {
    const id = entry?.attemptId;
    if (typeof id === 'string' && id.length) truthRows.push(id); else invalidRequiredFields++;
    const foreignId = !runId || typeof id !== 'string' || !id.startsWith(`${runId}:`);
    const foreignRun = entry && Object.prototype.hasOwnProperty.call(entry, 'runId') && entry.runId !== runId;
    if (foreignId || foreignRun) crossRunTruth++;
    if (runId && typeof id === 'string' && id.startsWith(`${runId}:`) && !attemptIdValid(id, runId)) invalidAttemptIds++;
    if (!entry || entry.source !== 'synthetic' || entry.finished !== true || !entry.planned ||
      !validNumber(entry.queueMs) || !validNumber(entry.headersMs) || !validNumber(entry.firstBodyByteMs) ||
      !validNumber(entry.firstStreamContentMs) || !validNumber(entry.bodyConsumeMs) || !validNumber(entry.elapsedMs) ||
      !validNumber(entry.planned.headersMs) || !validNumber(entry.planned.firstContentMs) || !validCount(entry.planned.chunks) ||
      !validNumber(entry.planned.chunkIntervalMs) || !validCount(entry.planned.status) || entry.planned.status < 200 || entry.planned.status >= 300 ||
      !(entry.planned.capacity === null || validCount(entry.planned.capacity))) invalidRequiredFields++;
    if (typeof id === 'string' && !truthMap.has(id)) truthMap.set(id, entry);
  }
  const allStarts = new Set<string>(), allEnds = new Set<string>();
  let orphanEnds = 0, duplicateStarts = 0, duplicateEnds = 0, incompleteTerminals = 0, matched = 0;
  const errors: Inspection['errors'] = {};
  for (const event of observations) {
    if (!event || event.schemaVersion !== 1 || typeof event.kind !== 'string' || !kinds.has(event.kind) || !['start', 'end', 'point'].includes(event.phase) ||
      typeof event.id !== 'string' || !validNumber(event.atMs)) { invalidRequiredFields++; continue; }
    if (event.phase === 'end' && (typeof event.outcome !== 'string' || !outcomes.has(event.outcome))) invalidRequiredFields++;
    if (event.durationMs !== undefined && !validMeasurement(event.durationMs)) invalidRequiredFields++;
    if (event.metrics !== undefined && (!event.metrics || typeof event.metrics !== 'object' ||
      Object.values(event.metrics).some((measurement) => !validMeasurement(measurement)))) invalidRequiredFields++;
    let foreign = !runId || event.runId !== runId || !event.id.startsWith(`${runId}:`);
    if (runId) for (const ref of ['parentId', 'waveId', 'workId', 'actionId', 'actionSegmentId', 'callId', 'requestId', 'httpAttemptId', 'causedByCallId'] as const) {
      if (event[ref] !== undefined && (typeof event[ref] !== 'string' || !event[ref]!.startsWith(`${runId}:`))) foreign = true;
    }
    const usageSource = event.usage?.sourceHttpAttemptId;
    if (usageSource !== undefined && (!runId || !attemptIdValid(usageSource, runId))) { foreign = true; invalidAttemptIds++; }
    if (foreign) crossRunObservations++;
    const key = `${event.kind}/${event.id}`;
    if (event.phase === 'start') {
      if (allStarts.has(key)) duplicateStarts++;
      allStarts.add(key);
    } else if (event.phase === 'end') {
      if (allEnds.has(key)) duplicateEnds++;
      if (!allStarts.has(key)) orphanEnds++;
      allEnds.add(key);
      if (event.outcome === 'incomplete') incompleteTerminals++;
    }
    if (event.kind !== 'http_attempt' || event.phase === 'point') continue;
    if (!runId || !attemptIdValid(event.id, runId) || event.httpAttemptId !== event.id || !validCount(event.attemptIndex) ||
      typeof event.callId !== 'string' || !event.id.startsWith(`${event.callId}:`) ||
      typeof event.requestId !== 'string' || event.parentId !== event.requestId || !event.requestId.startsWith(`${event.callId}:`)) invalidAttemptIds++;
    if (event.phase !== 'end') continue;
    if (event.outcome !== 'success' || !validCount(event.status) || event.status < 200 || event.status >= 300) invalidRequiredFields++;
    const truth = truthMap.get(event.id);
    if (!truth) continue;
    if (event.status !== truth.planned?.status) invalidRequiredFields++;
    matched++;
    for (const metric of metrics) {
      const expected = metric === 'headersMs' ? validNumber(truth.headersMs) && validNumber(truth.queueMs)
        ? truth.headersMs + truth.queueMs : null : truth[metric];
      const actual = value(event.metrics?.[metric]);
      const data = errors[metric] ??= { absolute: [], medianRatios: [], p95Ratios: [], missing: 0 };
      if (!validNumber(expected) || !validNumber(actual)) { data.missing++; invalidRequiredFields++; continue; }
      const absolute = Math.abs(actual - expected);
      data.absolute.push(absolute); data.medianRatios.push(absolute / Math.max(20, expected * 0.1)); data.p95Ratios.push(absolute / Math.max(50, expected * 0.2));
    }
  }
  if (!Array.isArray(row.observations) || !Array.isArray(row.truth)) invalidRequiredFields++;
  const started = counts(startRows), ended = counts(endRows), truth = counts(truthRows);
  const integrity: Integrity = { truthRaw: truths.length, truthUnique: truth.unique.size, httpStartsRaw: rawStarts.length,
    httpStartsUnique: started.unique.size, httpEndsRaw: rawEnds.length, httpEndsUnique: ended.unique.size,
    duplicateTruth: truth.duplicates, duplicateHttpStarts: started.duplicates, duplicateHttpEnds: ended.duplicates,
    truthWithoutStart: difference(truth.unique, started.unique).map(safeAttempt), truthWithoutEnd: difference(truth.unique, ended.unique).map(safeAttempt),
    httpStartsWithoutTruth: difference(started.unique, truth.unique).map(safeAttempt), httpEndsWithoutTruth: difference(ended.unique, truth.unique).map(safeAttempt),
    crossRunTruth, crossRunObservations, invalidAttemptIds, invalidRoots, invalidNumericValues, invalidRequiredFields,
    invalidTruthIds: truths.length - truthRows.length, invalidHttpStartIds: rawStarts.length - startRows.length, invalidHttpEndIds: rawEnds.length - endRows.length, manifestRunIdMismatch };
  return { runId, integrity, truthIds: truth.unique, starts: started.unique, ends: ended.unique,
    orphanEnds, duplicateStarts, duplicateEnds, unfinished: difference(allStarts, allEnds).length, incompleteTerminals, matched, errors };
}

function integrityInvalid(data: Integrity): boolean {
  return data.duplicateTruth > 0 || data.duplicateHttpStarts > 0 || data.duplicateHttpEnds > 0 ||
    data.truthWithoutStart.length > 0 || data.truthWithoutEnd.length > 0 || data.httpStartsWithoutTruth.length > 0 || data.httpEndsWithoutTruth.length > 0 ||
    data.crossRunTruth > 0 || data.crossRunObservations > 0 || data.invalidAttemptIds > 0 || data.invalidRoots > 0 ||
    data.invalidNumericValues > 0 || data.invalidRequiredFields > 0 || data.manifestRunIdMismatch > 0 || data.truthRaw === 0 || data.httpStartsRaw === 0 || data.httpEndsRaw === 0;
}

function combineIntegrity(samples: readonly Inspection[]): Integrity {
  const truth = new Set<string>(), starts = new Set<string>(), ends = new Set<string>();
  const totals = { truthRaw: 0, httpStartsRaw: 0, httpEndsRaw: 0, crossRunTruth: 0, crossRunObservations: 0,
    invalidAttemptIds: 0, invalidRoots: 0, invalidNumericValues: 0, invalidRequiredFields: 0,
    invalidTruthIds: 0, invalidHttpStartIds: 0, invalidHttpEndIds: 0, manifestRunIdMismatch: 0 };
  for (const [index, sample] of samples.entries()) {
    const prefix = sample.runId ?? `missing-run-${index}`;
    for (const id of sample.truthIds) truth.add(`${prefix}/${id}`);
    for (const id of sample.starts) starts.add(`${prefix}/${id}`);
    for (const id of sample.ends) ends.add(`${prefix}/${id}`);
    for (const field of ['truthRaw', 'httpStartsRaw', 'httpEndsRaw', 'crossRunTruth', 'crossRunObservations',
      'invalidAttemptIds', 'invalidRoots', 'invalidNumericValues', 'invalidRequiredFields', 'invalidTruthIds', 'invalidHttpStartIds', 'invalidHttpEndIds', 'manifestRunIdMismatch'] as const) totals[field] += sample.integrity[field];
  }
  return { ...totals, truthUnique: truth.size, httpStartsUnique: starts.size, httpEndsUnique: ends.size,
    duplicateTruth: totals.truthRaw - totals.invalidTruthIds - truth.size,
    duplicateHttpStarts: totals.httpStartsRaw - totals.invalidHttpStartIds - starts.size,
    duplicateHttpEnds: totals.httpEndsRaw - totals.invalidHttpEndIds - ends.size,
    truthWithoutStart: difference(truth, starts).map(safeComposite), truthWithoutEnd: difference(truth, ends).map(safeComposite),
    httpStartsWithoutTruth: difference(starts, truth).map(safeComposite), httpEndsWithoutTruth: difference(ends, truth).map(safeComposite) };
}

type InspectedRow = { manifest: BaselineEvidence['manifest']; sample: Inspection };

/** 聚合只接受已检查结果，避免保留各运行的完整 observations/truth。 */
function evaluateInspections(rows: readonly InspectedRow[], samples: number, invalidInputs: number, requireFullMatrix: boolean, options: BaselineAcceptanceOptions) {
  const inspected = rows.map(({ sample }) => sample);
  const roots = new Map<string, number>();
  for (const sample of inspected) if (sample.runId) roots.set(sample.runId, (roots.get(sample.runId) ?? 0) + 1);
  const duplicateRunIds = [...roots].filter(([, count]) => count > 1).map(([id]) => id).sort();
  const allHashes = new Set<string>(), allRevisions = new Set<string>();
  const invalidOptions = (options.expectedSourceSha256 !== undefined && (typeof options.expectedSourceSha256 !== 'string' || !sha256Pattern.test(options.expectedSourceSha256))) ||
    (options.expectedSourceRevision !== undefined && (typeof options.expectedSourceRevision !== 'string' || !revisionPattern.test(options.expectedSourceRevision)));
  const expectedHash = typeof options.expectedSourceSha256 === 'string' ? options.expectedSourceSha256.toLowerCase() : undefined;
  const expectedRevision = typeof options.expectedSourceRevision === 'string' ? options.expectedSourceRevision.toLowerCase() : undefined;
  const groups = new Map<string, InspectedRow[]>();
  let unsupportedSamples = 0;
  for (const { manifest, sample } of rows) {
    const key = `${manifest.scenario}/${manifest.protocol}`;
    if (!expectedKeys.includes(key)) { unsupportedSamples++; continue; }
    const group = groups.get(key) ?? []; group.push({ manifest, sample }); groups.set(key, group);
    if (typeof manifest.sourceSha256 === 'string' && sha256Pattern.test(manifest.sourceSha256)) allHashes.add(manifest.sourceSha256.toLowerCase());
    if (typeof manifest.sourceRevision === 'string' && revisionPattern.test(manifest.sourceRevision)) allRevisions.add(manifest.sourceRevision.toLowerCase());
  }
  const results = (requireFullMatrix ? expectedKeys : [...groups.keys()]).map((key) => {
    const rows = groups.get(key) ?? [], measured = rows.filter(({ manifest }) => manifest.warmup === false), warmups = rows.filter(({ manifest }) => manifest.warmup === true);
    const bySeed = new Map<string, number>(), workloads = new Map<string, Set<string>>(), repetitions = new Map<string, Set<number>>();
    const sourceHashes = new Set<string>();
    const errors: Inspection['errors'] = {};
    let invalid = false, incomplete = false, orphanEnds = 0, duplicateStarts = 0, duplicateEnds = 0, attempts = 0, matched = 0;
    const runReports: { runId: string | null; warmup: boolean | null; integrity: Integrity }[] = [];
    for (const { manifest, sample } of rows) {
      const data = sample.integrity;
      runReports.push({ runId: sample.runId, warmup: typeof manifest.warmup === 'boolean' ? manifest.warmup : null, integrity: data });
      orphanEnds += sample.orphanEnds; duplicateStarts += sample.duplicateStarts; duplicateEnds += sample.duplicateEnds;
      const collector = manifest.collector, runtime = manifest.collectorRuntime ?? manifest.observability;
      const validCollector = !!collector && [collector.dropped, collector.writeErrors, collector.bufferedRecords, collector.bufferedBytes].every(validCount) &&
        !!runtime && [runtime.callbackErrors, runtime.activeSpans].every(validCount);
      const sourceValid = typeof manifest.sourceSha256 === 'string' && sha256Pattern.test(manifest.sourceSha256) &&
        typeof manifest.sourceSha256End === 'string' && sha256Pattern.test(manifest.sourceSha256End) && manifest.sourceSha256.toLowerCase() === manifest.sourceSha256End.toLowerCase() &&
        typeof manifest.sourceRevision === 'string' && revisionPattern.test(manifest.sourceRevision) &&
        typeof manifest.sourceRevisionEnd === 'string' && revisionPattern.test(manifest.sourceRevisionEnd) && manifest.sourceRevision.toLowerCase() === manifest.sourceRevisionEnd.toLowerCase() &&
        manifest.sourceChangedDuringRun === false &&
        (options.expectedSourceSha256 === undefined || manifest.sourceSha256.toLowerCase() === expectedHash) &&
        (options.expectedSourceRevision === undefined || manifest.sourceRevision.toLowerCase() === expectedRevision);
      if (typeof manifest.sourceSha256 === 'string' && sha256Pattern.test(manifest.sourceSha256)) sourceHashes.add(manifest.sourceSha256.toLowerCase());
      invalid ||= !sourceValid || !validCollector || manifest.completed !== true || typeof manifest.warmup !== 'boolean' ||
        !validCount(manifest.repetition) || typeof manifest.workloadSha256 !== 'string' || !sha256Pattern.test(manifest.workloadSha256) ||
        manifest.roomCount !== (manifest.scenario === 'S01' ? 1 : 2) ||
        !['obs-standard12-001', 'obs-standard12-002', 'obs-standard12-003'].includes(manifest.seed) ||
        (manifest.warmup && manifest.repetition !== 0) ||
        (validCollector && (collector.dropped !== 0 || collector.writeErrors !== 0 || collector.bufferedRecords !== 0 || collector.bufferedBytes !== 0 || runtime!.callbackErrors !== 0 || runtime!.activeSpans !== 0)) ||
        integrityInvalid(data) || sample.orphanEnds > 0 || sample.duplicateStarts > 0 || sample.duplicateEnds > 0 ||
        sample.incompleteTerminals > 0 || (!!sample.runId && duplicateRunIds.includes(sample.runId));
      incomplete ||= sample.unfinished > 0;
      if (manifest.warmup) continue;
      bySeed.set(manifest.seed, (bySeed.get(manifest.seed) ?? 0) + 1);
      const repeated = repetitions.get(manifest.seed) ?? new Set<number>(); repeated.add(manifest.repetition); repetitions.set(manifest.seed, repeated);
      const hashes = workloads.get(manifest.seed) ?? new Set<string>(); hashes.add(manifest.workloadSha256); workloads.set(manifest.seed, hashes);
      attempts += data.httpEndsRaw; matched += sample.matched;
      for (const [name, source] of Object.entries(sample.errors)) {
        const target = errors[name] ??= { absolute: [], medianRatios: [], p95Ratios: [], missing: 0 };
        target.absolute.push(...source.absolute); target.medianRatios.push(...source.medianRatios); target.p95Ratios.push(...source.p95Ratios); target.missing += source.missing;
      }
    }
    invalid ||= sourceHashes.size > 1 || [...workloads.values()].some((values) => values.size !== 1);
    const covered = measured.length === 9 && warmups.length >= 1 && ['001', '002', '003'].every((suffix) => {
      const seed = `obs-standard12-${suffix}`;
      return bySeed.get(seed) === 3 && [1, 2, 3].every((repetition) => repetitions.get(seed)?.has(repetition));
    });
    const numericMetrics = Object.fromEntries(Object.entries(errors).map(([name, data]) => [name, {
      samples: data.absolute.length, missing: data.missing, medianAbsoluteErrorMs: quantile(data.absolute, .5), p95AbsoluteErrorMs: quantile(data.absolute, .95),
      medianLimitRatio: quantile(data.medianRatios, .5), p95LimitRatio: quantile(data.p95Ratios, .95),
      withinThresholds: data.absolute.length > 0 && data.missing === 0 && (quantile(data.medianRatios, .5) ?? Infinity) <= 1 && (quantile(data.p95Ratios, .95) ?? Infinity) <= 1,
    }]));
    const numeric = metrics.every((name) => numericMetrics[name]?.withinThresholds);
    const integrity = combineIntegrity(rows.map(({ sample }) => sample));
    return { key, formalRuns: measured.length, warmups: warmups.length, covered, attempts, matchedTruth: matched,
      orphanEnds, duplicateStarts, duplicateEnds, sourceHashes: [...sourceHashes], workloadConsistent: [...workloads.values()].every((hashes) => hashes.size === 1),
      integrity, runs: runReports, metrics: numericMetrics,
      status: invalid ? 'invalid' : !covered || incomplete || matched !== attempts ? 'incomplete' : numeric ? 'within_thresholds' : 'inconclusive_noise' };
  });
  const globalInvalid = invalidInputs > 0 || invalidOptions || unsupportedSamples > 0 || duplicateRunIds.length > 0 || allHashes.size > 1 || allRevisions.size > 1;
  return { reportKind: 'synthetic_accuracy_acceptance', samples, invalidInputs, duplicateRunIds, unsupportedSamples, invalidOptions, integrity: combineIntegrity(inspected),
    sourceHashes: [...allHashes], sourceRevisions: [...allRevisions],
    status: !globalInvalid && results.length > 0 && results.every((result) => result.status === 'within_thresholds') ? 'within_thresholds' : 'not_passed', results };
}

/** 逐运行加入，finish 时统一执行跨运行核对；不保留原始观测或真值数组。 */
export function createBaselineAcceptance(requireFullMatrix = true, options: BaselineAcceptanceOptions = {}) {
  const rows: InspectedRow[] = [], config = { ...options };
  let samples = 0, invalidInputs = 0;
  return {
    add(row: BaselineEvidence): void {
      samples++;
      if (!row || typeof row !== 'object' || !row.manifest || typeof row.manifest !== 'object') { invalidInputs++; return; }
      const sample = inspect(row), input = row.manifest;
      // 只保留验收必需字段；输入数组和额外 manifest 元数据不进入累加器。
      const manifest = { completed: input.completed, scenario: input.scenario, protocol: input.protocol, seed: input.seed,
        repetition: input.repetition, warmup: input.warmup, roomCount: input.roomCount, workloadSha256: input.workloadSha256,
        sourceRevision: input.sourceRevision, sourceRevisionEnd: input.sourceRevisionEnd, sourceSha256: input.sourceSha256,
        sourceSha256End: input.sourceSha256End, sourceChangedDuringRun: input.sourceChangedDuringRun,
        collector: input.collector ? { dropped: input.collector.dropped, writeErrors: input.collector.writeErrors,
          bufferedRecords: input.collector.bufferedRecords, bufferedBytes: input.collector.bufferedBytes } : input.collector,
        collectorRuntime: input.collectorRuntime ? { callbackErrors: input.collectorRuntime.callbackErrors, activeSpans: input.collectorRuntime.activeSpans } : input.collectorRuntime,
        observability: input.observability ? { callbackErrors: input.observability.callbackErrors, activeSpans: input.observability.activeSpans } : input.observability };
      rows.push({ manifest, sample });
    },
    finish() { return evaluateInspections(rows, samples, invalidInputs, requireFullMatrix, config); },
  };
}

/** 只比较各进程自行测得的时段长度；绝不相减客户端与服务端时间戳。 */
export function evaluateBaselineEvidence(evidence: readonly BaselineEvidence[], requireFullMatrix = true, options: BaselineAcceptanceOptions = {}) {
  const acceptance = createBaselineAcceptance(requireFullMatrix, options);
  for (const row of evidence) acceptance.add(row);
  return acceptance.finish();
}
