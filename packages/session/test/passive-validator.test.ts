import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashExpected, validateEvidence, type Evidence } from '../src/experiments/passive-validator';
import { initializeBudget, reserveAllocatedAttempt, reserveAttempt } from '../src/experiments/passive-budget';
import { planWindow, type WindowConfig } from '../src/experiments/passive-loopback';

const pin = 'a'.repeat(64);
const frames: WindowConfig['projections'] = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [String(index + 1), index === 0 ? ['{}', '{"task":true}'] : ['{}', '{}']]));
const config: WindowConfig = { run: 'r1', sourceHash: pin, protocol: 'responses', candidate: 'A', rooms: 1, providers: 1, baseMs: 80, slowMs: 400, slots: 4, budgetPath: 'unused', budgetGroup: 'preflight', totalLimit: 150000, windowLimit: 48, projections: frames };
function fixture(): Evidence {
  const expected = planWindow(config).expected;
  return { run: 'r1', sourceHash: pin, expectedHash: hashExpected(expected), expected, budgetLimit: 48, reserved: expected.length, status: 'complete', trace: expected.flatMap((job, index) => [
    { ...job, side: 'client' as const, phase: 'start' as const, time: index * 5 + 1 },
    { ...job, side: 'server' as const, phase: 'start' as const, time: index * 5 + 2 },
    { ...job, side: 'server' as const, phase: 'end' as const, time: index * 5 + 3, native: [...job.native] },
    { ...job, side: 'client' as const, phase: 'end' as const, time: index * 5 + 4, native: [...job.native] },
  ]) };
}
const validate = (e: Evidence, source = pin, ledgerReserved = e.expected?.length) => validateEvidence(e, source, { config, frames, ledgerReserved });
describe('passive evidence gate', () => {
  it('accepts only a fully paired sample', () => expect(validate(fixture())).toEqual([]));
  it('rejects a whole missing HTTP pair even if both logs omit it', () => {
    const e = fixture(); e.trace = []; expect(validate(e)).toContain('missing server pair');
  });
  it('rejects duplicated truth and cross-run contamination', () => {
    const e = fixture(); e.trace.push({ ...e.trace[1] }); e.trace.push({ ...e.trace[1], run: 'r2' });
    expect(validate(e)).toEqual(expect.arrayContaining(['duplicate trace', 'unexpected trace']));
  });
  it('rejects duplicate and extra declared jobs and extra matching traces', () => {
    const e = fixture(); e.expected.push({ ...e.expected[0] });
    const extra = { ...e.expected[0], call: 'extra' }; e.expected.push(extra); e.expectedHash = hashExpected(e.expected);
    e.trace.push({ ...e.trace[0], call: extra.call });
    expect(validate(e)).toEqual(expect.arrayContaining(['duplicate expected', 'unexpected expected', 'unexpected trace', 'expected count mismatch']));
  });
  it.each(['projectionHash', 'history', 'httpStatus'] as const)('requires the planned %s even when the declared hash is recomputed', field => {
    const e = fixture(); delete e.expected[0][field]; e.expectedHash = hashExpected(e.expected);
    expect(validate(e)).toEqual(expect.arrayContaining(['invalid expected', 'expected fields mismatch']));
  });
  it('rejects bad numbers, wrong source, altered input and native order', () => {
    const e = fixture(); e.trace[0].time = NaN; e.expected[0].native.reverse(); e.trace[3].native?.reverse();
    expect(validate(e, 'b'.repeat(64))).toEqual(expect.arrayContaining(['invalid trace', 'source pin', 'expected hash', 'native order', 'expected fields mismatch']));
  });
  it.each(['cancelled', 'budget_exhausted', 'write_failed'] as const)('does not treat %s as success', status => {
    const e = fixture(); e.status = status; expect(validate(e)).toContain(`incomplete: ${status}`);
  });
  it('requires the reserved count to match the expected HTTP attempts', () => {
    const e = fixture(); e.reserved--; expect(validate(e)).toEqual(expect.arrayContaining(['reservation mismatch', 'budget ledger mismatch']));
  });
  it('rejects a whole missing job and all four traces even after the hash and reservation are made self-consistent', () => {
    const e = fixture(); const omitted = e.expected.pop()!;
    e.trace = e.trace.filter(row => row.call !== omitted.call || row.attempt !== omitted.attempt);
    e.reserved--; e.expectedHash = hashExpected(e.expected);
    expect(validate(e, pin, e.reserved)).toEqual(expect.arrayContaining(['missing expected', 'expected count mismatch', 'reservation mismatch', 'missing client pair', 'missing server pair']));
  });
  it('rejects missing fields and an empty workload', () => {
    expect(validate({} as Evidence)).toContain('malformed evidence');
    const e = fixture(); e.expected = []; e.expectedHash = hashExpected([]); e.trace = []; e.reserved = 0;
    expect(validate(e)).toContain('empty expected');
  });
  it('rejects two overlapping calls on the same seat', () => {
    const e = fixture(); e.trace[4].time = 1;
    expect(validate(e)).toContain('seat overlap or order');
  });
  it('rejects an independently observed wrong native continuation order', () => {
    const e = fixture(); e.trace[5].history = ['previous'];
    expect(validate(e)).toContain('server history order');
  });
  it('rejects a wrong or missing projection hash even when every HTTP pair matches', () => {
    const e = fixture(); expect(validate(e)).toEqual([]);
    e.trace[1].projectionHash = 'c'.repeat(64);
    expect(validate(e)).toContain('projection hash mismatch');
    delete e.trace[1].projectionHash;
    expect(validate(e)).toContain('projection hash mismatch');
  });
  it.each(['run', 'seat', 'call'] as const)('rejects non-string or empty %s in expected and trace identities', field => {
    const e = fixture(); (e.expected[0] as unknown as Record<string, unknown>)[field] = {};
    e.expectedHash = hashExpected(e.expected); expect(validate(e)).toContain('invalid expected');
    const other = fixture(); (other.trace[0] as unknown as Record<string, unknown>)[field] = '';
    expect(validate(other)).toContain('invalid trace');
  });
  it.each([['native', [1]], ['history', ['ok', 1]], ['httpStatus', '200']] as const)('rejects invalid expected %s type', (field, value) => {
    const e = fixture(); (e.expected[0] as unknown as Record<string, unknown>)[field] = value;
    e.expectedHash = hashExpected(e.expected); expect(validate(e)).toContain('invalid expected');
  });
  it('rejects non-finite trace times and queue durations', () => {
    const e = fixture(); e.trace[0].time = Infinity; e.trace[2].queueMs = -1;
    expect(validate(e).filter(error => error === 'invalid trace')).toHaveLength(2);
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
