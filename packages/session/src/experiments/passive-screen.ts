export type Segment = { name: string; wallMs: number; actionWaitMs: number[] };
export type ScreenComparison = { normalWallChange: number | null; slowWallImprovement: number | null; slowActionWaitImprovement: number | null; meetsTimingScreen: boolean | null };
export function p95(values: number[]): number | null {
  if (!values.length || values.some(x => !Number.isFinite(x) || x < 0)) return null;
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
}
export function compareScreen(a: Segment[], b: Segment[]): ScreenComparison {
  const an = a.find(x => x.name === 'normal'); const bn = b.find(x => x.name === 'normal');
  const as = a.find(x => x.name === 'slow'); const bs = b.find(x => x.name === 'slow');
  const normalWallChange = an && bn && Number.isFinite(an.wallMs) && an.wallMs > 0 && Number.isFinite(bn.wallMs) && bn.wallMs >= 0 ? bn.wallMs / an.wallMs - 1 : null;
  const slowWallImprovement = as && bs && Number.isFinite(as.wallMs) && as.wallMs > 0 && Number.isFinite(bs.wallMs) && bs.wallMs >= 0 ? 1 - bs.wallMs / as.wallMs : null;
  const ap = as ? p95(as.actionWaitMs) : null; const bp = bs ? p95(bs.actionWaitMs) : null;
  const slowActionWaitImprovement = ap !== null && ap > 0 && bp !== null ? 1 - bp / ap : null;
  const meetsTimingScreen = normalWallChange === null || slowWallImprovement === null || slowActionWaitImprovement === null ? null : normalWallChange <= .05 && slowWallImprovement >= .20 && slowActionWaitImprovement >= .30;
  return { normalWallChange, slowWallImprovement, slowActionWaitImprovement, meetsTimingScreen };
}
