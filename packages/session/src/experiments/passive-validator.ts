import { createHash } from 'node:crypto';
import { reconstructPlan, type FrozenConfig, type FrozenFrames } from './passive-plan';

export type Identity = { run: string; seat: string; call: string; attempt: number };
export type Expected = Identity & { native: string[]; projectionHash?: string; history?: string[]; httpStatus?: number };
export type Trace = Identity & { side: 'client' | 'server'; phase: 'start' | 'end'; time: number; native?: string[]; queueMs?: number; history?: string[]; httpStatus?: number; projectionHash?: string };
export type Evidence = { run: string; sourceHash: string; expectedHash: string; expected: Expected[]; trace: Trace[]; budgetLimit: number; reserved: number; status: 'complete' | 'cancelled' | 'budget_exhausted' | 'write_failed' | 'failed' };
export type IndependentEvidence = { config: FrozenConfig; frames: FrozenFrames; ledgerReserved: number };

const key = (x: Identity) => JSON.stringify([x.run, x.seat, x.call, x.attempt]);
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const validIdentity = (x: Identity) => nonempty(x.run) && nonempty(x.seat) && nonempty(x.call) && Number.isSafeInteger(x.attempt) && x.attempt >= 1;
const strings = (x: unknown) => Array.isArray(x) && x.every(item => typeof item === 'string');
const validHash = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const validStatus = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 100 && (x as number) <= 599;
export const hashExpected = (expected: Expected[]) => createHash('sha256').update(JSON.stringify(expected)).digest('hex');

/** Fail closed: missing evidence and incomplete runs are never successful samples. */
export function validateEvidence(e: Evidence, pinnedSource: string, independent: IndependentEvidence): string[] {
  const errors: string[] = [];
  if (!e || !Array.isArray(e.expected) || !Array.isArray(e.trace)) return ['malformed evidence'];
  let planned: Expected[];
  try { planned = reconstructPlan(independent.config, independent.frames); } catch { return ['invalid independent plan']; }
  if (!/^[a-f0-9]{64}$/.test(pinnedSource) || e.sourceHash !== pinnedSource) errors.push('source pin');
  if (independent.config.sourceHash !== pinnedSource || independent.config.run !== e.run) errors.push('plan identity');
  if (e.expectedHash !== hashExpected(e.expected)) errors.push('expected hash');
  if (!nonempty(e.run) || e.expected.length === 0) errors.push('empty expected');
  if (e.status !== 'complete') errors.push(`incomplete: ${e.status}`);
  if (!Number.isSafeInteger(e.budgetLimit) || e.budgetLimit < 1 || e.budgetLimit > 512 || e.budgetLimit !== independent.config.windowLimit || !Number.isSafeInteger(e.reserved) || e.reserved < 0 || e.reserved > e.budgetLimit) errors.push('budget');
  if (!Number.isSafeInteger(independent.ledgerReserved) || independent.ledgerReserved < 0 || independent.ledgerReserved !== e.reserved) errors.push('budget ledger mismatch');
  const jobs = new Map(planned.map(job => [key(job), job]));
  const declared = new Map<string, Expected>();
  for (const job of e.expected) {
    if (!job || typeof job !== 'object') { errors.push('invalid expected'); continue; }
    const k = key(job);
    if (!validIdentity(job) || job.run !== e.run || !strings(job.native) || !validHash(job.projectionHash) || !strings(job.history) || !validStatus(job.httpStatus)) errors.push('invalid expected');
    if (declared.has(k)) errors.push('duplicate expected');
    declared.set(k, job);
    const reference = jobs.get(k);
    if (!reference) errors.push('unexpected expected');
    else if (job.projectionHash !== reference.projectionHash || job.httpStatus !== reference.httpStatus || JSON.stringify(job.native) !== JSON.stringify(reference.native) || JSON.stringify(job.history) !== JSON.stringify(reference.history)) errors.push('expected fields mismatch');
  }
  if (e.expected.length !== planned.length) errors.push('expected count mismatch');
  for (const k of jobs.keys()) if (!declared.has(k)) errors.push('missing expected');
  const seen = new Map<string, Trace>();
  for (const row of e.trace) {
    if (!row || typeof row !== 'object') { errors.push('invalid trace'); continue; }
    const k = key(row); const rk = `${k}/${row.side}/${row.phase}`;
    if (row.run !== e.run || !jobs.has(k)) errors.push('unexpected trace');
    if (!validIdentity(row) || !['client', 'server'].includes(row.side) || !['start', 'end'].includes(row.phase) || !Number.isFinite(row.time) || row.time < 0 || (row.queueMs !== undefined && (!Number.isFinite(row.queueMs) || row.queueMs < 0)) || (row.native !== undefined && !strings(row.native)) || (row.history !== undefined && !strings(row.history)) || (row.httpStatus !== undefined && !validStatus(row.httpStatus)) || (row.projectionHash !== undefined && !validHash(row.projectionHash))) errors.push('invalid trace');
    const expected = jobs.get(k);
    if (expected?.projectionHash !== undefined && row.projectionHash !== expected.projectionHash) errors.push('projection hash mismatch');
    if (seen.has(rk)) errors.push('duplicate trace');
    seen.set(rk, row);
  }
  const previousEnd = new Map<string, number>();
  for (const [k, job] of jobs) {
    for (const side of ['client', 'server'] as const) {
      const start = seen.get(`${k}/${side}/start`); const end = seen.get(`${k}/${side}/end`);
      if (!start || !end) errors.push(`missing ${side} pair`);
      else if (end.time < start.time) errors.push('time order');
    }
    const end = seen.get(`${k}/client/end`);
    if (end && JSON.stringify(end.native) !== JSON.stringify(job.native)) errors.push('native order');
    const serverEnd = seen.get(`${k}/server/end`);
    if (serverEnd && JSON.stringify(serverEnd.native) !== JSON.stringify(job.native)) errors.push('server native order');
    if (job.httpStatus !== undefined && ((end && end.httpStatus !== job.httpStatus) || (serverEnd && serverEnd.httpStatus !== job.httpStatus))) errors.push('HTTP status mismatch');
    const serverStart = seen.get(`${k}/server/start`);
    if (job.history && serverStart && JSON.stringify(serverStart.history) !== JSON.stringify(job.history)) errors.push('server history order');
    const start = seen.get(`${k}/client/start`);
    const previous = previousEnd.get(job.seat);
    if (start && previous !== undefined && start.time < previous) errors.push('seat overlap or order');
    if (end) previousEnd.set(job.seat, end.time);
  }
  if (e.reserved !== jobs.size) errors.push('reservation mismatch');
  return errors;
}
