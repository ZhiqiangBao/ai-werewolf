import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createGame, buildRules } from '@werewolf/engine';
import { FileStore, MemoryStore, RoomManager, SecretBox } from '../src/index';
import type { RoomRecord } from '../src/store';

function record(id: string): RoomRecord {
  const store = new MemoryStore();
  const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0 });
  const room = manager.createRoom();
  manager.dispose();
  const result = store.loadAll()[0];
  const rules = buildRules('standard12');
  const { state, events } = createGame({ id, rules, seed: 'old-file' });
  for (const player of state.players) delete player.dataVersion;
  Object.assign(result, { id, state, events, rules, status: 'running', paused: true });
  result.hostToken = `${id}-host`;
  result.spectatorToken = `${id}-spectator`;
  for (const seat of result.seats) seat.controller = 'human';
  return result;
}

it('实际文件恢复只迁移私有数据结构，保留原事件、工具决策和历史文件直到显式保存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-role-data-'));
  let manager: RoomManager | undefined;
  try {
    const store = new FileStore(dir);
    const old = record('old-data');
    const witch = old.state!.players.find((p) => p.role === 'witch')!;
    witch.data.antidote = false; witch.data.poison = false;
    const before = structuredClone(old);
    store.save(old);
    const originalFile = readFileSync(join(dir, 'rooms', 'old-data.json'), 'utf8');
    manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0 });
    expect(readFileSync(join(dir, 'rooms', 'old-data.json'), 'utf8')).toBe(originalFile);
    manager.control(old.id, old.hostToken, 'resume');
    await manager.whenIdle(old.id);
    expect(manager.view(old.id, old.hostToken).projection!.events).toEqual(old.events);
    manager.dispose(); await manager.whenDisposed();
    manager = undefined;
    const saved = store.loadAll()[0];
    expect(saved.state!.pending).toEqual(before.state!.pending);
    expect(saved.events).toEqual(before.events);
    expect(saved.actions).toEqual(before.actions);
    expect(saved.state!.players.find((p) => p.role === 'witch')).toMatchObject({ dataVersion: 1, data: { antidote: false, poison: false } });
  } finally { manager?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

it('未来角色或能力版本隔离为暂停房间；仍可看授权历史，不能恢复或单步，也不阻碍其他房间', async () => {
  const store = new MemoryStore();
  const future = record('future-role');
  future.state!.players[0].dataVersion = 999;
  future.paused = false;
  const ability = record('future-ability');
  ability.state!.players[0].abilities = [{ id: 'a', definition: 'poison', version: 999, state: { available: false }, active: true, activeFromNight: 1 }];
  const healthy = record('healthy');
  for (const rec of [future, ability, healthy]) store.save(rec);
  const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0 });
  try {
    manager.resumeAll();
    for (const rec of [future, ability]) {
      expect(manager.view(rec.id, rec.hostToken).room.paused).toBe(true);
      expect(manager.view(rec.id, rec.spectatorToken).projection!.events.every((e) => e.audience === 'public')).toBe(true);
      expect(manager.view(rec.id, rec.seatTokens[0]).projection!.task).toBeNull();
      expect(manager.view(rec.id, rec.seatTokens[0]).projection!.me!.appendix).toContain('不支持');
      expect(() => manager.control(rec.id, rec.hostToken, 'resume')).toThrow('版本');
      expect(() => manager.control(rec.id, rec.hostToken, 'step')).toThrow('版本');
    }
    manager.control(healthy.id, healthy.hostToken, 'resume');
    expect(manager.view(healthy.id, healthy.hostToken).room.paused).toBe(false);
  } finally { manager.dispose(); await manager.whenDisposed(); }
  expect(store.loadAll().find((r) => r.id === future.id)!.state!.players[0].dataVersion).toBe(999);
  expect(store.loadAll().find((r) => r.id === ability.id)!.state!.players[0].abilities![0].version).toBe(999);
});
