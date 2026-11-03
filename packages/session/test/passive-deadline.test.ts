import { expect, it } from 'vitest';
import { closeWithTimeout, safeFailure, settleWithTimeout, Slots, waitWithSignal } from '../src/experiments/passive-loopback';
import { sourceRunId } from '../src/experiments/passive-source';
import type { Server } from 'node:http';

it('cancels slot waiters and a never-resolving dispatch without waiting for late rejection', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const slots = new Slots(1); const occupied = slots.use(() => gate); const controller = new AbortController();
  const waiting = slots.use(async () => 'must not dispatch', controller.signal);
  const never = waitWithSignal(new Promise<void>((_resolve, reject) => { setTimeout(() => reject(new Error('late')), 30); }), controller.signal);
  controller.abort(); await expect(waiting).rejects.toThrow(); await expect(never).rejects.toThrow('cancelled');
  release(); await occupied; await new Promise(resolve => setTimeout(resolve, 40));
});

it('bounds a close callback and a stalled settlement', async () => {
  let forced = false;
  const fake = { close: () => fake, closeAllConnections: () => { forced = true; } } as unknown as Pick<Server, 'close' | 'closeAllConnections'>;
  await expect(closeWithTimeout(fake, 10)).rejects.toThrow('timed out'); expect(forced).toBe(true);
  await expect(settleWithTimeout(new Promise(() => {}), 10)).rejects.toThrow('timed out');
});
it('records only known local failure details without leaking text or secrets', () => {
  const cause = Object.assign(new Error('private cause'), { code: 'EACCES' });
  expect(safeFailure(new TypeError('fetch failed', { cause }))).toEqual({ name: 'TypeError', code: null, causeCode: 'EACCES', message: 'fetch failed' });
  expect(JSON.stringify(safeFailure(new Error('token=secret https://elsewhere', { cause: { code: 'TOKEN_SECRET' } })))).not.toMatch(/secret|elsewhere|TOKEN/);
});
it('gives the same named window a distinct source-pinned run ID', () => {
  expect(sourceRunId('a'.repeat(64), 'preflight')).not.toBe(sourceRunId('b'.repeat(64), 'preflight'));
  expect(() => sourceRunId('bad', 'preflight')).toThrow();
});
