import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderOverheadResources, resourceDistribution, summarizeOverheadResources, type ResourcePair } from '../src/observability/synthetic-overhead-resources';

const pairs: ResourcePair[] = [
  { off: { manifest: { cpuMicros: { user: 0, system: 1000 }, eventLoopDelayMs: { mean: 1, p95: 3 }, eventLoopUtilization: 0.1, fixtureHeapBytes: { median: 100 } } },
    on: { manifest: { cpuMicros: { user: 10000, system: 2000 }, eventLoopDelayMs: { mean: 2, p95: 4 }, eventLoopUtilization: 0.2, fixtureHeapBytes: { median: 120 }, collector: { writtenBytes: 100, writtenRecords: 10, writeMs: 1, peakBytes: 20, peakRecords: 2 } } } },
  { off: { manifest: { cpuMicros: { user: 1000, system: 2000 }, eventLoopDelayMs: { mean: 2, p95: 4 }, eventLoopUtilization: 0.2, fixtureHeapBytes: { median: 200 } } },
    on: { manifest: { cpuMicros: { user: 100000, system: null }, eventLoopDelayMs: { mean: null, p95: 6 }, eventLoopUtilization: null, fixtureHeapBytes: null, collector: { writtenBytes: 200, writtenRecords: null, writeMs: 2, peakBytes: 40, peakRecords: 4 } } } },
  { off: { manifest: { cpuMicros: { user: 100000, system: 3000 }, eventLoopDelayMs: { mean: 3, p95: 5 }, eventLoopUtilization: 0.3, fixtureHeapBytes: { median: 300 } } },
    on: { manifest: { cpuMicros: { user: 101000, system: 4000 }, eventLoopDelayMs: { mean: Number.NaN, p95: 8 }, eventLoopUtilization: 0.25, fixtureHeapBytes: { median: 250 }, collector: { writtenBytes: null, writtenRecords: 30, writeMs: 3, peakBytes: 60, peakRecords: 6 } } } },
];

const metadata = { scenario: 'S01', protocol: 'responses', requestedPairs: 30, completedPairs: 3, status: 'insufficient_samples',
  sourceRevision: 'abc123', sourceSha256: 'source-hash', sourceDirty: false, fixture: 'fixture', heapSampling: 'after first 10 waves' };

