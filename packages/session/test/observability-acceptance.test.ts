import { describe, expect, it } from 'vitest';
import { createBaselineAcceptance, evaluateBaselineEvidence, type BaselineEvidence } from '../src/observability/acceptance';

const source = 'a'.repeat(64), revision = 'b'.repeat(40);
let sequence = 0;
function sample(seed: string, repetition: number, warmup = false, scenario = 'S01', protocol = 'responses'): BaselineEvidence {
  const runId = `run-${(++sequence).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ref = { schemaVersion: 1 as const, runId, roomRef: 'r1' };
  const callId = `${runId}:call:18`, requestId = `${callId}:2`, id = `${callId}:5`;
  const rootId = `${runId}:run:1`;
  return { manifest: { completed: true, scenario, protocol, seed, repetition, warmup, roomCount: scenario === 'S01' ? 1 : 2,
    workloadSha256: seed.slice(-3).padStart(64, '0'), sourceRevision: revision, sourceRevisionEnd: revision,
    sourceSha256: source, sourceSha256End: source, sourceChangedDuringRun: false,
    collector: { dropped: 0, writeErrors: 0, bufferedRecords: 0, bufferedBytes: 0 }, collectorRuntime: { callbackErrors: 0, activeSpans: 0 } },
    observations: [
      { ...ref, kind: 'run', id: rootId, phase: 'start', atMs: 0 },
      { ...ref, kind: 'http_attempt', id, httpAttemptId: id, callId, requestId, parentId: requestId, attemptIndex: 0, phase: 'start', atMs: 0 },
      { ...ref, kind: 'http_attempt', id, httpAttemptId: id, callId, requestId, parentId: requestId, attemptIndex: 0, phase: 'end', atMs: 90, status: 200, outcome: 'success', metrics: Object.fromEntries(
        [['headersMs', 20], ['firstBodyByteMs', 50], ['firstStreamContentMs', 60], ['bodyConsumeMs', 70]].map(([key, valueMs]) => [key, { valueMs, source: 'client' }])) },
      { ...ref, kind: 'run', id: rootId, phase: 'end', atMs: 90, outcome: 'success' },
    ],
    truth: [{ attemptId: id, source: 'synthetic', planned: { headersMs: 20, firstContentMs: 30, chunks: 4, chunkIntervalMs: 10, status: 200, capacity: null },
      queueMs: 0, headersMs: 20, elapsedMs: 90, finished: true, firstBodyByteMs: 50, firstStreamContentMs: 60, bodyConsumeMs: 70 }],
  };
}
const fullGroup = (scenario = 'S01', protocol = 'responses') => [sample('obs-standard12-001', 0, true, scenario, protocol),
  ...['001', '002', '003'].flatMap((suffix) => [1, 2, 3].map((repetition) => sample(`obs-standard12-${suffix}`, repetition, false, scenario, protocol)))];
const fullMatrix = () => ['S01', 'S02', 'S03'].flatMap((scenario) =>
  ['chat_completions', 'responses', 'anthropic_messages'].flatMap((protocol) => fullGroup(scenario, protocol)));
const end = (row: BaselineEvidence) => row.observations.find((event) => event.kind === 'http_attempt' && event.phase === 'end')!;
const start = (row: BaselineEvidence) => row.observations.find((event) => event.kind === 'http_attempt' && event.phase === 'start')!;

describe('normal baseline acceptance integrity', () => {
  it('accepts all 81 formal samples and 9 independently checked warmups with a pinned source', () => {
    const result = evaluateBaselineEvidence(fullMatrix(), true, { expectedSourceSha256: source, expectedSourceRevision: revision });
    expect(result.status).toBe('within_thresholds');
    expect(result.samples).toBe(90);
    expect(result.results).toHaveLength(9);
    expect(result.integrity).toMatchObject({ truthRaw: 90, truthUnique: 90, httpStartsRaw: 90, httpStartsUnique: 90,
      httpEndsRaw: 90, httpEndsUnique: 90, duplicateTruth: 0, duplicateHttpStarts: 0, duplicateHttpEnds: 0 });
    for (const group of result.results) {
      expect(group).toMatchObject({ formalRuns: 9, warmups: 1, covered: true, attempts: 9, matchedTruth: 9, status: 'within_thresholds',
        integrity: { truthRaw: 10, truthUnique: 10, httpStartsRaw: 10, httpStartsUnique: 10, httpEndsRaw: 10, httpEndsUnique: 10,
          duplicateTruth: 0, duplicateHttpStarts: 0, duplicateHttpEnds: 0, truthWithoutStart: [], truthWithoutEnd: [],
          httpStartsWithoutTruth: [], httpEndsWithoutTruth: [], crossRunTruth: 0, crossRunObservations: 0 } });
      expect(group.metrics.firstStreamContentMs.medianAbsoluteErrorMs).toBe(0);
    }
    expect(evaluateBaselineEvidence(fullGroup().slice(0, 3), false).results[0].status).toBe('incomplete');
    expect(evaluateBaselineEvidence(fullGroup()).status).toBe('not_passed');
  });

  it('incrementally aggregates the same 90 samples without retaining mutable source arrays', () => {
    const rows = fullMatrix(), options = { expectedSourceSha256: source, expectedSourceRevision: revision };
    const expected = evaluateBaselineEvidence(rows, true, options), accumulator = createBaselineAcceptance(true, options);
    for (const row of rows) accumulator.add(row);
    for (const row of rows) { row.observations.length = 0; row.truth.length = 0; row.manifest.collector.dropped = 99; }
    expect(accumulator.finish()).toEqual(expected);
    expect(accumulator.finish().status).toBe('within_thresholds');
  });

  it('rejects corrupt warmup records through the incremental interface', () => {
    const rows = fullGroup(), accumulator = createBaselineAcceptance(false);
    rows[0].truth.push({ ...rows[0].truth[0] });
    for (const row of rows) accumulator.add(row);
    expect(accumulator.finish().results[0]).toMatchObject({ status: 'invalid', integrity: { duplicateTruth: 1 } });
  });

  it('detects an entirely missing HTTP pair even when truth and collector counters remain', () => {
    const rows = fullGroup(), id = rows[1].truth[0].attemptId;
    rows[1].observations = rows[1].observations.filter((event) => event.kind !== 'http_attempt');
    const group = evaluateBaselineEvidence(rows, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity.truthRaw).toBe(10);
    expect(group.integrity.httpStartsRaw).toBe(9);
    expect(group.integrity.truthWithoutStart).toHaveLength(1);
    expect(group.integrity.truthWithoutEnd).toHaveLength(1);
    expect(group.runs[1].integrity.truthWithoutStart).toEqual([id]);
  });

  it('reports extra and duplicate truth and missing truth in both directions', () => {
    const extra = fullGroup(), id = extra[1].truth[0].attemptId.replace(/:5$/, ':6');
    extra[1].truth.push({ ...extra[1].truth[0], attemptId: id });
    let group = evaluateBaselineEvidence(extra, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity).toMatchObject({ truthRaw: 11, truthUnique: 11, duplicateTruth: 0 });
    expect(group.runs[1].integrity.truthWithoutEnd).toEqual([id]);
    const duplicate = fullGroup(); duplicate[1].truth.push({ ...duplicate[1].truth[0] });
    group = evaluateBaselineEvidence(duplicate, false).results[0];
    expect(group).toMatchObject({ status: 'invalid', integrity: { truthRaw: 11, truthUnique: 10, duplicateTruth: 1 } });
    const missing = fullGroup(); missing[1].truth = [];
    group = evaluateBaselineEvidence(missing, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity.httpStartsWithoutTruth).toHaveLength(1);
    expect(group.integrity.httpEndsWithoutTruth).toHaveLength(1);
  });

  it('reports raw and unique HTTP counts and rejects duplicate starts or ends', () => {
    const rows = fullGroup(); rows[1].observations.splice(2, 0, structuredClone(start(rows[1])), structuredClone(end(rows[1])));
    const group = evaluateBaselineEvidence(rows, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity).toMatchObject({ httpStartsRaw: 11, httpStartsUnique: 10, httpEndsRaw: 11, httpEndsUnique: 10, duplicateHttpStarts: 1, duplicateHttpEnds: 1 });
  });

  it('retains malformed rows in raw counts without mislabeling absent IDs as duplicates', () => {
    const rows = fullGroup();
    delete (rows[1].truth[0] as unknown as { attemptId?: string }).attemptId;
    delete (start(rows[2]) as unknown as { id?: string }).id;
    const group = evaluateBaselineEvidence(rows, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity).toMatchObject({ truthRaw: 10, truthUnique: 9, invalidTruthIds: 1, duplicateTruth: 0,
      httpStartsRaw: 10, httpStartsUnique: 9, invalidHttpStartIds: 1, duplicateHttpStarts: 0 });
  });

  it('rejects foreign observation IDs, truth IDs and optional explicit foreign run IDs', () => {
    const foreignTruth = fullGroup(); foreignTruth[1].truth[0].attemptId = foreignTruth[2].truth[0].attemptId;
    expect(evaluateBaselineEvidence(foreignTruth, false).results[0]).toMatchObject({ status: 'invalid', integrity: { crossRunTruth: 1 } });
    const foreignObservation = fullGroup(); start(foreignObservation[1]).runId = start(foreignObservation[2]).runId;
    expect(evaluateBaselineEvidence(foreignObservation, false).results[0]).toMatchObject({ status: 'invalid', integrity: { crossRunObservations: 1 } });
    const foreignExplicit = fullGroup(); foreignExplicit[1].truth[0].runId = foreignExplicit[2].observations[0].runId;
    expect(evaluateBaselineEvidence(foreignExplicit, false).results[0]).toMatchObject({ status: 'invalid', integrity: { crossRunTruth: 1 } });
    const matchingExplicit = fullGroup(); matchingExplicit[1].truth[0].runId = matchingExplicit[1].observations[0].runId;
    expect(evaluateBaselineEvidence(matchingExplicit, false).status).toBe('within_thresholds');
  });

  it('rejects foreign causal calls and foreign or malformed usage source attempts', () => {
    const causal = fullGroup();
    end(causal[1]).causedByCallId = start(causal[2]).callId;
    expect(evaluateBaselineEvidence(causal, false).results[0]).toMatchObject({ status: 'invalid', integrity: { crossRunObservations: 1 } });

    const usage = fullGroup();
    const recorded = { inputTokens: 10, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, completeness: 'partial' as const };
    end(usage[1]).usage = { ...recorded, sourceHttpAttemptId: usage[2].truth[0].attemptId };
    expect(evaluateBaselineEvidence(usage, false).results[0]).toMatchObject({ status: 'invalid', integrity: { crossRunObservations: 1, invalidAttemptIds: 1 } });

    const malformed = fullGroup();
    end(malformed[1]).usage = { ...recorded, sourceHttpAttemptId: `${malformed[1].observations[0].runId}:call:bad:5` };
    expect(evaluateBaselineEvidence(malformed, false).results[0]).toMatchObject({ status: 'invalid', integrity: { crossRunObservations: 1, invalidAttemptIds: 1 } });

    const matching = fullGroup();
    end(matching[1]).causedByCallId = start(matching[1]).callId;
    end(matching[1]).usage = { ...recorded, sourceHttpAttemptId: matching[1].truth[0].attemptId };
    expect(evaluateBaselineEvidence(matching, false).status).toBe('within_thresholds');
  });

  it('requires an optional manifest run ID to match the root and redacts malformed input identifiers', () => {
    const matching = fullGroup(); matching[1].manifest.runId = matching[1].observations[0].runId;
    expect(evaluateBaselineEvidence(matching, false).status).toBe('within_thresholds');
    const wrong = fullGroup(); wrong[1].manifest.runId = wrong[2].observations[0].runId;
    expect(evaluateBaselineEvidence(wrong, false).results[0]).toMatchObject({ status: 'invalid', integrity: { manifestRunIdMismatch: 1 } });
    const sentinel = 'PRIVATE-SENTINEL-DO-NOT-OUTPUT';
    const rows = fullGroup();
    rows[1].truth[0].attemptId = `${sentinel}/truth`;
    start(rows[2]).id = `${sentinel}/observation`;
    rows[3].manifest.sourceSha256 = rows[3].manifest.sourceSha256End = `${sentinel}/hash`;
    rows[4].manifest.sourceRevision = rows[4].manifest.sourceRevisionEnd = `${sentinel}/revision`;
    rows[5].manifest.runId = `${sentinel}/run`;
    (rows[6].manifest as unknown as { warmup: string }).warmup = `${sentinel}/warmup`;
    const result = evaluateBaselineEvidence(rows, false);
    expect(result.status).toBe('not_passed');
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.results[0].runs[1].integrity.truthWithoutEnd).toContain('<invalid-attempt-id>');
    expect(result.integrity.truthWithoutEnd).toContain('<invalid-run-or-attempt-id>');
  });

  it('rejects duplicated run IDs across groups and invalid warmup evidence', () => {
    const first = fullGroup(), second = fullGroup('S02');
    const duplicate = structuredClone(first[1]); duplicate.manifest.scenario = 'S02'; duplicate.manifest.roomCount = 2;
    second[1] = duplicate;
    const result = evaluateBaselineEvidence([...first, ...second], false);
    expect(result.status).toBe('not_passed');
    expect(result.duplicateRunIds).toEqual([first[1].observations[0].runId]);
    expect(result.results.every((group) => group.status === 'invalid')).toBe(true);
    const warmup = fullGroup(); warmup[0].truth.push({ ...warmup[0].truth[0] });
    expect(evaluateBaselineEvidence(warmup, false).results[0]).toMatchObject({ status: 'invalid', integrity: { duplicateTruth: 1 } });
  });

  it.each([
    ['NaN observation metric', (row: BaselineEvidence) => { end(row).metrics!.headersMs = { valueMs: Number.NaN, source: 'client' }; }],
    ['negative truth time', (row: BaselineEvidence) => { row.truth[0].firstBodyByteMs = -1; }],
    ['infinite truth parameter', (row: BaselineEvidence) => { row.truth[0].planned.firstContentMs = Infinity; }],
    ['invalid counter', (row: BaselineEvidence) => { row.manifest.collector.dropped = Number.NaN; }],
    ['missing response metric', (row: BaselineEvidence) => { delete end(row).metrics!.bodyConsumeMs; }],
    ['nonnumeric recorded measurement', (row: BaselineEvidence) => { end(row).metrics!.parseMs = { valueMs: 'bad', source: 'client' } as never; }],
    ['missing truth time', (row: BaselineEvidence) => { row.truth[0].firstBodyByteMs = null; }],
    ['missing root', (row: BaselineEvidence) => { row.observations = row.observations.filter((event) => event.kind !== 'run'); }],
    ['bad HTTP attempt reference', (row: BaselineEvidence) => { end(row).httpAttemptId = 'wrong'; }],
    ['missing collector statistics', (row: BaselineEvidence) => { row.manifest.collectorRuntime = null; }],
  ] as const)('rejects %s as invalid rather than measurement noise', (_name, mutate) => {
    const rows = fullGroup(); mutate(rows[1]);
    expect(evaluateBaselineEvidence(rows, false).results[0].status).toBe('invalid');
  });

  it('enforces source format, start/end consistency and optional exact source pins', () => {
    const rows = fullGroup();
    expect(evaluateBaselineEvidence(rows, false, { expectedSourceSha256: source, expectedSourceRevision: revision }).status).toBe('within_thresholds');
    expect(evaluateBaselineEvidence(rows, false, { expectedSourceSha256: 'c'.repeat(64) }).results[0].status).toBe('invalid');
    expect(evaluateBaselineEvidence(rows, false, { expectedSourceRevision: 'c'.repeat(40) }).results[0].status).toBe('invalid');
    expect(evaluateBaselineEvidence(rows, false, { expectedSourceSha256: 'bad' })).toMatchObject({ invalidOptions: true, status: 'not_passed' });
    const malformed = fullGroup(); malformed[1].manifest.sourceSha256 = malformed[1].manifest.sourceSha256End = 'fixture-source';
    expect(evaluateBaselineEvidence(malformed, false).results[0].status).toBe('invalid');
    const changed = fullGroup(); changed[1].manifest.sourceSha256End = 'c'.repeat(64);
    expect(evaluateBaselineEvidence(changed, false).results[0].status).toBe('invalid');
    const changedRevision = fullGroup(); changedRevision[0].manifest.sourceRevisionEnd = 'c'.repeat(40);
    expect(evaluateBaselineEvidence(changedRevision, false).results[0].status).toBe('invalid');
    const missingRevision = fullGroup(); delete missingRevision[1].manifest.sourceRevisionEnd;
    expect(evaluateBaselineEvidence(missingRevision, false).results[0].status).toBe('invalid');
    const unpinnedAcrossGroups = [...fullGroup(), ...fullGroup('S02')];
    for (const row of unpinnedAcrossGroups.filter((row) => row.manifest.scenario === 'S02')) row.manifest.sourceSha256 = row.manifest.sourceSha256End = 'c'.repeat(64);
    expect(evaluateBaselineEvidence(unpinnedAcrossGroups, false).status).toBe('not_passed');
  });

  it('retains genuine timing noise as inconclusive and refuses fault scenarios', () => {
    const noisy = fullGroup();
    for (const row of noisy) end(row).metrics!.headersMs = { valueMs: 250, source: 'client' };
    expect(evaluateBaselineEvidence(noisy, false).results[0].status).toBe('inconclusive_noise');
    noisy[1].manifest.collector.dropped = 1;
    expect(evaluateBaselineEvidence(noisy, false).results[0].status).toBe('invalid');
    const fault = fullGroup(); fault.push(sample('obs-standard12-001', 1, false, 'S07'));
    expect(evaluateBaselineEvidence(fault, false)).toMatchObject({ unsupportedSamples: 1, status: 'not_passed' });
  });
});
