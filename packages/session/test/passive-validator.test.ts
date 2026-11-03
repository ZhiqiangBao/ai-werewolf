import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashExpected, validateEvidence, type Evidence } from '../src/experiments/passive-validator';
import { initializeBudget, reserveAllocatedAttempt, reserveAttempt } from '../src/experiments/passive-budget';

const pin = 'a'.repeat(64);
function fixture(): Evidence {
  const identity = { run: 'r1', seat: '1', call: 'c1', attempt: 1 };
  const expected = [{ ...identity, native: ['tool_call:t', 'tool_result:t'] }];
  return { run: 'r1', sourceHash: pin, expectedHash: hashExpected(expected), expected, budgetLimit: 48, reserved: 1, status: 'complete', trace: [
    { ...identity, side: 'client', phase: 'start', time: 1 },
    { ...identity, side: 'server', phase: 'start', time: 2 },
    { ...identity, side: 'server', phase: 'end', time: 3, native: [...expected[0].native] },
    { ...identity, side: 'client', phase: 'end', time: 4, native: [...expected[0].native] },
  ] };
}
describe('passive evidence gate', () => {
  it('accepts only a fully paired sample', () => expect(validateEvidence(fixture(), pin)).toEqual([]));
  it('rejects a whole missing HTTP pair even if both logs omit it', () => {
    const e = fixture(); e.trace = []; expect(validateEvidence(e, pin)).toContain('missing server pair');
  });
  it('rejects duplicated truth and cross-run contamination', () => {
    const e = fixture(); e.trace.push({ ...e.trace[1] }); e.trace.push({ ...e.trace[1], run: 'r2' });
    expect(validateEvidence(e, pin)).toEqual(expect.arrayContaining(['duplicate trace', 'unexpected trace']));
  });
  it('rejects bad numbers, wrong source, altered input and native order', () => {
    const e = fixture(); e.trace[0].time = NaN; e.expected[0].native.reverse();
    expect(validateEvidence(e, 'b'.repeat(64))).toEqual(expect.arrayContaining(['invalid trace', 'source pin', 'expected hash', 'native order']));
  });
  it.each(['cancelled', 'budget_exhausted', 'write_failed'] as const)('does not treat %s as success', status => {
    const e = fixture(); e.status = status; expect(validateEvidence(e, pin)).toContain(`incomplete: ${status}`);
  });
  it('requires the reserved count to match the expected HTTP attempts', () => {
    const e = fixture(); e.reserved = 2; expect(validateEvidence(e, pin)).toContain('reservation mismatch');
  });
  it('rejects missing fields and an empty workload', () => {
    expect(validateEvidence({} as Evidence, pin)).toContain('malformed evidence');
    const e = fixture(); e.expected = []; e.expectedHash = hashExpected([]); e.trace = []; e.reserved = 0;
    expect(validateEvidence(e, pin)).toContain('empty expected');
  });
  it('rejects two overlapping calls on the same seat', () => {
    const e = fixture(); const second = { ...e.expected[0], call: 'c2' };
    e.expected.push(second); e.expectedHash = hashExpected(e.expected); e.reserved = 2;
    e.trace.push(...e.trace.map(row => ({ ...row, call: 'c2' })));
    expect(validateEvidence(e, pin)).toContain('seat overlap or order');
  });
  it('rejects an independently observed wrong native continuation order', () => {
    const e = fixture(); e.expected[0].history = ['previous', 'previous']; e.expectedHash = hashExpected(e.expected);
    e.trace[1].history = ['previous']; expect(validateEvidence(e, pin)).toContain('server history order');
  });
  it('rejects a wrong or missing projection hash even when every HTTP pair matches', () => {
    const e = fixture(); const hash = 'b'.repeat(64);
    e.expected[0].projectionHash = hash; e.expectedHash = hashExpected(e.expected);
    for (const row of e.trace) row.projectionHash = hash;
    expect(validateEvidence(e, pin)).toEqual([]);
    e.trace[1].projectionHash = 'c'.repeat(64);
    expect(validateEvidence(e, pin)).toContain('projection hash mismatch');
    delete e.trace[1].projectionHash;
    expect(validateEvidence(e, pin)).toContain('projection hash mismatch');
  });
  it.each(['run', 'seat', 'call'] as const)('rejects non-string or empty %s in expected and trace identities', field => {
    const e = fixture(); (e.expected[0] as unknown as Record<string, unknown>)[field] = {};
    e.expectedHash = hashExpected(e.expected); expect(validateEvidence(e, pin)).toContain('invalid expected');
    const other = fixture(); (other.trace[0] as unknown as Record<string, unknown>)[field] = '';
    expect(validateEvidence(other, pin)).toContain('invalid trace');
  });
  it.each([['native', [1]], ['history', ['ok', 1]], ['httpStatus', '200']] as const)('rejects invalid expected %s type', (field, value) => {
    const e = fixture(); (e.expected[0] as unknown as Record<string, unknown>)[field] = value;
    e.expectedHash = hashExpected(e.expected); expect(validateEvidence(e, pin)).toContain('invalid expected');
  });
  it('rejects non-finite trace times and queue durations', () => {
    const e = fixture(); e.trace[0].time = Infinity; e.trace[2].queueMs = -1;
    expect(validateEvidence(e, pin).filter(error => error === 'invalid trace')).toHaveLength(2);
  });
});
describe('cross-process budget file', () => {
  it('reserves before sending, refuses exhaustion, corruption and a held lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'passive-budget-')); const file = join(dir, 'budget.json');
    try {
      initializeBudget(file); expect(() => initializeBudget(file)).toThrow();
      expect(reserveAttempt(file, 'w', 3368, 1).pActual).toBe(1);
      expect(() => reserveAttempt(file, 'w', 3368, 1)).toThrow('budget exhausted');
      expect(reserveAttempt(file, 'x', 3368, 1).pActual).toBe(2);
      expect(() => reserveAttempt(file, 'y', 3368, 1)).toThrow('budget exhausted');
      expect(reserveAllocatedAttempt(file, 'S').allocations.S.actual).toBe(1);
      expect(JSON.parse(readFileSync(file, 'utf8')).pActual).toBe(2);
      writeFileSync(`${file}.lock`, 'held');
      expect(() => reserveAttempt(file, 'z', 3369, 1)).toThrow();
      rmSync(`${file}.lock`);
      writeFileSync(file, '{'); expect(() => reserveAttempt(file, 'z', 3369, 1)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('never grants beyond the shared limit under competing processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'passive-process-budget-')); const file = join(dir, 'budget.json');
    try {
      initializeBudget(file);
      const moduleUrl = pathToFileURL(join(process.cwd(), 'packages/session/src/experiments/passive-budget.ts')).href;
      const code = `import { reserveAttempt } from ${JSON.stringify(moduleUrl)}; try { reserveAttempt(process.argv[1], process.argv[2], 3370, 1, 'preflight'); } catch { process.exitCode = 1; }`;
      const run = (i: number) => new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, file, `w${i}`], { cwd: process.cwd(), stdio: 'ignore' });
        child.on('error', reject); child.on('exit', code => resolve(code ?? -1));
      });
      const exits = await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
      const actual = JSON.parse(readFileSync(file, 'utf8')).pActual;
      expect(actual).toBe(exits.filter(code => code === 0).length); expect(actual).toBeLessThanOrEqual(4); expect(actual).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
});
