import { describe, expect, it } from 'vitest';
import { abilityState, migrateGameState, projectSeat, registerRoleDataSchema, replay, roleData, submit, UnsupportedRoleDataVersion } from '../src/index';
import type { GameState } from '../src/index';
import { DEAL12, TestGame } from './harness';

const deal = ['werewolf', 'werewolf', 'werewolf', 'awakened_wolf', 'mirror_maiden', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];
function legacy(state: GameState): GameState {
  const old = structuredClone(state);
  for (const player of old.players) {
    delete player.dataVersion;
    if (player.role === 'awakened_wolf') {
      const learned = roleData(player, 'awakened_wolf').awakened.learned;
      if (learned) {
        const instance = player.abilities!.find((a) => a.id === learned.abilityId)!;
        const { abilityId: _id, ...facts } = learned;
        const skill = { kind: instance.definition, ...instance.state };
        delete (skill as Record<string, unknown>).checks;
        delete (skill as Record<string, unknown>).spent;
        if (instance.definition === 'mirror') player.data.roleChecks = abilityState(instance, 'mirror').checks;
        player.data.awakened = { ...roleData(player, 'awakened_wolf').awakened, learned: { ...facts, skill } };
      }
    }
    delete player.abilities;
  }
  old.agenda = old.agenda.filter((s) => s.type !== 'night:abilities');
  if (old.pending) { delete old.pending.step.abilityId; delete old.pending.step.abilitySeat; }
  return old;
}

