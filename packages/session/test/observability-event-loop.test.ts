import { readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ObservationEvent } from '@werewolf/protocol';
import { runSyntheticBaseline } from '../src/observability/synthetic-run';

const directories: string[] = [];
afterEach(async () => {
  const root = resolve('data/diagnostics/synthetic') + sep;
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(root)) throw new Error('Unexpected synthetic output directory');
    await rm(directory, { recursive: true, force: true });
  }
});

it('exposes the initial 200ms client block after the event-loop sampler has started', async () => {
  const { directory, manifest } = await runSyntheticBaseline({ scenario: 'S12', protocol: 'responses', seed: 'obs-standard12-001' });
  directories.push(directory);
  expect(manifest).toMatchObject({ completed: true, selectedInjectionCount: 1, samplerWarmupMs: 20,
    eventLoopSampleIncludesWarmup: true,
    sourceChangedDuringRun: false, collector: { dropped: 0, writeErrors: 0, bufferedRecords: 0, bufferedBytes: 0 },
    collectorRuntime: { callbackErrors: 0, activeSpans: 0 } });
  expect(manifest.samplerWarmupActualMs).toBeGreaterThanOrEqual(20);
  expect(manifest.samplerWarmupSamples).toBeGreaterThan(0);
  expect(manifest.eventLoopSampleWindowMs).toBeGreaterThan(manifest.windowWallMs!);
  expect(manifest.eventLoopDelayMs.max).toBeGreaterThanOrEqual(150);
  const events = (await readFile(resolve(directory, 'observations.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as ObservationEvent);
  const calls = new Map(events.filter((event) => event.kind === 'model_call' && event.phase === 'start').map((event) => [event.id, event.atMs]));
  const gaps = events.filter((event) => event.kind === 'adapter_execution' && event.phase === 'start')
    .map((event) => event.atMs - (calls.get(event.callId!) ?? event.atMs));
  expect(Math.max(...gaps)).toBeGreaterThanOrEqual(190);
}, 25000);
