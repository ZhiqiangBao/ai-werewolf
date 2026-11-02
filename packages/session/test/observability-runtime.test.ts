import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRules, createGame } from '@werewolf/engine';
import { mockAdapter, mockDecision, type Adapter, type DecideRequest, type DecideResult } from '@werewolf/llm';
import { defaultGameTiming, type ObservationEvent, type Projection } from '@werewolf/protocol';
import { DEAL12, TestGame } from '../../engine/test/harness';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';
import type { RoomRecord } from '../src/store';

const managers: RoomManager[] = [];
const tempDirs: string[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const secrets = SecretBox.ephemeral();
const clock = () => { let n = 1000; return { monotonicMs: () => n++, wallTimeMs: () => 5000 }; };
const mappingPath = () => { const dir = mkdtempSync(join(tmpdir(), 'werewolf-observation-runtime-')); tempDirs.push(dir); return join(dir, 'mapping.json'); };

function fixedRecord(id = 'fixed-room'): RoomRecord {
  const store = new MemoryStore();
  const initial = new RoomManager({ store, secrets, tickMs: 0 });
  initial.createRoom(); initial.dispose();
  const rec = store.loadAll()[0];
  const rules = buildRules('standard12');
  const { state, events } = createGame({ id, rules, seed: 'fixed-observation-seed' });
  Object.assign(rec, { id, hostToken: 'private-host-token', spectatorToken: 'private-spectator-token',
    seatTokens: Array.from({ length: 12 }, (_, i) => `private-seat-token-${i + 1}`),
    createdAt: 100_000, seed: 'fixed-observation-seed', rules, state, events, actions: [], deadlines: {},
    status: 'running', paused: true, aiPacingMs: 0, timing: defaultGameTiming() });
  for (const timing of Object.values(rec.timing!)) timing.intervalMs = 0;
  for (const seat of rec.seats) {
    seat.controller = 'ai'; seat.adapter = 'mock'; seat.baseUrl = 'https://private-provider.example/private-path?key=private-query'; seat.model = 'private-model';
  }
  return rec;
}

function managerFor(records: RoomRecord[], adapter: Adapter, sink?: { emit(event: ObservationEvent): void }) {
  const store = new MemoryStore(); for (const record of records) store.save(record);
  const manager = new RoomManager({ store, secrets, tickMs: 0, now: () => 100_000, sleep: async () => {}, adapters: { mock: adapter },
    ...(sink ? { observability: { clock: clock(), sink, mappingPath: mappingPath() } } : {}) });
  managers.push(manager); return { manager, store };
}

const requestSnapshot = (req: DecideRequest) => structuredClone({ seat: req.seat, projection: req.projection, messages: req.messages,
  tools: req.tools, config: req.config, cacheKey: req.cacheKey, toolChoice: req.toolChoice, stream: req.stream });
const withoutObservations = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutObservations)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'observation').map(([key, item]) => [key, withoutObservations(item)])) : value;
const settle = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await Promise.resolve(); expect(condition()).toBe(true); };
const callEvents = (events: ObservationEvent[]) => events.filter((event) => event.kind === 'model_call');
const assertOneEndPerCall = (events: ObservationEvent[]) => {
  const starts = callEvents(events).filter((event) => event.phase === 'start');
  expect(starts.length).toBeGreaterThan(0);
  for (const start of starts) expect(callEvents(events).filter((event) => event.id === start.id && event.phase === 'end')).toHaveLength(1);
};

