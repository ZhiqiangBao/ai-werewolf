/** Offline descriptive statistics; this module does not decide benchmark status. */
export interface ResourceManifest {
  cpuMicros?: { user?: unknown; system?: unknown } | null;
  eventLoopDelayMs?: { mean?: unknown; p95?: unknown } | null;
  eventLoopUtilization?: unknown;
  fixtureHeapBytes?: { median?: unknown } | null;
  collector?: { writtenBytes?: unknown; writtenRecords?: unknown; writeMs?: unknown; peakBytes?: unknown; peakRecords?: unknown } | null;
}

export interface ResourcePair {
  off?: { manifest?: ResourceManifest | null } | null;
  on?: { manifest?: ResourceManifest | null } | null;
}

export interface ResourceMetadata {
  scenario?: string;
  protocol?: string;
  requestedPairs?: number;
  completedPairs?: number;
  status?: string;
  sourceRevision?: string;
  sourceSha256?: string;
  sourceDirty?: boolean | null;
  heapSampling?: string;
  fixture?: string;
  wallMedianPercent?: number | null;
  callP95MedianDeltaMs?: number | null;
  p95LimitMs?: number | null;
  heapMedianDeltaBytes?: number | null;
  noise?: { wallPercentMad?: number | null; p95DeltaMadMs?: number | null; heapDeltaMadBytes?: number | null } | null;
}

export interface ResourceDistribution {
  n: number;
  missing: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
}

type Accessor = (manifest: ResourceManifest | null | undefined) => number | null;
const nonnegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const microsToMs = (value: unknown) => { const n = nonnegative(value); return n === null ? null : n / 1000; };

/** Nearest-rank applies to each sample separately, including signed paired differences. */
export function resourceDistribution(values: readonly (number | null)[]): ResourceDistribution {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  const rank = (p: number) => valid.length ? valid[Math.ceil(valid.length * p) - 1] : null;
  return { n: valid.length, missing: values.length - valid.length, p50: rank(0.5), p90: rank(0.9), p95: rank(0.95), max: valid.at(-1) ?? null };
}

const pairedMetrics: Record<string, { label: string; unit: string; get: Accessor }> = {
  cpuUserMs: { label: 'CPU 用户时间', unit: 'ms', get: (m) => microsToMs(m?.cpuMicros?.user) },
  cpuSystemMs: { label: 'CPU 系统时间', unit: 'ms', get: (m) => microsToMs(m?.cpuMicros?.system) },
  cpuTotalMs: { label: 'CPU 总时间', unit: 'ms', get: (m) => {
    const user = microsToMs(m?.cpuMicros?.user), system = microsToMs(m?.cpuMicros?.system);
    return user === null || system === null ? null : user + system;
  } },
  eventLoopMeanMs: { label: '事件循环延迟均值', unit: 'ms', get: (m) => nonnegative(m?.eventLoopDelayMs?.mean) },
  eventLoopP95Ms: { label: '事件循环延迟 P95', unit: 'ms', get: (m) => nonnegative(m?.eventLoopDelayMs?.p95) },
  eventLoopUtilization: { label: '事件循环利用率（ELU）', unit: '比率', get: (m) => nonnegative(m?.eventLoopUtilization) },
  steadyHeapBytes: { label: '稳态堆采样中位数', unit: 'bytes', get: (m) => nonnegative(m?.fixtureHeapBytes?.median) },
};

const collectorMetrics: Record<string, { label: string; unit: string; get: Accessor }> = {
  writtenBytes: { label: '诊断写入字节', unit: 'bytes', get: (m) => nonnegative(m?.collector?.writtenBytes) },
  writtenRecords: { label: '诊断写入记录', unit: '条', get: (m) => nonnegative(m?.collector?.writtenRecords) },
  writeMs: { label: '诊断写入耗时', unit: 'ms', get: (m) => nonnegative(m?.collector?.writeMs) },
  peakBytes: { label: '缓冲峰值字节', unit: 'bytes', get: (m) => nonnegative(m?.collector?.peakBytes) },
  peakRecords: { label: '缓冲峰值记录', unit: '条', get: (m) => nonnegative(m?.collector?.peakRecords) },
};

