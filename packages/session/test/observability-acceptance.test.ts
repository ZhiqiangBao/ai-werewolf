import { expect, it } from 'vitest';
import { evaluateBaselineEvidence, type BaselineEvidence } from '../src/observability/acceptance';

function sample(seed: string, repetition: number, warmup = false): BaselineEvidence {
  const ref = { schemaVersion: 1 as const, runId: `r-${seed}-${repetition}`, roomRef: 'r1' };
  return { manifest: { completed: true, scenario: 'S01', protocol: 'responses', seed, repetition, warmup, roomCount: 1,
    workloadSha256: seed, sourceRevision: 'fixture', collector: { dropped: 0, writeErrors: 0, bufferedRecords: 0, bufferedBytes: 0 } },
    observations: [{ ...ref, kind: 'http_attempt', id: 'h1', phase: 'start', atMs: 0 },
      { ...ref, kind: 'http_attempt', id: 'h1', phase: 'end', atMs: 90, outcome: 'success', metrics: Object.fromEntries(
        [['headersMs',20],['firstBodyByteMs',50],['firstStreamContentMs',60],['bodyConsumeMs',70]].map(([key, valueMs]) => [key, { valueMs, source: 'client' }])) }],
    truth: [{ attemptId: 'h1', source: 'synthetic', planned: { headersMs: 20, firstContentMs: 30, chunks: 4, chunkIntervalMs: 10, status: 200, capacity: null },
      queueMs: 0, headersMs: 20, elapsedMs: 90, finished: true, firstBodyByteMs: 50, firstStreamContentMs: 60, bodyConsumeMs: 70 } as BaselineEvidence['truth'][number]],
  };
}
const fullGroup = () => [sample('obs-standard12-001', 0, true), ...['001','002','003'].flatMap((s) => [1,2,3].map((r) => sample(`obs-standard12-${s}`,r)))];

it('requires nine repetitions and aligned server intervals without comparing process clocks', () => {
  const result = evaluateBaselineEvidence(fullGroup(), false);
  expect(result.status).toBe('within_thresholds');
  expect(result.results[0].metrics.firstStreamContentMs.medianAbsoluteErrorMs).toBe(0);
  expect(evaluateBaselineEvidence(fullGroup().slice(0, 3), false).results[0].status).toBe('incomplete');
  expect(evaluateBaselineEvidence(fullGroup()).status).toBe('not_passed');
});

it('retains disturbed, dropped and missing-terminal samples as non-passing evidence', () => {
  const rows = fullGroup();
  for (const row of rows) row.observations[1].metrics!.headersMs = { valueMs: 250, source: 'client' };
  expect(evaluateBaselineEvidence(rows, false).results[0].status).toBe('inconclusive_noise');
  rows[1].manifest.collector.dropped = 1;
  expect(evaluateBaselineEvidence(rows, false).results[0].status).toBe('invalid');
  const missing = fullGroup(); missing[1].observations.pop();
  expect(evaluateBaselineEvidence(missing, false).results[0].status).toBe('incomplete');
});
