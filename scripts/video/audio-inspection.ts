export const audioInspectionVersion = 'pcm-integrity-v1';
export interface AudioIssue {
  kind: 'dc-flatline' | 'clipping' | 'silent';
  start: number;
  end: number;
  detail: string;
}
export interface AudioInspection {
  duration: number;
  peak: number;
  rms: number;
  railSamples: number;
  longestRailRun: number;
  issues: AudioIssue[];
}

/** Detect damaged PCM, including held samples which volume normalization conceals. */
export function inspectAudio(samples: Int16Array, sampleRate: number): AudioInspection {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !samples.length) throw Error('Expected non-empty PCM and a valid sample rate');
  const issues: AudioIssue[] = [];
  let peak = 0, energy = 0, railSamples = 0, railStart = 0, railSign = 0, longestRailRun = 0;
  let heldStart = 0, heldValue = samples[0];
  const heldMinimum = Math.ceil(sampleRate * .020), railMinimum = Math.ceil(sampleRate * .003);
  const clipping: { start: number; end: number }[] = [];
  function held(end: number) {
    if (end - heldStart >= heldMinimum && Math.abs(heldValue) >= 32768 * .05) issues.push({
      kind: 'dc-flatline', start: heldStart / sampleRate, end: end / sampleRate,
      detail: `非零采样值持续不变（容差8 LSB），幅度约${(Math.abs(heldValue) / 32768 * 100).toFixed(1)}%`,
    });
  }
  function rails(end: number) {
    const length = end - railStart;
    longestRailRun = Math.max(longestRailRun, length);
    if (length >= railMinimum) clipping.push({ start: railStart / sampleRate, end: end / sampleRate });
  }
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i], amplitude = Math.abs(value);
    peak = Math.max(peak, amplitude / 32768); energy += (value / 32768) ** 2;
    if (Math.abs(value - heldValue) > 8) { held(i); heldStart = i; heldValue = value; }
    const sign = amplitude >= 32760 ? Math.sign(value) : 0;
    if (sign) railSamples++;
    if (sign !== railSign) {
      if (railSign) rails(i);
      railStart = i; railSign = sign;
    }
  }
  held(samples.length); if (railSign) rails(samples.length);
  const rms = Math.sqrt(energy / samples.length), duration = samples.length / sampleRate;
  // A full-scale held sample is already represented by the more precise DC finding.
  const groups: AudioIssue[] = [];
  for (const span of clipping) if (!issues.some((e) => e.start <= span.start + .001 && e.end >= span.end - .001)) {
    const previous = groups.at(-1);
    if (previous && span.start - previous.end <= .05) { previous.end = span.end; previous.detail = '反复出现同极性的满幅削波平台'; }
    else groups.push({ kind: 'clipping', ...span, detail: '同一极性的满幅削波持续至少3毫秒' });
  }
  issues.push(...groups);
  if (!clipping.length && !issues.length && railSamples >= Math.max(24, samples.length * .0005) && longestRailRun >= sampleRate * .0005) {
    issues.push({ kind: 'clipping', start: 0, end: duration, detail: '反复出现削波平台，排除仅一两个采样点触顶的正常峰值' });
  }
  if (rms < .002 && peak < .02) issues.push({ kind: 'silent', start: 0, end: duration, detail: '配音近乎静音' });
  return { duration, peak, rms, railSamples, longestRailRun, issues: issues.sort((a, b) => a.start - b.start) };
}