export function summarizeOverheadResources(pairs: readonly ResourcePair[], metadata: ResourceMetadata) {
  const metrics = Object.fromEntries(Object.entries(pairedMetrics).map(([key, spec]) => {
    const off = pairs.map((pair) => spec.get(pair.off?.manifest));
    const on = pairs.map((pair) => spec.get(pair.on?.manifest));
    const delta = pairs.map((_, index) => off[index] === null || on[index] === null ? null : on[index]! - off[index]!);
    return [key, { label: spec.label, unit: spec.unit, off: resourceDistribution(off), on: resourceDistribution(on), pairedDelta: resourceDistribution(delta) }];
  }));
  const collector = Object.fromEntries(Object.entries(collectorMetrics).map(([key, spec]) => [key, {
    label: spec.label, unit: spec.unit, on: resourceDistribution(pairs.map((pair) => spec.get(pair.on?.manifest))),
  }]));
  return { reportKind: 'synthetic_paired_resource_summary' as const,
    scenario: metadata.scenario ?? 'unknown', protocol: metadata.protocol ?? 'unknown',
    requestedPairs: metadata.requestedPairs ?? null, completedPairs: metadata.completedPairs ?? null, inputPairs: pairs.length,
    status: metadata.status ?? 'unknown', sourceRevision: metadata.sourceRevision ?? 'unknown', sourceSha256: metadata.sourceSha256 ?? 'unknown',
    sourceDirty: metadata.sourceDirty ?? null, heapSampling: metadata.heapSampling ?? 'unknown', fixture: metadata.fixture ?? 'unknown',
    wallMedianPercent: finite(metadata.wallMedianPercent), callP95MedianDeltaMs: finite(metadata.callP95MedianDeltaMs),
    p95LimitMs: finite(metadata.p95LimitMs), heapMedianDeltaBytes: finite(metadata.heapMedianDeltaBytes),
    noise: { wallPercentMad: finite(metadata.noise?.wallPercentMad), p95DeltaMadMs: finite(metadata.noise?.p95DeltaMadMs),
      heapDeltaMadBytes: finite(metadata.noise?.heapDeltaMadBytes) },
    metrics, collector };
}

export function renderOverheadResources(summary: ReturnType<typeof summarizeOverheadResources>): string {
  const safe = (value: string) => value.replace(/[\r\n|]/g, ' ');
  const fmt = (value: number | null) => value === null ? 'N/A' : Number.isInteger(value) ? String(value) : value.toFixed(3);
  const row = (name: string, unit: string, group: string, d: ResourceDistribution) =>
    `| ${safe(name)} | ${safe(unit)} | ${group} | ${d.n} | ${d.missing} | ${fmt(d.p50)} | ${fmt(d.p90)} | ${fmt(d.p95)} | ${fmt(d.max)} |`;
  const limit = (value: number | null) => value === null ? 'N/A' : `≤ ${fmt(value)}`;
  const lines = [
    '# 合成采集开销：资源汇总', '',
    `场景：${safe(summary.scenario)}；协议：${safe(summary.protocol)}；状态：${safe(summary.status)}；完成/计划配对：${summary.completedPairs ?? 'N/A'}/${summary.requestedPairs ?? 'N/A'}；输入配对：${summary.inputPairs}。`,
    `源码版本：${safe(summary.sourceRevision)}；源码 SHA-256：${safe(summary.sourceSha256)}；工作区有未提交更改：${summary.sourceDirty === null ? '未知' : summary.sourceDirty ? '是' : '否'}。`,
    `夹具：${safe(summary.fixture)}；堆采样：${safe(summary.heapSampling)}。`, '',
    '以下主开销和噪声数值与状态直接取自原始摘要，不在此报告中重新判定。', '',
    '| 主开销指标 | 单位 | 逐对中位数 | 原门槛 |', '| --- | --- | ---: | ---: |',
    `| 墙钟增幅 | % | ${fmt(summary.wallMedianPercent)} | ≤ 5 |`,
    `| 调用 P95 增量 | ms | ${fmt(summary.callP95MedianDeltaMs)} | ${limit(summary.p95LimitMs)} |`,
    `| 稳态堆增量 | bytes | ${fmt(summary.heapMedianDeltaBytes)} | ≤ 8388608 |`, '',
    '| 噪声指标（配对差值 MAD） | 单位 | 原摘要数值 | 原噪声界限 |', '| --- | --- | ---: | ---: |',
    `| 墙钟增幅 MAD | 百分点 | ${fmt(summary.noise.wallPercentMad)} | ≤ 5 |`,
    `| 调用 P95 增量 MAD | ms | ${fmt(summary.noise.p95DeltaMadMs)} | ${limit(summary.p95LimitMs)} |`,
    `| 稳态堆增量 MAD | bytes | ${fmt(summary.noise.heapDeltaMadBytes)} | ≤ 8388608 |`, '',
    '以下分位数按每次运行或逐对差值采用 nearest-rank；事件循环延迟 P95 是每次运行各自的 P95 再跨运行统计，ELU 是比率而非 CPU 利用率。配对差值为每组开启减关闭后再计算分位数。', '',
    '| 指标 | 单位 | 组别 | 有效 n | 缺失 | P50 | P90 | P95 | 最大 |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const metric of Object.values(summary.metrics)) {
    lines.push(row(metric.label, metric.unit, '关闭', metric.off), row(metric.label, metric.unit, '开启', metric.on), row(metric.label, metric.unit, '逐对差值', metric.pairedDelta));
  }
  for (const metric of Object.values(summary.collector)) lines.push(row(metric.label, metric.unit, '开启', metric.on));
  lines.push('', '缺失值显示为 N/A；此报告只补充资源描述，不更改原有门槛、状态或有效性判断。', '');
  return lines.join('\n');
}
