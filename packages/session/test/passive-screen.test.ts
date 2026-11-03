import { expect, it } from 'vitest';
import { compareScreen, p95 } from '../src/experiments/passive-screen';

it('uses run-level P95 and predeclared thresholds without dividing by zero', () => {
  expect(p95([1, 2, 3, 4, 5])).toBe(5); expect(p95([NaN])).toBeNull();
  const baseline = [{ name: 'normal', wallMs: 100, actionWaitMs: [1] }, { name: 'slow', wallMs: 100, actionWaitMs: [100] }];
  const candidate = [{ name: 'normal', wallMs: 104, actionWaitMs: [1] }, { name: 'slow', wallMs: 79, actionWaitMs: [69] }];
  expect(compareScreen(baseline, candidate).meetsTimingScreen).toBe(true);
  expect(compareScreen(baseline, [{ ...candidate[0], wallMs: 106 }, candidate[1]]).meetsTimingScreen).toBe(false);
  expect(compareScreen([{ ...baseline[0], wallMs: 0 }, baseline[1]], candidate).meetsTimingScreen).toBeNull();
});
