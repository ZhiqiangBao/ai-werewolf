import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export type BudgetGroup = 'preflight' | 'screen' | 'fault' | 'formal';
export interface Budget {
  version: 1; totalLimit: 150000; externalActual: number;
  allocations: { S: { reserved: number; actual: number }; integration: { reserved: number; actual: number } };
  groups: Record<BudgetGroup, number>; pActual: number; windows: Record<string, number>; windowGroups: Record<string, BudgetGroup>;
}
const caps: Record<BudgetGroup, number> = { preflight: 48, screen: 13824, fault: 4000, formal: 92160 };
const safe = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** Create once with exclusive creation. Existing or interrupted ledgers must never reset. */
export function initializeBudget(path: string): Budget {
  const value: Budget = { version: 1, totalLimit: 150000, externalActual: 6, allocations: { S: { reserved: 360, actual: 0 }, integration: { reserved: 3000, actual: 0 } }, groups: { preflight: 0, screen: 0, fault: 0, formal: 0 }, pActual: 0, windows: {}, windowGroups: {} };
  const fd = openSync(path, 'wx'); try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); } return value;
}

/** A stale or contested lock fails closed. A crash during writing leaves invalid JSON, also failing closed. */
function update(path: string, fn: (value: Budget) => void): Budget {
  const lock = `${path}.lock`; const lockFd = openSync(lock, 'wx');
  try {
    const value: Budget = JSON.parse(readFileSync(path, 'utf8'));
    if (value.version !== 1 || value.totalLimit !== 150000 || value.externalActual !== 6 || value.allocations?.S?.reserved !== 360 || value.allocations?.integration?.reserved !== 3000 || !safe(value.allocations.S.actual) || value.allocations.S.actual > 360 || !safe(value.allocations.integration.actual) || value.allocations.integration.actual > 3000 || !safe(value.pActual) || !value.groups || !value.windows || !value.windowGroups || typeof value.windows !== 'object' || Object.keys(value.windowGroups).length !== Object.keys(value.windows).length || Object.entries(value.windows).some(([window, n]) => !safe(n) || !Object.hasOwn(caps, value.windowGroups[window])) || Object.values(value.windows).reduce((a, b) => a + b, 0) !== value.pActual || (Object.keys(caps) as BudgetGroup[]).some(group => !safe(value.groups[group]) || value.groups[group] > caps[group] || Object.entries(value.windows).filter(([window]) => value.windowGroups[window] === group).reduce((n, [, count]) => n + count, 0) !== value.groups[group]) || value.externalActual + 360 + 3000 + value.pActual > value.totalLimit) throw new Error('corrupt budget');
    fn(value);
    const fd = openSync(path, 'w'); try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); } return value;
  } finally { closeSync(lockFd); unlinkSync(lock); }
}

/** Reserve synchronously immediately before each P HTTP attempt, including retries. */
export function reserveAttempt(path: string, window: string, totalLimit: number, windowLimit: number, group: BudgetGroup = 'screen'): Budget {
  if (!/^[a-zA-Z0-9/_-]+$/.test(window) || window === '__proto__' || !Number.isSafeInteger(totalLimit) || totalLimit < 1 || totalLimit > 150000 || !Number.isSafeInteger(windowLimit) || windowLimit < 1 || windowLimit > 512 || !Object.hasOwn(caps, group)) throw new Error('invalid budget');
  return update(path, value => {
    const used = Object.hasOwn(value.windows, window) ? value.windows[window] : 0;
    if (used && value.windowGroups[window] !== group) throw new Error('window group mismatch');
    if (value.externalActual + 360 + 3000 + value.pActual >= Math.min(value.totalLimit, totalLimit) || used >= windowLimit || value.groups[group] >= caps[group]) throw new Error('budget exhausted');
    value.pActual++; value.groups[group]++; value.windows[window] = used + 1; value.windowGroups[window] = group;
  });
}

/** S and integration consume their pre-reserved allocation; it is never granted to P. */
export function reserveAllocatedAttempt(path: string, allocation: 'S' | 'integration'): Budget {
  if (allocation !== 'S' && allocation !== 'integration') throw new Error('invalid allocation');
  return update(path, value => { const part = value.allocations[allocation]; if (part.actual >= part.reserved) throw new Error('budget exhausted'); part.actual++; });
}
