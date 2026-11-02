import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { defaultGameTiming, type Projection } from '@werewolf/protocol';
import { buildRules, createGame } from '@werewolf/engine';
import { mockDecision } from '@werewolf/llm';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

// Generated from git revision ea8e7f7's manager with this same scenario.
const golden: Record<string, string> = {
  legacy: '05af15a7056fa046be733d2f7634428df03ce958f6f29fe73811d0b68520647f',
  modern: 'eff9be2a42273b58095cfd08452624bfb046eb1b5505a282866381d9222f5ee4',
};

async function scenario(Manager: typeof RoomManager, modern: boolean) {
  let now = 100_000;
  const store = new MemoryStore();
  const secrets = SecretBox.ephemeral();
  const options = { store, secrets, tickMs: 0, now: () => now, sleep: () => new Promise<void>(() => {}),
    adapters: { mock: { decide: async () => { throw new Error('Unexpected model call'); } } } };
  const initial = new Manager(options);
  initial.createRoom();
  initial.dispose();
  const rec = store.loadAll()[0];
  store.rooms.clear();
  const rules = buildRules('standard12');
  const { state, events } = createGame({ id: 'fixed-room', rules, seed: 'fixed-seed' });
  Object.assign(rec, {
    id: 'fixed-room', hostToken: 'host', spectatorToken: 'spectator',
    seatTokens: Array.from({ length: 12 }, (_, i) => `seat-${i + 1}`),
    createdAt: now, seed: 'fixed-seed', rules, state, events, actions: [], deadlines: {},
    status: 'running', paused: true,
    participants: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, { joined: true, ready: true }])),
  });
  for (const seat of rec.seats) seat.controller = 'human';
  if (modern) {
    rec.timing = defaultGameTiming();
    for (const v of Object.values(rec.timing)) v.intervalMs = 0;
  } else delete rec.timing;
  store.save(rec);
  const manager = new Manager(options);
  const tokens = ['host', 'spectator', ...rec.seatTokens];
  const notices: number[][] = tokens.map(() => []);
  const unsub = tokens.map((token, i) => manager.subscribe(rec.id, token, (n) => notices[i].push(n)));
  const snapshots: unknown[] = [];
  const capture = (label: string) => snapshots.push({ label, views: tokens.map((token) => manager.view(rec.id, token)), notices: structuredClone(notices) });
  capture('paused');
  manager.control(rec.id, 'host', 'resume');
  await manager.whenIdle(rec.id);
  capture('resumed');
  for (let i = 0; i < 4; i++) {
    const actor = rec.seatTokens.map((token) => ({ token, projection: manager.view(rec.id, token).projection as Projection })).find(({ projection }) => projection.task && !projection.task.submitted);
    if (!actor?.projection.task) throw new Error('No pending human action');
    manager.act(rec.id, actor.token, { decisionId: actor.projection.task.decisionId, ...mockDecision(actor.projection, actor.projection.task.tools) });
    await manager.whenIdle(rec.id);
    now += 250;
    capture(`action-${i}`);
    if (i === 1) {
      manager.control(rec.id, 'host', 'pause');
      capture('paused-again');
      now += 5000;
      manager.control(rec.id, 'host', 'resume');
      await manager.whenIdle(rec.id);
      capture('resumed-again');
    }
  }
  manager.control(rec.id, 'host', 'end');
  capture('ended');
  const exported = manager.exportRecord(rec.id, 'host', 'god');
  for (const close of unsub) close();
  manager.dispose();
  const saved = store.loadAll()[0];
  return { snapshots, notices, exported, state: saved.state, events: saved.events, actions: saved.actions };
}

for (const modern of [false, true]) {
  it(`matches the pre-refactor ${modern ? 'modern' : 'legacy'} timing record`, async () => {
    const value = await scenario(RoomManager, modern);
    const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)])) : v;
    const digest = createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
    expect(digest).toBe(golden[modern ? 'modern' : 'legacy']);
  });
}
