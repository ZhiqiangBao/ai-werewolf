import { expect, it } from 'vitest';
import { DEAL12, TestGame } from '../../engine/test/harness';
import { PassiveQueue, type Job } from '../src/experiments/passive-queue';

it('uses a real engine window to reject a delayed stub result after that window changes', async () => {
  const game = new TestGame({ deal: DEAL12, seed: 'obs-standard12-001' });
  const seat = game.waiting()[0]; const original = game.state.pending!.id; let release!: () => void;
  const delay = new Promise<void>(r => { release = r; }); let commits = 0; let asked = 0;
  const queue = new PassiveQueue(async () => { await delay; return { auto: true }; }, j => game.state.pending?.id === j.window, () => { asked++; }, () => { commits++; game.auto(seat); });
  const input: Job = { seat: String(seat), from: 0, through: game.view(seat).version, cue: original, window: original, generation: 0, kind: 'action', projection: JSON.stringify(game.view(seat)) };
  const result = queue.enqueue(input);
  while (game.state.pending?.id === original) game.auto(game.waiting()[0]);
  const before = JSON.stringify({ state: game.state, events: game.events }); release();
  expect((await result).status).toBe('expired'); expect(commits).toBe(0); expect(asked).toBe(1);
  expect(JSON.stringify({ state: game.state, events: game.events })).toBe(before);
});
