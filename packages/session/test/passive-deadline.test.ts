import { expect, it } from 'vitest';
import { closeWithTimeout, settleWithTimeout, Slots, waitWithSignal } from '../src/experiments/passive-loopback';
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
