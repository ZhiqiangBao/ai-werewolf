import { describe, expect, it } from 'vitest';
import { createBaselineAcceptance, evaluateBaselineEvidence, type BaselineEvidence } from '../src/observability/acceptance';
import { fullGroup, fullMatrix, revision, sample, source } from './observability-fixture';
const end = (row: BaselineEvidence) => row.observations.find((event) => event.kind === 'http_attempt' && event.phase === 'end')!;
const start = (row: BaselineEvidence) => row.observations.find((event) => event.kind === 'http_attempt' && event.phase === 'start')!;

describe('normal baseline acceptance integrity', () => {
  it('accepts all 81 formal samples and 9 independently checked warmups with a pinned source', () => {
    const result = evaluateBaselineEvidence(fullMatrix(), true, { expectedSourceSha256: source, expectedSourceRevision: revision });
    expect(result.status).toBe('within_thresholds');
    expect(result.samples).toBe(90);
    expect(result.results).toHaveLength(9);
    expect(result.integrity).toMatchObject({ truthRaw: 4500, truthUnique: 4500, httpStartsRaw: 4500, httpStartsUnique: 4500,
      httpEndsRaw: 4500, httpEndsUnique: 4500, duplicateTruth: 0, duplicateHttpStarts: 0, duplicateHttpEnds: 0 });
    for (const group of result.results) {
      const count = group.key.startsWith('S01/') ? 300 : 600;
      expect(group).toMatchObject({ formalRuns: 9, warmups: 1, covered: true, attempts: count * 0.9, matchedTruth: count * 0.9, status: 'within_thresholds',
        integrity: { truthRaw: count, truthUnique: count, httpStartsRaw: count, httpStartsUnique: count, httpEndsRaw: count, httpEndsUnique: count,
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
    rows[1].observations = rows[1].observations.filter((event) => !(event.kind === 'http_attempt' && event.id === id));
    const group = evaluateBaselineEvidence(rows, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity.truthRaw).toBe(300);
    expect(group.integrity.httpStartsRaw).toBe(299);
    expect(group.integrity.truthWithoutStart).toHaveLength(1);
    expect(group.integrity.truthWithoutEnd).toHaveLength(1);
    expect(group.runs[1].integrity.truthWithoutStart).toEqual([id]);
  });

  it('reports extra and duplicate truth and missing truth in both directions', () => {
    const extra = fullGroup(), id = extra[1].truth[0].attemptId.replace(/:call:1:5$/, ':call:99999:5');
    extra[1].truth.push({ ...extra[1].truth[0], attemptId: id });
    let group = evaluateBaselineEvidence(extra, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity).toMatchObject({ truthRaw: 301, truthUnique: 301, duplicateTruth: 0 });
    expect(group.runs[1].integrity.truthWithoutEnd).toEqual([id]);
    const duplicate = fullGroup(); duplicate[1].truth.push({ ...duplicate[1].truth[0] });
    group = evaluateBaselineEvidence(duplicate, false).results[0];
    expect(group).toMatchObject({ status: 'invalid', integrity: { truthRaw: 301, truthUnique: 300, duplicateTruth: 1 } });
    const missing = fullGroup(); missing[1].truth.shift();
    group = evaluateBaselineEvidence(missing, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity.httpStartsWithoutTruth).toHaveLength(1);
    expect(group.integrity.httpEndsWithoutTruth).toHaveLength(1);
  });

  it('reports raw and unique HTTP counts and rejects duplicate starts or ends', () => {
    const rows = fullGroup(); rows[1].observations.splice(2, 0, structuredClone(start(rows[1])), structuredClone(end(rows[1])));
    const group = evaluateBaselineEvidence(rows, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity).toMatchObject({ httpStartsRaw: 301, httpStartsUnique: 300, httpEndsRaw: 301, httpEndsUnique: 300, duplicateHttpStarts: 1, duplicateHttpEnds: 1 });
  });

  it('retains malformed rows in raw counts without mislabeling absent IDs as duplicates', () => {
    const rows = fullGroup();
    delete (rows[1].truth[0] as unknown as { attemptId?: string }).attemptId;
    delete (start(rows[2]) as unknown as { id?: string }).id;
    const group = evaluateBaselineEvidence(rows, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity).toMatchObject({ truthRaw: 300, truthUnique: 299, invalidTruthIds: 1, duplicateTruth: 0,
      httpStartsRaw: 300, httpStartsUnique: 299, invalidHttpStartIds: 1, duplicateHttpStarts: 0 });
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

  it.each([
    ['headersMs', 21], ['firstContentMs', 31], ['chunks', 3], ['chunkIntervalMs', 11], ['status', 201], ['capacity', 1],
  ] as const)('rejects a changed truth plan field %s', (field, value) => {
    const rows = fullGroup();
    (rows[1].truth[0].planned as unknown as Record<string, unknown>)[field] = value;
    expect(evaluateBaselineEvidence(rows, false).results[0]).toMatchObject({ status: 'invalid', integrity: { invalidTruthPlans: 1 } });
  });

  it('checks S03 truth plans against the room that issued the HTTP attempt', () => {
    const rows = fullGroup('S03');
    expect(evaluateBaselineEvidence(rows, false).status).toBe('within_thresholds');
    rows[1].truth[30].planned.headersMs = 20;
    expect(evaluateBaselineEvidence(rows, false).results[0]).toMatchObject({ status: 'invalid', integrity: { invalidTruthPlans: 1 } });
  });

  it.each(['headersMs', 'firstBodyByteMs', 'firstStreamContentMs', 'bodyConsumeMs'] as const)(
    'requires the measurement source to be client for %s', (field) => {
      const rows = fullGroup();
      end(rows[1]).metrics![field] = { valueMs: 20, source: 'synthetic' };
      expect(evaluateBaselineEvidence(rows, false).results[0]).toMatchObject({ status: 'invalid', integrity: { invalidMetricSources: 1 } });
    },
  );

  it('rejects protocol relabelling and HTTP attempts without their paired model call', () => {
    const relabelled = fullGroup();
    for (const row of relabelled) row.manifest.protocol = 'chat_completions';
    const group = evaluateBaselineEvidence(relabelled, false).results[0];
    expect(group.covered).toBe(true);
    expect(group.status).toBe('invalid');
    expect(group.integrity.invalidModelCalls).toBeGreaterThan(0);

    const unlinked = fullGroup(), callId = start(unlinked[1]).callId;
    unlinked[1].observations = unlinked[1].observations.filter((event) => !(event.kind === 'model_call' && event.id === callId));
    unlinked[1].manifest.sequenceEvidence!.adapterCalls--;
    const result = evaluateBaselineEvidence(unlinked, false).results[0];
    expect(result.status).toBe('invalid');
    expect(result.integrity.invalidSequenceCounts).toBe(0);
    expect(result.integrity.invalidHttpCallLinks).toBeGreaterThan(0);
  });

  it('requires a paired call for every successful work even when the attempt sets still agree', () => {
    const rows = fullGroup(), row = rows[1], retained = row.truth[0].attemptId;
    const retainedCall = retained.slice(0, retained.lastIndexOf(':'));
    row.observations = row.observations.filter((event) =>
      !['model_call', 'http_attempt'].includes(event.kind) || event.callId === retainedCall);
    row.truth = row.truth.filter((entry) => entry.attemptId === retained);
    row.manifest.sequenceEvidence!.adapterCalls = 1;
    row.manifest.sequenceEvidence!.syntheticHttpAttempts = 1;
    const result = evaluateBaselineEvidence(rows, false).results[0];
    expect(result.status).toBe('invalid');
    expect(result.integrity.successfulWorkWithoutCall).toBe(29);
    expect(result.integrity.invalidSequenceCounts).toBe(0);
    expect(result.integrity.invalidWorkloadHash).toBe(0);
    expect(result.integrity.truthWithoutStart).toEqual([]);
    expect(result.integrity.httpStartsWithoutTruth).toEqual([]);
  });

  it('rejects a call referring to a different work despite using same-run identifiers', () => {
    const rows = fullGroup(), models = rows[1].observations.filter((event) => event.kind === 'model_call' && event.phase === 'start');
    models[0].workId = models[1].workId;
    const result = evaluateBaselineEvidence(rows, false).results[0];
    expect(result.status).toBe('invalid');
    expect(result.integrity.invalidModelWorkLinks).toBeGreaterThan(0);
  });

  it.each(['skipped', 'cancelled'] as const)('does not require an unissued call for a %s work', (outcome) => {
    const rows = fullGroup(), row = rows[1], callId = start(row).callId!;
    const workId = start(row).workId!;
    row.observations = row.observations.filter((event) => !(['model_call', 'http_attempt'].includes(event.kind) && event.callId === callId));
    row.observations.find((event) => event.kind === 'work' && event.phase === 'end' && event.id === workId)!.outcome = outcome;
    row.truth = row.truth.filter((entry) => !entry.attemptId.startsWith(`${callId}:`));
    row.manifest.sequenceEvidence!.adapterCalls--;
    row.manifest.sequenceEvidence!.syntheticHttpAttempts--;
    const result = evaluateBaselineEvidence(rows, false);
    expect(result.results[0].integrity.successfulWorkWithoutCall).toBe(0);
    expect(result.status).toBe('within_thresholds');
  });

  it('rejects a coherently truncated wave, HTTP pair and truth despite matching attempt sets', () => {
    const rows = fullGroup(), row = rows[1];
    const wave = row.observations.filter((event) => event.kind === 'wave' && event.phase === 'start').at(-1)!;
    const ids = new Set(row.observations.filter((event) => event.kind === 'http_attempt' && event.waveId === wave.id).map((event) => event.id));
    row.observations = row.observations.filter((event) => event.waveId !== wave.id);
    row.truth = row.truth.filter((entry) => !ids.has(entry.attemptId));
    row.manifest.sequenceEvidence!.adapterCalls--;
    row.manifest.sequenceEvidence!.syntheticHttpAttempts--;
    const group = evaluateBaselineEvidence(rows, false).results[0];
    expect(group.status).toBe('invalid');
    expect(group.integrity.truthWithoutStart).toEqual([]);
    expect(group.integrity.httpStartsWithoutTruth).toEqual([]);
    expect(group.integrity.invalidSequenceCounts).toBe(0);
    expect(group.integrity.invalidWorkloadHash).toBe(1);
    expect(group.integrity.invalidRoomWindows).toBeGreaterThan(0);
  });

  it('requires room windows, exact aliases and independent sequence counts', () => {
    const missing = fullGroup(); delete missing[1].manifest.roomWindowMs;
    expect(evaluateBaselineEvidence(missing, false).results[0].integrity.invalidRoomWindows).toBeGreaterThan(0);
    const short = fullGroup(); short[1].manifest.roomWindowMs!['synthetic-A'] = 1;
    expect(evaluateBaselineEvidence(short, false).results[0].integrity.invalidRoomWindows).toBeGreaterThan(0);
    const aliases = fullGroup('S02'); delete aliases[1].manifest.waveCounts!.r2;
    expect(evaluateBaselineEvidence(aliases, false).results[0].integrity.invalidRoomWindows).toBeGreaterThan(0);
    const sequence = fullGroup(); sequence[1].manifest.sequenceEvidence!.syntheticHttpAttempts--;
    expect(evaluateBaselineEvidence(sequence, false).results[0].integrity.invalidSequenceCounts).toBe(1);
    const members = fullGroup();
    const waveEnd = members[1].observations.find((event) => event.kind === 'wave' && event.phase === 'end')!;
    waveEnd.members = 2;
    expect(evaluateBaselineEvidence(members, false).results[0].integrity.invalidWaveStructure).toBeGreaterThan(0);
  });

  it('accepts consistent natural-end metadata without claiming independent engine replay', () => {
    const rows = fullGroup();
    for (let repetition = 1; repetition <= 3; repetition++)
      rows[repetition] = sample('obs-standard12-001', repetition, false, 'S01', 'responses', { waves: 3, endReason: 'natural_end' });
    const result = evaluateBaselineEvidence(rows, false);
    expect(result.status).toBe('within_thresholds');
    expect(result.workloadEvidenceScope).toBe('observed_wave_consistency_not_engine_replay');
    rows[1].manifest.completed = false;
    expect(evaluateBaselineEvidence(rows, false).results[0].status).toBe('invalid');
  });

  it('retains genuine timing noise as inconclusive and refuses fault scenarios', () => {
    const noisy = fullGroup();
    for (const row of noisy) for (const event of row.observations) {
      if (event.kind === 'http_attempt' && event.phase === 'end') event.metrics!.headersMs = { valueMs: 250, source: 'client' };
    }
    expect(evaluateBaselineEvidence(noisy, false).results[0].status).toBe('inconclusive_noise');
    noisy[1].manifest.collector.dropped = 1;
    expect(evaluateBaselineEvidence(noisy, false).results[0].status).toBe('invalid');
    const fault = fullGroup(); fault.push(sample('obs-standard12-001', 1, false, 'S07'));
    expect(evaluateBaselineEvidence(fault, false)).toMatchObject({ unsupportedSamples: 1, status: 'not_passed' });
  });
});
