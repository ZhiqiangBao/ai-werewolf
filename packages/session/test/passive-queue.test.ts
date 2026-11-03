import { expect, it } from 'vitest';
import { PassiveQueue, type Job } from '../src/experiments/passive-queue';

const job = (seat: string, through: number, kind: Job['kind'] = 'listen', generation = 0): Job => ({ seat, from: through, through, cue: 'cue', window: 'w1', generation, kind, projection: 'immutable' });
it('serializes each seat, lets other seats progress, and marks action only on dispatch', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const events: string[] = [];
  const q = new PassiveQueue(async j => { events.push(`start ${j.seat}/${j.through}`); if (j.seat === '1' && j.through === 1) await gate; events.push(`end ${j.seat}/${j.through}`); }, () => true, j => events.push(`asked ${j.seat}`));
  const a = q.enqueue(job('1', 1)); const b = q.enqueue(job('1', 2, 'action')); const c = q.enqueue(job('2', 1));
  await c; expect(events).not.toContain('asked 1'); expect(events).toContain('end 2/1');
  release(); await Promise.all([a, b]); expect(events.indexOf('end 1/1')).toBeLessThan(events.indexOf('asked 1'));
});
it('rejects the 33rd pending operation without dropping any accepted job', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const q = new PassiveQueue(async () => gate, () => true, () => {});
  const pending = Array.from({ length: 32 }, (_, i) => q.enqueue(job('1', i + 1)));
  expect(() => q.enqueue(job('1', 33))).toThrow('high water'); release(); await Promise.all(pending); expect(q.results).toHaveLength(32);
});
it('isolates late completion after pause and rejects an expired action', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let valid = true; let asked = 0;
  const q = new PassiveQueue(async () => gate, () => valid, () => { asked++; });
  const inFlight = q.enqueue(job('1', 1)); const waiting = q.enqueue(job('1', 2)); q.pause();
  expect((await waiting).status).toBe('cancelled'); release(); expect((await inFlight).status).toBe('cancelled'); expect(q.results).toHaveLength(0);
  q.resume(); valid = false; expect((await q.enqueue(job('1', 3, 'action', q.currentGeneration()))).status).toBe('expired'); expect(asked).toBe(0);
});
it('starts the action clock only after its required prior listen finishes', async () => {
  let now = 10; let askedAt = -1; let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const q = new PassiveQueue(async j => { if (j.kind === 'listen') await gate; }, () => true, () => { askedAt = now; });
  const listen = q.enqueue(job('1', 1)); const action = q.enqueue(job('1', 2, 'action'));
  now = 510; expect(askedAt).toBe(-1); release(); await Promise.all([listen, action]); expect(askedAt).toBe(510);
});
