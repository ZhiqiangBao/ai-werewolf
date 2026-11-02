import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const dirs: string[] = [];
const hash = (input: Uint8Array) => createHash('sha256').update(input).digest('hex');
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('evaluates a complete directory group without a Python executable in PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-directory-accept-')); dirs.push(dir);
  const source = 'a'.repeat(64), revision = 'b'.repeat(40);
  const paths = Array.from({ length: 10 }, (_, index) => {
    const runId = `run-${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const suffix = index === 0 ? '001' : String(Math.ceil(index / 3)).padStart(3, '0');
    const callId = `${runId}:call:18`, requestId = `${callId}:2`, attemptId = `${callId}:5`, rootId = `${runId}:run:1`;
    const ref = { schemaVersion: 1, runId, roomRef: 'r1' };
    const manifest = { completed: true, scenario: 'S01', protocol: 'responses', seed: `obs-standard12-${suffix}`,
      repetition: index === 0 ? 0 : (index - 1) % 3 + 1, warmup: index === 0, roomCount: 1,
      workloadSha256: suffix.padStart(64, '0'), sourceRevision: revision, sourceRevisionEnd: revision, sourceSha256: source,
      sourceSha256End: source, sourceChangedDuringRun: false, collector: { dropped: 0, writeErrors: 0, bufferedRecords: 0, bufferedBytes: 0 },
      collectorRuntime: { callbackErrors: 0, activeSpans: 0 } };
    const metrics = Object.fromEntries([['headersMs', 20], ['firstBodyByteMs', 50], ['firstStreamContentMs', 60], ['bodyConsumeMs', 70]]
      .map(([key, valueMs]) => [key, { valueMs, source: 'client' }]));
    const observations = [
      { ...ref, kind: 'run', id: rootId, phase: 'start', atMs: 0 },
      { ...ref, kind: 'http_attempt', id: attemptId, httpAttemptId: attemptId, callId, requestId, parentId: requestId, attemptIndex: 0, phase: 'start', atMs: 0 },
      { ...ref, kind: 'http_attempt', id: attemptId, httpAttemptId: attemptId, callId, requestId, parentId: requestId, attemptIndex: 0,
        phase: 'end', atMs: 90, status: 200, outcome: 'success', metrics },
      { ...ref, kind: 'run', id: rootId, phase: 'end', atMs: 90, outcome: 'success' },
    ];
    const truth = [{ attemptId, source: 'synthetic', planned: { headersMs: 20, firstContentMs: 30, chunks: 4, chunkIntervalMs: 10, status: 200, capacity: null },
      queueMs: 0, headersMs: 20, elapsedMs: 90, finished: true, firstBodyByteMs: 50, firstStreamContentMs: 60, bodyConsumeMs: 70 }];
    const run = join(dir, `run-${index + 1}`); mkdirSync(run);
    writeFileSync(join(run, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(run, 'observations.jsonl'), observations.map((item) => JSON.stringify(item)).join('\n') + '\n');
    writeFileSync(join(run, 'synthetic-truth.jsonl'), truth.map((item) => JSON.stringify(item)).join('\n') + '\n');
    return run;
  });
  const output = join(dir, 'out');
  const list = join(dir, 'list.json'); writeFileSync(list, JSON.stringify(paths));
  const executable = resolve('packages/session/scripts/observability-accept.ts');
  const result = spawnSync(process.execPath, ['--import', 'tsx', executable, '--partial', '--input-list', list, '--output', output],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, PATH: '' } });
  expect(result.status, result.stderr).toBe(0);
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  const manifestBytes = readFileSync(join(output, 'input-manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  expect(summary).toMatchObject({ status: 'within_thresholds', samples: 10, evaluation: { inputManifestSha256: hash(manifestBytes) } });
  expect(manifest).toMatchObject({ archive: null, selection: { sha256: hash(readFileSync(list)) }, fullArchiveVerification: null });
  for (const input of manifest.inputs) for (const key of ['manifest', 'observations', 'truth']) {
    expect(input[key].sha256).toBe(hash(readFileSync(input[key].path)));
  }
}, 45_000);
