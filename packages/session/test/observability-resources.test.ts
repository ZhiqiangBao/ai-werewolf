import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRules, createGame } from '@werewolf/engine';
import { mockAdapter, type Adapter } from '@werewolf/llm';
import { defaultGameTiming, type ObservationEvent } from '@werewolf/protocol';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';
import type { RoomRecord } from '../src/store';

const managers: RoomManager[] = [], tempDirs: string[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(records: string[], adapter: Adapter, events: ObservationEvent[], onEvent?: () => void) {
  const secrets = SecretBox.ephemeral(), initialStore = new MemoryStore();
  const initial = new RoomManager({ store: initialStore, secrets, tickMs: 0 });
  for (const _id of records) initial.createRoom();
  initial.dispose();
  const templates = initialStore.loadAll(), store = new MemoryStore();
  for (const [index, id] of records.entries()) {
    const rec = templates[index] as RoomRecord, rules = buildRules('standard12');
    const { state, events: gameEvents } = createGame({ id, rules, seed: `resource-seed-${id}` });
    const timing = defaultGameTiming();
    for (const value of Object.values(timing)) value.intervalMs = 0;
    Object.assign(rec, { id, hostToken: 'host', spectatorToken: 'spectator', seatTokens: Array.from({ length: 12 }, (_, i) => `seat-${i + 1}`),
      seed: `resource-seed-${id}`, rules, state, events: gameEvents, actions: [], deadlines: {}, status: 'running', paused: true, aiPacingMs: 0, timing });
    store.save(rec);
  }
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-action-resources-')); tempDirs.push(dir);
  const manager = new RoomManager({ store, secrets, tickMs: 0, sleep: async () => {}, adapters: { mock: adapter },
    observability: { mappingPath: join(dir, 'mapping.json'), sink: { emit(event) { events.push(event); onEvent?.(); } } } });
  managers.push(manager);
  return manager;
}

function cachedActions(manager: RoomManager): Map<string, Map<number, unknown>> {
  return (manager as unknown as { runtime: { actionIds: Map<string, Map<number, unknown>> } }).runtime.actionIds;
}

async function settle(condition: () => boolean) {
  for (let i = 0; i < 1000 && !condition(); i++) await Promise.resolve();
  expect(condition()).toBe(true);
}

describe('action observation resources', () => {
  it('bounds action IDs per room and seat over successive decisions and clears finished rooms', async () => {
    const events: ObservationEvent[] = [];
    let manager: RoomManager | undefined, maximum = 0, maxPerRoom = 0;
    manager = setup(['room-a', 'room-b'], mockAdapter, events, () => {
      if (!manager) return;
      const rooms = cachedActions(manager);
      for (const seats of rooms.values()) maxPerRoom = Math.max(maxPerRoom, seats.size);
      maximum = Math.max(maximum, [...rooms.values()].reduce((sum, seats) => sum + seats.size, 0));
    });
    manager.control('room-a', 'host', 'resume'); manager.control('room-b', 'host', 'resume');
    await Promise.all([manager.whenIdle('room-a'), manager.whenIdle('room-b')]);
    const actions = events.filter((event) => event.kind === 'action_segment' && event.phase === 'start');
    expect(new Set(actions.map((event) => event.decisionRef)).size).toBeGreaterThan(5);
    expect(maximum).toBeGreaterThan(0);
    expect(maximum).toBeLessThanOrEqual(24);
    expect(maxPerRoom).toBeLessThanOrEqual(12);
    const idsByRoom = new Map<string, Set<string>>();
    const owners = new Map<string, string>();
    for (const event of actions) {
      const ids = idsByRoom.get(event.roomRef) ?? new Set<string>();
      ids.add(event.actionId!); idsByRoom.set(event.roomRef, ids);
      const owner = `${event.roomRef}:${event.seatRef}:${event.decisionRef}`;
      expect(owners.get(event.actionId!) ?? owner).toBe(owner);
      owners.set(event.actionId!, owner);
    }
    expect(idsByRoom.size).toBe(2);
    const [a, b] = [...idsByRoom.values()];
    expect([...a].every((id) => !b.has(id))).toBe(true);
    expect(cachedActions(manager).size).toBe(0);
  }, 30000);

  it('retains the action ID across pause, resume and a rejected attempt', async () => {
    const events: ObservationEvent[] = [];
    let target: { seat: number; decision: string } | undefined, attempts = 0;
    const adapter: Adapter = { async decide(req) {
      if (req.toolChoice === 'auto' || !req.projection?.task) return mockAdapter.decide(req);
      target ??= { seat: req.seat, decision: req.projection.task.decisionId };
      if (req.seat !== target.seat || req.projection.task.decisionId !== target.decision) return mockAdapter.decide(req);
      attempts++;
      if (attempts === 2) return { ok: true, call: { tool: 'invalid_synthetic_tool', args: {} }, toolCallIds: [], latencyMs: 0 };
      return new Promise(() => {});
    } };
    const manager = setup(['room-pause'], adapter, events);
    manager.control('room-pause', 'host', 'resume');
    await settle(() => attempts === 1);
    manager.control('room-pause', 'host', 'pause');
    await manager.whenIdle('room-pause');
    manager.control('room-pause', 'host', 'resume');
    await settle(() => attempts >= 3);
    const segments = events.filter((event) => event.kind === 'action_segment' && event.phase === 'start' && event.seatRef === `s${target!.seat}`);
    const first = segments[0];
    const matching = segments.filter((event) => event.decisionRef === first.decisionRef);
    expect(matching).toHaveLength(2);
    expect(new Set(matching.map((event) => event.actionId)).size).toBe(1);
    const calls = events.filter((event) => event.kind === 'model_call' && event.phase === 'start' && event.actionId === first.actionId);
    expect(calls).toHaveLength(3);
    expect(events.some((event) => event.kind === 'engine_action' && event.phase === 'end' && event.actionId === first.actionId && event.outcome === 'rejected')).toBe(true);
    manager.control('room-pause', 'host', 'end');
    await manager.whenIdle('room-pause');
    expect(cachedActions(manager).size).toBe(0);
  }, 30000);
});
