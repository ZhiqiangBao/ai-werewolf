import { createHash } from 'node:crypto';
import type { ObservationEvent } from '@werewolf/protocol';
import type { BaselineEvidence } from '../src/observability/acceptance';

/** Synthetic observation contract fixture; it is not an independently simulated game. */
export const source = 'a'.repeat(64), revision = 'b'.repeat(40);
let sequence = 0;

export function sample(seed: string, repetition: number, warmup = false, scenario = 'S01', protocol = 'responses',
  options: { waves?: number; endReason?: 'natural_end' | '30_nonempty_waves' } = {}): BaselineEvidence {
  const runId = `run-${(++sequence).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const rootId = `${runId}:run:1`, roomCount = scenario === 'S01' ? 1 : 2, waves = options.waves ?? 30;
  const observations: ObservationEvent[] = [{ schemaVersion: 1, runId, roomRef: 'all', kind: 'run', id: rootId, phase: 'start', atMs: 0 }];
  const truth: BaselineEvidence['truth'] = [], workload: { roomRef: string; waves: { seatRef: string; purpose: string }[][] }[] = [];
  const waveCounts: Record<string, number> = {}, roomWindowMs: Record<string, number> = {}, endReasons: Record<string, string> = {};
  for (let room = 0; room < roomCount; room++) {
    const roomRef = `r${room + 1}`, roomName = room === 0 ? 'synthetic-A' : 'synthetic-B';
    const roomWaves: { seatRef: string; purpose: string }[][] = [];
    for (let wave = 0; wave < waves; wave++) {
      const ordinal = room * 1000 + wave + 1, t = 100 + wave * 250 + room * 3;
      const waveId = `${runId}:wave:${ordinal}`, workId = `${runId}:work:${ordinal}`;
      const callId = `${runId}:call:${ordinal}`, requestId = `${callId}:2`, id = `${callId}:5`;
      const seatRef = `s${wave % 12 + 1}`, purpose = wave % 2 ? 'action' as const : 'listen' as const;
      const ref = { schemaVersion: 1 as const, runId, roomRef, seatRef, waveId, workId };
      const callRef = { ...ref, callId, apiProtocol: protocol as 'chat_completions' | 'responses' | 'anthropic_messages', purpose };
      const attemptRef = { ...ref, callId, requestId, parentId: requestId, id, httpAttemptId: id, attemptIndex: 0 };
      const headers = scenario === 'S03' && room === 1 ? 80 : 20;
      observations.push(
        { ...ref, kind: 'wave', id: waveId, phase: 'start', atMs: t },
        { ...ref, kind: 'work', id: workId, phase: 'start', purpose, atMs: t + 1 },
        { ...callRef, kind: 'model_call', id: callId, phase: 'start', atMs: t + 2 },
        { ...attemptRef, kind: 'http_attempt', phase: 'start', atMs: t + 3 },
        { ...attemptRef, kind: 'http_attempt', phase: 'end', atMs: t + 180, status: 200, outcome: 'success', metrics: {
          headersMs: { valueMs: headers, source: 'client' }, firstBodyByteMs: { valueMs: headers + 30, source: 'client' },
          firstStreamContentMs: { valueMs: headers + 40, source: 'client' }, bodyConsumeMs: { valueMs: 70, source: 'client' },
        } },
        { ...callRef, kind: 'model_call', id: callId, phase: 'end', atMs: t + 190, outcome: 'success' },
        { ...ref, kind: 'work', id: workId, phase: 'end', purpose, atMs: t + 191, outcome: 'success' },
        { ...ref, kind: 'wave', id: waveId, phase: 'end', atMs: t + 192, members: 1, outcome: 'success' },
      );
      truth.push({ attemptId: id, source: 'synthetic', planned: { headersMs: headers, firstContentMs: 30, chunks: 4, chunkIntervalMs: 10, status: 200, capacity: null },
        queueMs: 0, headersMs: headers, elapsedMs: headers + 70, finished: true, firstBodyByteMs: headers + 30,
        firstStreamContentMs: headers + 40, bodyConsumeMs: 70 });
      roomWaves.push([{ seatRef, purpose }]);
    }
    workload.push({ roomRef, waves: roomWaves });
    waveCounts[roomRef] = waves; roomWindowMs[roomName] = waves * 250;
    endReasons[roomName] = options.endReason ?? '30_nonempty_waves';
  }
  observations.push({ schemaVersion: 1, runId, roomRef: 'all', kind: 'run', id: rootId, phase: 'end', atMs: waves * 250 + 500, outcome: 'success' });
  return { manifest: { completed: true, scenario, protocol, seed, repetition, warmup, roomCount,
    workloadSha256: createHash('sha256').update(JSON.stringify(workload)).digest('hex'), sourceRevision: revision, sourceRevisionEnd: revision,
    sourceSha256: source, sourceSha256End: source, sourceChangedDuringRun: false, waveCounts, roomWindowMs, endReasons,
    windowWallMs: waves * 250 + 100, windowFixture: 'wave_end_watcher', sequenceEvidence: { adapterCalls: roomCount * waves, syntheticHttpAttempts: roomCount * waves },
    collector: { dropped: 0, writeErrors: 0, bufferedRecords: 0, bufferedBytes: 0 }, collectorRuntime: { callbackErrors: 0, activeSpans: 0 } }, observations, truth };
}

export const fullGroup = (scenario = 'S01', protocol = 'responses') => [sample('obs-standard12-001', 0, true, scenario, protocol),
  ...['001', '002', '003'].flatMap((suffix) => [1, 2, 3].map((repetition) => sample(`obs-standard12-${suffix}`, repetition, false, scenario, protocol)))];
export const fullMatrix = () => ['S01', 'S02', 'S03'].flatMap((scenario) =>
  ['chat_completions', 'responses', 'anthropic_messages'].flatMap((protocol) => fullGroup(scenario, protocol)));
