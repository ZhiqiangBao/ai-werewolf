import type { Seat } from '@werewolf/protocol';
import type { GameState, PlayerState } from './types';
import type { AbilityInstance } from './abilities';
import { getAbility } from './abilities';
import { canHunterShoot } from './roles/hunter';

export interface RoleCheck { night: number; target: Seat; role: string }
export interface LearnedAbility {
  target: Seat; role: string; learnedNight: number; activeFromNight: number; active: boolean; abilityId: string;
}
/** 可由外部角色通过 declaration merging 扩展，扩展字段不在迁移中删除。 */
export interface RoleDataMap {
  villager: Record<string, unknown>;
  werewolf: Record<string, unknown>;
  hunter: Record<string, unknown>;
  witch: { antidote: boolean; poison: boolean };
  guard: { last: Seat | null; log: { night: number; target: Seat | null }[] };
  seer: { checks: { night: number; target: Seat; result: 'good' | 'wolf' }[] };
  idiot: { flipped: boolean };
  mirror_maiden: { roleChecks: RoleCheck[] };
  awakened_wolf: { awakened: { learned: LearnedAbility | null; knifeFromNight: number | null }; roleChecks: RoleCheck[] };
}

export class UnsupportedRoleDataVersion extends Error {}
export interface RoleDataSchema {
  version: number;
  /** 每一步只补结构，不调用 setup、不产生事件、不重算旧事实。 */
  migrate(data: Record<string, unknown>, from: number, player: PlayerState, state: GameState): Record<string, unknown>;
}
const schemas = new Map<string, RoleDataSchema>();
export function registerRoleDataSchema(role: string, schema: RoleDataSchema): void {
  if (schemas.has(role)) throw new Error(`角色数据重复注册：${role}`);
  schemas.set(role, schema);
}

export function roleData<K extends keyof RoleDataMap>(player: PlayerState, role: K): RoleDataMap[K] {
  if (player.role !== role) throw new Error(`座位 ${player.seat} 不是 ${role}`);
  return player.data as unknown as RoleDataMap[K];
}

const defaults: Record<string, () => Record<string, unknown>> = {
  witch: () => ({ antidote: true, poison: true }), guard: () => ({ last: null, log: [] }),
  seer: () => ({ checks: [] }), idiot: () => ({ flipped: false }), mirror_maiden: () => ({ roleChecks: [] }),
  awakened_wolf: () => ({ awakened: { learned: null, knifeFromNight: null }, roleChecks: [] }),
};
for (const role of ['villager', 'werewolf', 'hunter', ...Object.keys(defaults)]) {
  registerRoleDataSchema(role, {
    version: 1,
    migrate(data, from, player, game) {
      if (from !== 0) throw new Error(`没有 ${role} 数据版本 ${from} 的迁移`);
      const result = { ...(defaults[role]?.() ?? {}), ...data };
      if (role === 'awakened_wolf') {
        const awakened = result.awakened as { learned: (LearnedAbility & { skill?: Record<string, unknown> }) | null; knifeFromNight: number | null };
        const learned = awakened.learned;
        if (learned?.skill) {
          const { kind, ...state } = learned.skill;
          const abilityId = `mimic:${player.seat}`;
          const definition = String(kind);
          if (definition === 'mirror') { state.checks = structuredClone(result.roleChecks); result.roleChecks = []; }
          if (definition === 'hunter') state.spent = learned.active && game.deaths.some((death) =>
            death.seat === player.seat && death.hooked && canHunterShoot(game.rules, death));
          const instance: AbilityInstance = { id: abilityId, definition, version: 1, state,
            active: learned.active, activeFromNight: learned.activeFromNight, activateAfterNight: learned.learnedNight, source: 'awakened_mimic' };
          player.abilities = [...(player.abilities ?? []), instance];
          const { skill: _legacySkill, ...facts } = learned;
          result.awakened = { ...awakened, learned: { ...facts, abilityId } };
        }
      }
      return result;
    },
  });
}

/** 无版本旧数据按 v0 处理。迁移发生时复制；不会改写传入存档、规则、事件或行动。 */
export function migrateGameState(state: GameState): GameState {
  let result = state;
  for (let i = 0; i < state.players.length; i++) {
    const original = state.players[i];
    const schema = schemas.get(original.role);
    const version = original.dataVersion ?? 0;
    if (schema && (!Number.isInteger(version) || version < 0 || version > schema.version)) {
      throw new UnsupportedRoleDataVersion(`不支持 ${original.role} 私有数据版本 ${version}`);
    }
    if (!schema || version === schema.version) continue;
    if (result === state) result = structuredClone(state);
    const player = result.players[i];
    let current = version;
    while (current < schema.version) player.data = schema.migrate(player.data, current++, player, result);
    player.dataVersion = schema.version;
  }
  for (const player of result.players) {
    const ids = new Set<string>();
    for (const instance of player.abilities ?? []) {
      let version: number;
      try { version = getAbility(instance.definition).version; }
      catch { throw new UnsupportedRoleDataVersion(`未注册的存档能力：${instance.definition}`); }
      if (instance.version !== version) throw new UnsupportedRoleDataVersion(`不支持能力 ${instance.definition} 数据版本 ${instance.version}`);
      if (ids.has(instance.id)) throw new UnsupportedRoleDataVersion(`重复的存档能力实例：${instance.id}`);
      ids.add(instance.id);
    }
  }
  return result;
}
