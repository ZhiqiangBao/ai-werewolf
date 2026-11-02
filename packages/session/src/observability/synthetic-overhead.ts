import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { SYNTHETIC_SEEDS, type SyntheticProtocol } from './synthetic-plan';
import { renderOverheadResources, summarizeOverheadResources } from './synthetic-overhead-resources';

const runFile = promisify(execFile);
const median = (values: number[]): number | null => {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length / 2) - 1] : null;
};
const mad = (values: number[]) => { const m = median(values); return m === null ? null : median(values.map((v) => Math.abs(v - m))); };

/** Separate processes keep heap and compatibility state independent for each paired sample. */
export async function runSyntheticOverhead(options: { scenario: 'S01' | 'S02'; protocol: SyntheticProtocol; pairs: number; seed?: typeof SYNTHETIC_SEEDS[number] }) {
  if (!Number.isInteger(options.pairs) || options.pairs < 1 || options.pairs > 100) throw new Error('Pair count must be 1–100');
  const root = resolve('data/diagnostics/synthetic'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'overhead-'));
  const rowsPath = resolve(directory, 'pairs.jsonl'); await writeFile(rowsPath, '');
  type Sample = Awaited<ReturnType<typeof import('./synthetic-run').runSyntheticBaseline>>;
  const pairs: { pair: number; order: 'AB' | 'BA'; seed: string; off: Sample; on: Sample; sameWorkload: boolean; sameSource: boolean }[] = [];
  let failure = false;
  try {
    for (let pair = 1; pair <= options.pairs; pair++) {
      const seed = options.seed ?? SYNTHETIC_SEEDS[(pair - 1) % 3], order: 'AB' | 'BA' = pair % 2 ? 'AB' : 'BA';
      const samples: Partial<Record<'on' | 'off', Sample>> = {};
      for (const mode of order === 'AB' ? ['off', 'on'] as const : ['on', 'off'] as const) {
        const script = resolve('packages/session/scripts/observability-synthetic.ts');
        const { stdout } = await runFile(process.execPath, ['--import', 'tsx', script, '--overhead-sample', '--scenario', options.scenario,
          '--protocol', options.protocol, '--seed', seed, '--observation', mode, '--repetition', String(pair)], { maxBuffer: 1024 * 1024 });
        samples[mode] = JSON.parse(stdout.trim()) as Sample;
      }
      const off = samples.off!, on = samples.on!;
      const row = { pair, order, seed, off, on, sameWorkload: off.manifest.workloadSha256 === on.manifest.workloadSha256,
        sameSource: off.manifest.sourceSha256 === on.manifest.sourceSha256 && !off.manifest.sourceChangedDuringRun && !on.manifest.sourceChangedDuringRun && off.manifest.sourceRevision === on.manifest.sourceRevision };
      pairs.push(row); await appendFile(rowsPath, `${JSON.stringify(row)}\n`);
    }
  } catch { failure = true; }
  const wallPercent = pairs.map(({ off, on }) => ((on.manifest.windowWallMs ?? NaN) / (off.manifest.windowWallMs ?? NaN) - 1) * 100);
  const p95Delta = pairs.map(({ off, on }) => (on.manifest.fixtureCallMs.p95 ?? NaN) - (off.manifest.fixtureCallMs.p95 ?? NaN));
  const offP95 = pairs.map(({ off }) => off.manifest.fixtureCallMs.p95 ?? NaN);
  const heapDelta = pairs.map(({ off, on }) => (on.manifest.fixtureHeapBytes?.median ?? NaN) - (off.manifest.fixtureHeapBytes?.median ?? NaN));
  const wallMedian = median(wallPercent), p95Median = median(p95Delta), offP95Median = median(offP95), heapMedian = median(heapDelta);
  const p95LimitMs = offP95Median === null ? null : Math.max(2, offP95Median * 0.05);
  const noise = { wallPercentMad: mad(wallPercent), p95DeltaMadMs: mad(p95Delta), heapDeltaMadBytes: mad(heapDelta) };
  const lost = pairs.some(({ on }) => on.manifest.collector.dropped !== 0 || on.manifest.collector.writeErrors !== 0);
  const sourceMismatches = pairs.filter((pair) => !pair.sameSource || pair.off.manifest.sourceSha256 !== pairs[0]?.off.manifest.sourceSha256 || pair.off.manifest.sourceRevision !== pairs[0]?.off.manifest.sourceRevision).length;
  const invalid = failure || pairs.some((pair) => !pair.sameWorkload) || sourceMismatches > 0 || lost || [wallMedian, p95Median, p95LimitMs, heapMedian].some((x) => x === null) ||
    [wallPercent, p95Delta, offP95, heapDelta].some((values) => values.some((value) => !Number.isFinite(value)));
  const noisy = noise.wallPercentMad === null || noise.wallPercentMad > 5 || noise.p95DeltaMadMs === null || noise.p95DeltaMadMs > (p95LimitMs ?? 0) || noise.heapDeltaMadBytes === null || noise.heapDeltaMadBytes > 8 * 1024 * 1024;
  const within = (wallMedian ?? Infinity) <= 5 && (p95Median ?? Infinity) <= (p95LimitMs ?? 0) && (heapMedian ?? Infinity) <= 8 * 1024 * 1024;
  const status = invalid ? 'invalid' : pairs.length < 30 ? 'insufficient_samples' : noisy ? 'inconclusive_noise' : within ? 'within_thresholds' : 'above_thresholds';
  const summary = { reportKind: 'synthetic_paired_overhead', scenario: options.scenario, protocol: options.protocol, requestedPairs: options.pairs,
    completedPairs: pairs.length, status, fixture: 'shared prepareWave wrapper and test fetch; one process per sample',
    heapSampling: 'median heapUsed after first 10 nonempty waves; no forced GC',
    wallMedianPercent: wallMedian, callP95MedianDeltaMs: p95Median, offCallP95MedianMs: offP95Median, p95LimitMs,
    heapMedianDeltaBytes: heapMedian, noise, droppedOrWriteFailed: lost, workloadMismatches: pairs.filter((p) => !p.sameWorkload).length,
    sourceMismatches,
    sourceRevision: pairs[0]?.off.manifest.sourceRevision ?? 'unknown', sourceSha256: pairs[0]?.off.manifest.sourceSha256 ?? 'unknown', sourceDirty: pairs[0]?.off.manifest.sourceDirty ?? null };
  await writeFile(resolve(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const resources = summarizeOverheadResources(pairs, summary);
  await writeFile(resolve(directory, 'report.md'), renderOverheadResources(resources));
  await writeFile(resolve(directory, 'resource-summary.json'), `${JSON.stringify(resources, null, 2)}\n`);
  await writeFile(resolve(directory, 'resource-report.md'), renderOverheadResources(resources));
  if (failure) throw new Error(`Overhead run incomplete; retained results: ${directory}`);
  return { directory, summary };
}
