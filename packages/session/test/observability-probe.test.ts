import { readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ObservationEvent } from '@werewolf/protocol';
import { buildObservationReport } from '../src/observability/report';
import { runSyntheticProbe } from '../src/observability/synthetic-probe';

const directories: string[] = [];
afterEach(async () => {
  const root = resolve('data/diagnostics/synthetic') + sep;
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(root)) throw new Error('Unexpected probe output directory');
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps independent adapter probes distinct when their diagnostic streams are combined', async () => {
  const runs = [];
  const events: ObservationEvent[] = [];
  for (let repetition = 1; repetition <= 2; repetition++) {
    const result = await runSyntheticProbe({ scenario: 'S11', protocol: 'responses', probe: 'abort', repetition });
    directories.push(result.directory); runs.push(result.manifest);
    const rows = (await readFile(resolve(result.directory, 'observations.jsonl'), 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as ObservationEvent);
    expect(rows.every((event) => event.runId === result.manifest.runId && event.callId === result.manifest.callId)).toBe(true);
    expect(result.manifest).toMatchObject({ completed: true, outcome: 'cancelled', sourceChangedDuringRun: false });
    expect(result.manifest.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.sourceSha256End).toBe(result.manifest.sourceSha256);
    events.push(...rows);
  }
  expect(runs[0].runId).not.toBe(runs[1].runId);
  const report = buildObservationReport(events);
  expect(report.layers.http_attempt).toMatchObject({ started: 2, finished: 2, incomplete: 0, outcomes: { cancelled: 2 } });
  expect(report.duplicates).toBe(0);
  expect(report.orphanEnds).toBe(0);
}, 15000);
