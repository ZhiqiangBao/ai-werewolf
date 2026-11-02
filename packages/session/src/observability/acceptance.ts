import type { ObservationEvent, Measurement } from '@werewolf/protocol';
import type { SyntheticTruth } from './synthetic-types';

export interface BaselineEvidence {
  manifest: {
    completed: boolean; scenario: string; protocol: string; seed: string; repetition: number; warmup: boolean;
    roomCount: number; workloadSha256: string; sourceRevision: string;
    sourceSha256?: string; sourceSha256End?: string; sourceChangedDuringRun?: boolean;
    collector: { dropped: number; writeErrors: number; bufferedRecords: number; bufferedBytes: number };
    observability?: { callbackErrors: number; activeSpans: number };
    collectorRuntime?: { callbackErrors: number; activeSpans: number } | null;
  };
  observations: ObservationEvent[];
  truth: SyntheticTruth[];
}

const quantile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
};
const value = (m: Measurement | undefined) => m?.valueMs;

/** 只比较各进程自行测得的时段长度；绝不相减客户端与服务端时间戳。 */
export function evaluateBaselineEvidence(evidence: readonly BaselineEvidence[], requireFullMatrix = true) {
  const expected = ['S01','S02','S03'].flatMap((scenario) => ['chat_completions','responses','anthropic_messages'].map((protocol) => `${scenario}/${protocol}`));
  const groups = new Map<string, BaselineEvidence[]>();
  for (const row of evidence) {
    const key = `${row.manifest.scenario}/${row.manifest.protocol}`;
    if (expected.includes(key)) { const group = groups.get(key) ?? []; group.push(row); groups.set(key, group); }
  }
  const results = (requireFullMatrix ? expected : [...groups.keys()]).map((key) => {
    const rows = groups.get(key) ?? [], measured = rows.filter((r) => !r.manifest.warmup), warmups = rows.filter((r) => r.manifest.warmup);
    const counts = new Map<string, number>(), workloads = new Map<string, Set<string>>();
    const sourceHashes = new Set<string>(), runIds = new Set<string>(), repetitions = new Map<string, Set<number>>();
    let invalid = false, incomplete = false, orphanEnds = 0, duplicateStarts = 0, duplicateEnds = 0;
    let attempts = 0, matched = 0;
    const errors: Record<string, { absolute: number[]; medianRatios: number[]; p95Ratios: number[]; missing: number }> = {};
    for (const row of measured) {
      counts.set(row.manifest.seed, (counts.get(row.manifest.seed) ?? 0) + 1);
      const repeated = repetitions.get(row.manifest.seed) ?? new Set<number>(); repeated.add(row.manifest.repetition); repetitions.set(row.manifest.seed, repeated);
      if (row.manifest.sourceSha256) sourceHashes.add(row.manifest.sourceSha256); else incomplete = true;
      invalid ||= row.manifest.sourceChangedDuringRun === true || row.manifest.sourceSha256 !== row.manifest.sourceSha256End;
      const runId = row.observations[0]?.runId;
      if (runId && runIds.has(runId)) invalid = true;
      if (runId) runIds.add(runId);
      const hashes = workloads.get(row.manifest.seed) ?? new Set<string>(); hashes.add(row.manifest.workloadSha256); workloads.set(row.manifest.seed, hashes);
      invalid ||= !row.manifest.completed || row.manifest.roomCount > 2 || row.manifest.collector.dropped > 0 || row.manifest.collector.writeErrors > 0 ||
        row.manifest.collector.bufferedRecords !== 0 || row.manifest.collector.bufferedBytes !== 0 ||
        ((row.manifest.collectorRuntime ?? row.manifest.observability)?.callbackErrors ?? 0) !== 0 ||
        ((row.manifest.collectorRuntime ?? row.manifest.observability)?.activeSpans ?? 0) !== 0;
      const starts = new Set<string>(), ends = new Set<string>(), truths = new Map(row.truth.map((r) => [r.attemptId, r]));
      for (const event of row.observations) {
        const id = `${event.runId}/${event.kind}/${event.id}`;
        if (event.phase === 'start') { if (starts.has(id)) duplicateStarts++; starts.add(id); }
        if (event.phase !== 'end') continue;
        if (ends.has(id)) { duplicateEnds++; continue; } ends.add(id);
        if (!starts.has(id)) orphanEnds++;
        if (event.outcome === 'incomplete') incomplete = true;
        if (event.kind !== 'http_attempt') continue;
        attempts++;
        const truth = truths.get(event.id);
        if (!truth) { incomplete = true; continue; }
        matched++;
        const target = truth as SyntheticTruth & { firstBodyByteMs?: number | null; firstStreamContentMs?: number | null; bodyConsumeMs?: number | null };
        for (const metric of ['headersMs','firstBodyByteMs','firstStreamContentMs','bodyConsumeMs'] as const) {
          const expectedMs = metric === 'headersMs' ? truth.headersMs === null || truth.queueMs === null ? null : truth.headersMs + truth.queueMs : target[metric];
          const actual = value(event.metrics?.[metric]);
          const data = errors[metric] ??= { absolute: [], medianRatios: [], p95Ratios: [], missing: 0 };
          if (typeof expectedMs !== 'number' || typeof actual !== 'number') { data.missing++; continue; }
          const error = Math.abs(actual - expectedMs);
          data.absolute.push(error); data.medianRatios.push(error / Math.max(20, expectedMs * 0.1)); data.p95Ratios.push(error / Math.max(50, expectedMs * 0.2));
        }
      }
      if ([...starts].some((id) => !ends.has(id))) incomplete = true;
    }
    invalid ||= sourceHashes.size > 1 || orphanEnds > 0 || duplicateStarts > 0 || duplicateEnds > 0 || [...workloads.values()].some((values) => values.size !== 1);
    const covered = measured.length === 9 && warmups.length >= 1 && ['001','002','003'].every((suffix) => {
      const seed = `obs-standard12-${suffix}`;
      return counts.get(seed) === 3 && [1,2,3].every((r) => repetitions.get(seed)?.has(r));
    });
    const metrics = Object.fromEntries(Object.entries(errors).map(([name, data]) => [name, {
      samples: data.absolute.length, missing: data.missing, medianAbsoluteErrorMs: quantile(data.absolute, .5), p95AbsoluteErrorMs: quantile(data.absolute, .95),
      medianLimitRatio: quantile(data.medianRatios, .5), p95LimitRatio: quantile(data.p95Ratios, .95),
      withinThresholds: data.absolute.length > 0 && data.missing === 0 && (quantile(data.medianRatios, .5) ?? Infinity) <= 1 && (quantile(data.p95Ratios, .95) ?? Infinity) <= 1,
    }]));
    const numeric = Object.values(metrics).length === 4 && Object.values(metrics).every((m) => m.withinThresholds);
    return { key, formalRuns: measured.length, warmups: warmups.length, covered, attempts, matchedTruth: matched,
      orphanEnds, duplicateStarts, duplicateEnds, sourceHashes: [...sourceHashes], workloadConsistent: [...workloads.values()].every((hashes) => hashes.size === 1), metrics,
      status: invalid ? 'invalid' : !covered || incomplete || matched !== attempts ? 'incomplete' : numeric ? 'within_thresholds' : 'inconclusive_noise' };
  });
  return { reportKind: 'synthetic_accuracy_acceptance', samples: evidence.length,
    status: results.length && results.every((r) => r.status === 'within_thresholds') ? 'within_thresholds' : 'not_passed', results };
}
