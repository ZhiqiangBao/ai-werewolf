import { createHash } from 'node:crypto';

export type Identity = { run: string; seat: string; call: string; attempt: number };
export type Expected = Identity & { native: string[]; projectionHash?: string; history?: string[]; httpStatus?: number };
export type Trace = Identity & { side: 'client' | 'server'; phase: 'start' | 'end'; time: number; native?: string[]; queueMs?: number; history?: string[]; httpStatus?: number; projectionHash?: string };
export type Evidence = { run: string; sourceHash: string; expectedHash: string; expected: Expected[]; trace: Trace[]; budgetLimit: number; reserved: number; status: 'complete' | 'cancelled' | 'budget_exhausted' | 'write_failed' | 'failed' };

const key = (x: Identity) => JSON.stringify([x.run, x.seat, x.call, x.attempt]);
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const validIdentity = (x: Identity) => nonempty(x.run) && nonempty(x.seat) && nonempty(x.call) && Number.isSafeInteger(x.attempt) && x.attempt >= 1;
const strings = (x: unknown) => Array.isArray(x) && x.every(item => typeof item === 'string');
const validHash = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const validStatus = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 100 && (x as number) <= 599;
export const hashExpected = (expected: Expected[]) => createHash('sha256').update(JSON.stringify(expected)).digest('hex');

/** Fail closed: missing evidence and incomplete runs are never successful samples. */
export function validateEvidence(e: Evidence, pinnedSource: string): string[] {
  const errors: string[] = [];
  if (!e || !Array.isArray(e.expected) || !Array.isArray(e.trace)) return ['malformed evidence'];
  if (!/^[a-f0-9]{64}$/.test(pinnedSource) || e.sourceHash !== pinnedSource) errors.push('source pin');
  if (e.expectedHash !== hashExpected(e.expected)) errors.push('expected hash');
  if (!nonempty(e.run) || e.expected.length === 0) errors.push('empty expected');
  if (e.status !== 'complete') errors.push(`incomplete: ${e.status}`);
  if (!Number.isSafeInteger(e.budgetLimit) || e.budgetLimit < 1 || e.budgetLimit > 512 || !Number.isSafeInteger(e.reserved) || e.reserved < 0 || e.reserved > e.budgetLimit) errors.push('budget');
  const jobs = new Map<string, Expected>();
  for (const job of e.expected) {
    if (!job || typeof job !== 'object') { errors.push('invalid expected'); continue; }
    const k = key(job);
    if (!validIdentity(job) || job.run !== e.run || !strings(job.native) || (job.projectionHash !== undefined && !validHash(job.projectionHash)) || (job.history !== undefined && !strings(job.history)) || (job.httpStatus !== undefined && !validStatus(job.httpStatus))) errors.push('invalid expected');
    if (jobs.has(k)) errors.push('duplicate expected');
    jobs.set(k, job);
  }
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
