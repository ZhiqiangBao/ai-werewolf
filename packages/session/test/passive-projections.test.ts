import { expect, it } from 'vitest';
import { fixedProjections, projectionHash } from '../src/experiments/passive-projections';
import { planWindow, type WindowConfig } from '../src/experiments/passive-loopback';

it('freezes deterministic standard12 engine projections separately for each seat', () => {
  const first = fixedProjections('obs-standard12-001'); const second = fixedProjections('obs-standard12-001');
  expect(first).toEqual(second); expect(Object.keys(first)).toHaveLength(12);
  expect(projectionHash(first['1'][0])).toMatch(/^[a-f0-9]{64}$/);
  expect(first['1'][0]).not.toEqual(first['2'][0]);
  expect(Object.values(first).some(([before, after]) => before !== after)).toBe(true);
});
it('predeclares both segments and every planned retry before dispatch', () => {
  const config: WindowConfig = { run: 'preflight', protocol: 'responses', candidate: 'A', rooms: 1, providers: 1, slowMs: 400, baseMs: 80, slots: 4, sourceHash: 'a'.repeat(64), budgetPath: 'unused', budgetGroup: 'preflight', totalLimit: 150000, windowLimit: 48, projections: fixedProjections('obs-standard12-001') };
  const normal = planWindow(config); expect(normal.expected).toHaveLength(26);
  expect(normal.expected.filter(j => j.call.startsWith('slow/'))).toHaveLength(13);
  const fault = planWindow({ ...config, faultStatus: 429 }); expect(fault.expected).toHaveLength(28);
  expect(fault.expected.filter(j => j.httpStatus === 429)).toHaveLength(2);
});