describe('room runtime observation', () => {
  it('observation on and off preserve fixed game, audit and request sequences', async () => {
    const rec = fixedRecord();
    async function run(enabled: boolean, throwing = false) {
      const requests: unknown[] = [], events: ObservationEvent[] = [];
      const adapter: Adapter = { async decide(req) { requests.push(requestSnapshot(req)); return mockAdapter.decide(req); } };
      const sink = enabled ? { emit(event: ObservationEvent) { events.push(event); if (throwing) throw new Error('private-sink-error'); } } : undefined;
      const { manager, store } = managerFor([rec], adapter, sink);
      manager.control(rec.id, rec.hostToken, 'resume');
      await manager.whenIdle(rec.id);
      const view = manager.view(rec.id, rec.hostToken);
      const audit = manager.audit(rec.id, rec.hostToken);
      manager.dispose();
      const saved = store.loadAll()[0];
      return { business: withoutObservations({ requests, view, audit, state: saved.state, events: saved.events, actions: saved.actions, threads: saved.threads }), events };
    }
    const disabled = await run(false);
    const enabled = await run(true);
    const failedSink = await run(true, true);
    expect(enabled.business).toEqual(disabled.business);
    expect(failedSink.business).toEqual(disabled.business);
    assertOneEndPerCall(enabled.events);
    expect(JSON.stringify(enabled.events)).not.toMatch(/private-host-token|private-seat-token|private-provider|private-path|private-query|private-model/);
  }, 30000);

  it('isolates two rooms and attributes per-attempt usage to the originating call', async () => {
    const first = fixedRecord('private-room-A'), second = fixedRecord('private-room-B');
    const events: ObservationEvent[] = [];
    const calls = new Map<string, { room: string; input: number }>();
    const adapter: Adapter = { async decide(req) {
      const input = req.cacheKey?.includes('private-room-A') ? 101 : 202;
      if (req.observation) {
        const id = `${req.observation.callId}:attempt`;
        calls.set(req.observation.callId, { room: input === 101 ? 'A' : 'B', input });
        req.observation.emit({ kind: 'http_attempt', phase: 'start', id, httpAttemptId: id, parentId: req.observation.callId, atMs: req.observation.clock.monotonicMs() });
        req.observation.emit({ kind: 'http_attempt', phase: 'end', id, httpAttemptId: id, parentId: req.observation.callId, atMs: req.observation.clock.monotonicMs(), outcome: 'success',
          usage: { inputTokens: input, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, completeness: 'partial', sourceHttpAttemptId: id } });
      }
      return mockAdapter.decide(req);
    } };
    const { manager } = managerFor([first, second], adapter, { emit: (event) => events.push(event) });
    manager.control(first.id, first.hostToken, 'resume'); manager.control(second.id, second.hostToken, 'resume');
    await Promise.all([manager.whenIdle(first.id), manager.whenIdle(second.id)]);
    manager.dispose();
    const attempts = events.filter((event) => event.kind === 'http_attempt' && event.phase === 'end');
    expect(new Set(attempts.map((event) => event.roomRef)).size).toBe(2);
    expect(new Set(attempts.map((event) => event.id)).size).toBe(attempts.length);
    for (const attempt of attempts) expect(attempt.usage?.inputTokens).toBe(calls.get(attempt.callId!)?.input);
    expect(new Set(attempts.map((event) => event.usage?.inputTokens))).toEqual(new Set([101, 202]));
    assertOneEndPerCall(events);
    expect(JSON.stringify(events)).not.toMatch(/private-room|private-provider|private-model|private-query|private-seat-token/);
  }, 30000);

  it.each(['pause', 'end', 'dispose'] as const)('%s closes in-flight calls once and ignores delayed success', async (operation) => {
    const rec = fixedRecord(); const events: ObservationEvent[] = [];
    const pending: { req: DecideRequest; resolve(value: DecideResult): void }[] = [];
    const adapter: Adapter = { decide: (req) => new Promise((resolve) => pending.push({ req, resolve })) };
    const { manager } = managerFor([rec], adapter, { emit: (event) => events.push(event) });
    manager.control(rec.id, rec.hostToken, 'resume');
    await settle(() => pending.length > 0);
    const dispatched = pending.length;
    const initialCallIds = callEvents(events).filter((event) => event.phase === 'start').map((event) => event.id);
    if (operation === 'dispose') manager.dispose(); else manager.control(rec.id, rec.hostToken, operation);
    const recordedAtFinish = events.length;
    if (operation === 'dispose') { for (let i = 0; i < 30; i++) await Promise.resolve(); }
    else await manager.whenIdle(rec.id);
    if (operation !== 'dispose') expect(pending).toHaveLength(dispatched);
    else {
      expect(events).toHaveLength(recordedAtFinish);
      const starts = events.filter((event) => event.phase === 'start');
      for (const start of starts) expect(events.filter((event) => event.id === start.id && event.phase === 'end')).toHaveLength(1);
      for (const id of initialCallIds) expect(callEvents(events).find((event) => event.id === id && event.phase === 'end')?.outcome).toMatch(/^(cancelled|incomplete)$/);
      // Stop the synthetic room after checking the original dispose boundary.
      manager.control(rec.id, rec.hostToken, 'end');
      await manager.whenIdle(rec.id);
    }
    const snapshot = structuredClone(manager.view(rec.id, rec.hostToken).projection!.events);
    const endsBefore = callEvents(events).filter((event) => event.phase === 'end');
    for (const item of pending) item.resolve({ ok: true, call: { tool: 'speak', args: { content: 'private-late-answer' } }, toolCallIds: [], latencyMs: 1 });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(manager.view(rec.id, rec.hostToken).projection!.events).toEqual(snapshot);
    assertOneEndPerCall(events);
    expect(callEvents(events).filter((event) => event.phase === 'end')).toEqual(endsBefore);
    expect(endsBefore.every((event) => operation === 'dispose'
      ? event.outcome === 'incomplete' || (event.outcome === 'cancelled' && event.cancelReason === 'dispose')
      : event.outcome === 'cancelled' && event.cancelReason === operation)).toBe(true);
  });

  it('work cancelled during pacing creates no fictitious model call', async () => {
    const rec = fixedRecord(); delete rec.timing; rec.aiPacingMs = 1000;
    const events: ObservationEvent[] = []; let release!: () => void; let requests = 0;
    const store = new MemoryStore(); store.save(rec);
    const manager = new RoomManager({ store, secrets, tickMs: 0, now: () => 100_000, sleep: () => new Promise<void>((resolve) => { release = resolve; }),
      adapters: { mock: { decide: async () => { requests++; throw new Error('unexpected call'); } } },
      observability: { clock: clock(), mappingPath: mappingPath(), sink: { emit: (event) => events.push(event) } } });
    managers.push(manager); manager.control(rec.id, rec.hostToken, 'resume');
    await settle(() => typeof release === 'function');
    manager.control(rec.id, rec.hostToken, 'pause'); release(); await manager.whenIdle(rec.id);
    expect(requests).toBe(0); expect(callEvents(events)).toHaveLength(0);
    expect(events.some((event) => event.kind === 'work' && event.phase === 'start')).toBe(true);
    expect(events.some((event) => event.kind === 'work' && event.phase === 'end')).toBe(true);
  });

  it('disposal keeps the existing request sequence with observation on and off', async () => {
    const rec = fixedRecord();
    const run = async (enabled: boolean) => {
      const requests: unknown[] = [], events: ObservationEvent[] = [];
      const adapter: Adapter = { decide: (req) => { requests.push({ seat: req.seat, purpose: req.toolChoice }); return new Promise(() => {}); } };
      const { manager } = managerFor([rec], adapter, enabled ? { emit: (event) => events.push(event) } : undefined);
      manager.control(rec.id, rec.hostToken, 'resume'); await settle(() => requests.length > 0);
      manager.dispose(); const eventCount = events.length;
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(events).toHaveLength(eventCount);
      manager.control(rec.id, rec.hostToken, 'end'); await manager.whenIdle(rec.id);
      return requests;
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('decision changes cancel the prior model call without accepting its late result', async () => {
    const game = new TestGame({ deal: DEAL12, values: { 'sheriff.enabled': false }, seed: 'fixed-decision-change' });
    game.night({ kill: null, inspect: 1 });
    game.until((g) => g.waiting().some((s) => g.toolsOf(s).some((t) => t.name === 'speak')) &&
      g.waiting().some((speaker) => g.alive().some((seat) => seat !== speaker && g.view(seat).interrupts.some((t) => t.name === 'wolf_explode'))));
    const speaker = game.waiting().find((s) => game.toolsOf(s).some((t) => t.name === 'speak'))!;
    const wolf = game.alive().find((seat) => seat !== speaker && game.view(seat).interrupts.some((t) => t.name === 'wolf_explode'))!;
    const rec = fixedRecord();
    Object.assign(rec, { rules: game.state.rules, seed: game.state.seed, state: game.state, events: game.events, actions: game.actions, deadlines: {}, heardSeq: game.state.seq,
      threads: [{ seat: speaker, seen: game.state.seq, messages: [] }] });
    for (const seat of rec.seats) seat.controller = seat.seat === speaker ? 'ai' : 'human';
    const observed: ObservationEvent[] = [];
    let pending: { req: DecideRequest; resolve(value: DecideResult): void } | undefined;
    const adapter: Adapter = { decide(req) { return req.toolChoice === 'auto' ? mockAdapter.decide(req) : new Promise((resolve) => { pending = { req, resolve }; }); } };
    const { manager } = managerFor([rec], adapter, { emit: (event) => observed.push(event) });
    manager.control(rec.id, rec.hostToken, 'resume');
    await settle(() => !!pending);
    const projection = manager.view(rec.id, rec.seatTokens[wolf - 1]).projection as Projection;
    expect(manager.act(rec.id, rec.seatTokens[wolf - 1], { decisionId: projection.actionWindowId, tool: 'wolf_explode', args: {} }).ok).toBe(true);
    await manager.whenIdle(rec.id);
    const result = await mockAdapter.decide(pending!.req);
    pending!.resolve(result);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const cancelled = callEvents(observed).filter((event) => event.phase === 'end' && event.cancelReason === 'decision_changed');
    expect(cancelled).toHaveLength(1); expect(cancelled[0].outcome).toBe('cancelled');
    expect(callEvents(observed).filter((event) => event.id === cancelled[0].id && event.phase === 'end')).toHaveLength(1);
  });
});