describe('角色私有数据版本迁移', () => {
  it('保留已消耗资源、null、旧查验、未知扩展及所有对局事实，迁移纯且幂等', () => {
    const g = new TestGame({ deal: DEAL12 });
    g.night({ kill: 9, poison: 10, guard: null, inspect: 1 });
    const old = legacy(g.state);
    old.players[5].data.extension = { field: '保留' };
    const before = structuredClone(old);
    const migrated = migrateGameState(old);
    expect(old).toEqual(before);
    expect(migrateGameState(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
    expect(roleData(migrated.players[5], 'witch')).toMatchObject({ antidote: true, poison: false, extension: { field: '保留' } });
    expect(roleData(migrated.players[7], 'guard')).toMatchObject({ last: null, log: [{ night: 1, target: null }] });
    expect(roleData(migrated.players[4], 'seer').checks).toEqual(old.players[4].data.checks);
    expect({ ...migrated, players: undefined }).toEqual({ ...old, players: undefined });
    expect(projectSeat(old, g.events, 6)).toEqual(projectSeat(migrated, g.events, 6));
  });

  for (const target of [1, 5, 6, 7, 8, 9]) for (const active of [false, true]) {
    it(`旧模仿目标 ${target}，active=${active} 的库存、启用时间与投影不变`, () => {
      const g = new TestGame({ preset: 'mirror12', deal, values: { 'sheriff.enabled': false } });
      g.ok(4, 'awakened_mimic', { targetSeat: target });
      g.night();
      const instance = g.state.players[3].abilities![0];
      instance.active = active;
      roleData(g.state.players[3], 'awakened_wolf').awakened.learned!.active = active;
      if (instance.definition === 'poison') abilityState(instance, 'poison').available = false;
      if (instance.definition === 'wolf') abilityState(instance, 'wolf').claw = false;
      if (instance.definition === 'guard') abilityState(instance, 'guard').last = 11;
      if (instance.definition === 'mirror') abilityState(instance, 'mirror').checks.push({ night: 1, target: 1, role: 'werewolf' });
      const old = legacy(g.state);
      const before = structuredClone(old);
      const migrated = migrateGameState(old);
      expect(old).toEqual(before);
      expect(migrated.players[3].abilities).toEqual(g.state.players[3].abilities);
      expect(projectSeat(old, g.events, 4)).toEqual(projectSeat(g.state, g.events, 4));
      expect(migrateGameState(migrated)).toEqual(migrated);
      expect(migrated.rules).toEqual(old.rules);
    });
  }

  for (const toolsetVersion of [1, 2] as const) for (const electionVersion of [1, 2, 3] as const) {
    it(`保留工具${toolsetVersion}/竞选${electionVersion}旧技能决策，并与原行动重放相同`, () => {
      const g = new TestGame({ preset: 'mirror12', deal, toolsetVersion, electionVersion, values: { 'sheriff.enabled': false } });
      g.ok(4, 'awakened_mimic', { targetSeat: 6 });
      g.until((x) => x.state.phase !== 'night'); g.toNight();
      g.until((x) => x.pending?.step.type === 'night:awakened_skill');
      const old = legacy(g.state);
      const pending = structuredClone(old.pending);
      const migrated = migrateGameState(old);
      expect(migrated.pending).toEqual(pending);
      expect(migrated.agenda).toEqual(old.agenda);
      const input = { seat: 4, decisionId: pending!.id, call: { tool: 'awakened_poison', args: { targetSeat: 9 } } };
      const fromOld = submit(old, input);
      const fromCurrent = submit(g.state, input);
      expect(fromOld.error).toBeUndefined();
      expect(fromOld).toEqual(fromCurrent);
      const repeated = replay(g.options, [...g.actions, input]);
      expect(repeated.state).toEqual(fromCurrent.state);
      expect(repeated.events).toEqual([...g.events, ...fromCurrent.events]);
    });
  }

  it('扩展角色逐版迁移，保留未知字段；未来版本拒绝且不改变原存档', () => {
    registerRoleDataSchema('role_data_test', { version: 2, migrate(data, from) {
      return from === 0 ? { ...data, counter: 0 } : { ...data, label: 'v2' };
    } });
    const state = new TestGame().state;
    state.players[8].role = 'role_data_test';
    state.players[8].data = { extra: false };
    delete state.players[8].dataVersion;
    const migrated = migrateGameState(state);
    expect(migrated.players[8]).toMatchObject({ dataVersion: 2, data: { extra: false, counter: 0, label: 'v2' } });
    expect(migrateGameState(migrated)).toEqual(migrated);
    state.players[5].dataVersion = 999;
    const before = structuredClone(state);
    expect(() => migrateGameState(state)).toThrow(UnsupportedRoleDataVersion);
    expect(() => submit(state, { seat: 1, call: { tool: '', args: {} }, auto: true })).toThrow(UnsupportedRoleDataVersion);
    expect(state).toEqual(before);
  });

  it('旧复制猎枪、警徽决策原地续接，已展开猎枪的库存迁移为已用', () => {
    const g = new TestGame({ preset: 'mirror12', deal, values: { 'sheriff.enabled': false } });
    g.ok(4, 'awakened_mimic', { targetSeat: 7 });
    g.night({ kill: 4 });
    expect(g.pending?.step.type).toBe('hunter.shoot');
    g.state.sheriff = 4;
    const oldGun = legacy(g.state);
    expect(abilityState(migrateGameState(oldGun).players[3].abilities![0], 'hunter').spent).toBe(true);
    const shot = { seat: 4, decisionId: oldGun.pending!.id, call: { tool: 'hunter_shoot', args: { target: 11 } } };
    expect(submit(oldGun, shot)).toEqual(submit(g.state, shot));
    g.ok(4, 'hunter_shoot', { target: 11 });
    expect(g.pending?.step.type).toBe('badge.duty');
    const oldBadge = legacy(g.state);
    expect(migrateGameState(oldBadge).pending).toEqual(oldBadge.pending);
    const transfer = { seat: 4, decisionId: oldBadge.pending!.id, call: { tool: 'badge_dispose', args: { target: 9 } } };
    expect(submit(oldBadge, transfer)).toEqual(submit(g.state, transfer));
  });

  it('旧复制猎人含毒死亡或未激活时，不把已hooked误迁为用过猎枪', () => {
    const g = new TestGame({ preset: 'mirror12', deal, values: { 'sheriff.enabled': false } });
    g.ok(4, 'awakened_mimic', { targetSeat: 7 });
    g.night({ poison: 4 });
    expect(g.state.deaths.find((d) => d.seat === 4)).toMatchObject({ hooked: true, causes: ['poison'] });
    expect(abilityState(migrateGameState(legacy(g.state)).players[3].abilities![0], 'hunter').spent).toBe(false);
    const old = legacy(g.state);
    const learned = (old.players[3].data.awakened as { learned: { active: boolean } }).learned;
    learned.active = false;
    old.deaths.find((d) => d.seat === 4)!.causes = ['wolf'];
    expect(abilityState(migrateGameState(old).players[3].abilities![0], 'hunter').spent).toBe(false);
  });
});
