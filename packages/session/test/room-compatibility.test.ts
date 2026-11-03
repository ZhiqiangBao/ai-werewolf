import aiInvariantGolden from './fixtures/room-p2-invariants.json';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { defaultGameTiming, type Projection } from '@werewolf/protocol';
import { buildRules, createGame } from '@werewolf/engine';
import { mockAdapter, mockDecision, type Adapter } from '@werewolf/llm';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

// Generated from git revision ea8e7f7's manager with this same scenario.
const golden: Record<string, string> = {
  legacy: '05af15a7056fa046be733d2f7634428df03ce958f6f29fe73811d0b68520647f',
  modern: 'eff9be2a42273b58095cfd08452624bfb046eb1b5505a282866381d9222f5ee4',
};

// New data-version and client-completion metadata is excluded explicitly;
// all pre-existing facts, model messages and timing fields remain in the golden.
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'dataVersion' && key !== 'canStop')
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key,
      normalize(key === 'agenda' && Array.isArray(value) ? value.filter((step) => step.type !== 'night:abilities') : value)]));
}
const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');

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
  // 该基线来自死亡流程版本出现前的房间，恢复时不套用新局的结算规则。
  delete rules.deathResolutionVersion;
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
    const digest = createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
    expect(digest).toBe(golden[modern ? 'modern' : 'legacy']);
  });
}

// Original whole-record golden passed at b217704 before extracting the immutable component hashes.
// See fixtures/room-p2-invariants.json: only completed-seat listen calls and their audit IDs may change.
async function aiScenario(Manager: typeof RoomManager, modern: boolean) {
  const now = 100_000;
  const store = new MemoryStore();
  const secrets = SecretBox.ephemeral();
  const requests: { seat: number; purpose: string; projection?: Projection; [key: string]: unknown }[] = [];
  let injected = false;
  const adapter: Adapter = {
    async decide(req) {
      const { apiKey: _apiKey, ...config } = req.config;
      requests.push(structuredClone({ seat: req.seat, purpose: req.toolChoice === 'auto' ? 'listen' : 'action',
        cacheKey: req.cacheKey, messages: req.messages, projection: req.projection, tools: req.tools, config }));
      if (req.toolChoice !== 'auto' && !injected) {
        injected = true;
        return { ok: true, call: { tool: 'invalid_compatibility_tool', args: {} },
          assistant: { role: 'assistant', content: 'invalid_compatibility_tool' }, toolCallIds: [], latencyMs: 0 };
      }
      return mockAdapter.decide(req);
    },
  };
  const options = { store, secrets, tickMs: 0, now: () => now, sleep: async () => {}, adapters: { mock: adapter } };
  const initial = new Manager(options);
  initial.createRoom();
  initial.dispose();
  const rec = store.loadAll()[0];
  store.rooms.clear();
  const rules = buildRules('standard12');
  delete rules.deathResolutionVersion;
  const { state, events } = createGame({ id: 'fixed-ai-room', rules, seed: 'fixed-ai-seed' });
  Object.assign(rec, {
    id: 'fixed-ai-room', hostToken: 'host', spectatorToken: 'spectator',
    seatTokens: Array.from({ length: 12 }, (_, i) => `seat-${i + 1}`),
    createdAt: now, seed: 'fixed-ai-seed', rules, state, events, actions: [], deadlines: {},
    status: 'running', paused: true, aiPacingMs: 0,
  });
  if (modern) {
    rec.timing = defaultGameTiming();
    for (const value of Object.values(rec.timing)) value.intervalMs = 0;
    rec.timing.speech.limitSec = 17;
    rec.timing.vote.limitSec = 11;
    rec.timing.skill.limitSec = 13;
  } else delete rec.timing;
  store.save(rec);
  const manager = new Manager(options);
  const tokens = ['host', 'spectator', ...rec.seatTokens];
  const notices: number[][] = tokens.map(() => []);
  const unsubscribe = tokens.map((token, i) => manager.subscribe(rec.id, token, (n) => notices[i].push(n)));
  manager.control(rec.id, 'host', 'resume');
  await manager.whenIdle(rec.id);
  expect(manager.view(rec.id, 'host').room.status).toBe('ended');
  expect(injected).toBe(true);
  const views = tokens.map((token) => manager.view(rec.id, token));
  const audit = manager.audit(rec.id, 'host');
  expect(audit.some((entry) => entry.purpose === 'action' && entry.attempt === 2)).toBe(true);
  for (const close of unsubscribe) close();
  manager.dispose();
  const saved = store.loadAll()[0];
  return { requests, views, notices, audit, threads: saved.threads, state: saved.state, events: saved.events, actions: saved.actions };
}

for (const modern of [false, true]) {
  it(`matches pre-refactor AI requests and context with ${modern ? 'modern' : 'legacy'} timing`, async () => {
    const value = await aiScenario(RoomManager, modern);
    const expected = aiInvariantGolden[modern ? 'modern' : 'legacy'];
    const parts = { events: value.events, actions: value.actions, views: value.views, notices: value.notices,
      actionRequests: value.requests.filter((r) => r.purpose === 'action'),
      livingRequests: value.requests.filter((r) => r.projection?.me?.alive),
      actionAudit: value.audit.filter((r) => r.purpose === 'action').map(({ id: _id, ...row }) => row),
      survivingThreads: value.threads?.filter((t) => value.state!.players[t.seat - 1].alive) };
    for (const [name, part] of Object.entries(parts)) expect(digestOf(part), name).toBe(expected[name as keyof typeof parts]);
    expect(value.requests.length).toBeLessThan(expected.requestCount);
  }, 30000);
}