describe('offline paired resource summary', () => {
  it('computes distributions from each paired difference, with field-level missing values', () => {
    const original = structuredClone(metadata), summary = summarizeOverheadResources(pairs, metadata);
    expect(summary.metrics.cpuUserMs.off).toEqual({ n: 3, missing: 0, p50: 1, p90: 100, p95: 100, max: 100 });
    expect(summary.metrics.cpuUserMs.on.p50).toBe(100);
    // off=[0,1,100], on=[10,100,101], paired differences=[10,99,1].
    expect(summary.metrics.cpuUserMs.pairedDelta).toEqual({ n: 3, missing: 0, p50: 10, p90: 99, p95: 99, max: 99 });
    expect(summary.metrics.cpuTotalMs.on).toMatchObject({ n: 2, missing: 1, p50: 12 });
    expect(summary.metrics.cpuTotalMs.pairedDelta).toMatchObject({ n: 2, missing: 1, p50: 2 });
    expect(summary.metrics.eventLoopMeanMs.on).toMatchObject({ n: 1, missing: 2, p50: 2 });
    expect(summary.metrics.steadyHeapBytes.pairedDelta).toMatchObject({ n: 2, missing: 1, p50: -50, max: 20 });
    expect(summary.collector.writtenBytes.on).toMatchObject({ n: 2, missing: 1, p50: 100, p95: 200 });
    expect(summary.collector.writtenRecords.on).toMatchObject({ n: 2, missing: 1 });
    expect(summary).toMatchObject({ requestedPairs: 30, completedPairs: 3, inputPairs: 3, status: 'insufficient_samples', sourceRevision: 'abc123', sourceDirty: false });
    expect(metadata).toEqual(original);
    const report = renderOverheadResources(summary);
    expect(report).toContain('状态：insufficient_samples');
    expect(report).toContain('事件循环延迟 P95 是每次运行各自的 P95');
    expect(report).toContain('| CPU 用户时间 | ms | 逐对差值 | 3 | 0 | 10 | 99 | 99 | 99 |');
    expect(report).toContain('| 诊断写入记录 | 条 | 开启 | 2 | 1 |');
  });

  it('reports all missing and negative paired samples without inventing zeros', () => {
    expect(resourceDistribution([-10, 0, 10, null])).toEqual({ n: 3, missing: 1, p50: 0, p90: 10, p95: 10, max: 10 });
    expect(summarizeOverheadResources([{ off: null, on: null }], {}).metrics.cpuUserMs.pairedDelta)
      .toEqual({ n: 0, missing: 1, p50: null, p90: null, p95: null, max: null });
    expect(summarizeOverheadResources([], {}).collector.writeMs.on).toEqual({ n: 0, missing: 0, p50: null, p90: null, p95: null, max: null });
  });

  it('renders the original thresholds, signed medians and noise without deciding a new status', () => {
    const original = { ...metadata, status: 'inconclusive_noise', wallMedianPercent: -2.5, callP95MedianDeltaMs: -3,
      p95LimitMs: 7, heapMedianDeltaBytes: -4096,
      noise: { wallPercentMad: 5.5, p95DeltaMadMs: 1.5, heapDeltaMadBytes: 16384 } };
    const summary = summarizeOverheadResources(pairs, original), report = renderOverheadResources(summary);
    expect(summary).toMatchObject({ status: 'inconclusive_noise', wallMedianPercent: -2.5, callP95MedianDeltaMs: -3,
      p95LimitMs: 7, heapMedianDeltaBytes: -4096, noise: original.noise });
    expect(report).toContain('状态：inconclusive_noise');
    expect(report).toContain('| 墙钟增幅 | % | -2.500 | ≤ 5 |');
    expect(report).toContain('| 调用 P95 增量 | ms | -3 | ≤ 7 |');
    expect(report).toContain('| 稳态堆增量 | bytes | -4096 | ≤ 8388608 |');
    expect(report).toContain('| 墙钟增幅 MAD | 百分点 | 5.500 | ≤ 5 |');
    expect(report).toContain('| 调用 P95 增量 MAD | ms | 1.500 | ≤ 7 |');
    expect(report).toContain('| 稳态堆增量 MAD | bytes | 16384 | ≤ 8388608 |');
    const missing = renderOverheadResources(summarizeOverheadResources([], { status: 'unknown' }));
    expect(missing).toContain('| 调用 P95 增量 | ms | N/A | N/A |');
    expect(missing).toContain('| 调用 P95 增量 MAD | ms | N/A | N/A |');
  });

  it('writes separate resource artifacts for an existing batch without changing its inputs', () => {
    const root = resolve('data'); mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, 'resource-summary-test-'));
    try {
      const pairText = `${pairs.map((pair) => JSON.stringify(pair)).join('\n')}\n`;
      const summaryText = `${JSON.stringify(metadata, null, 2)}\n`, oldReport = '原始开销报告\n';
      writeFileSync(join(directory, 'pairs.jsonl'), pairText);
      writeFileSync(join(directory, 'summary.json'), summaryText);
      writeFileSync(join(directory, 'report.md'), oldReport);
      execFileSync(process.execPath, ['--import', 'tsx', resolve('packages/session/scripts/observability-resources.ts'), directory], { encoding: 'utf8' });
      expect(readFileSync(join(directory, 'pairs.jsonl'), 'utf8')).toBe(pairText);
      expect(readFileSync(join(directory, 'summary.json'), 'utf8')).toBe(summaryText);
      expect(readFileSync(join(directory, 'report.md'), 'utf8')).toBe(oldReport);
      expect(JSON.parse(readFileSync(join(directory, 'resource-summary.json'), 'utf8'))).toMatchObject({ status: 'insufficient_samples', inputPairs: 3 });
      expect(readFileSync(join(directory, 'resource-report.md'), 'utf8')).toContain('诊断写入字节');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 10000);
});
