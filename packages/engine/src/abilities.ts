import { gameText } from '@werewolf/protocol';
import type { IdentityKnowledge, Seat, ToolCall, ToolSpec } from '@werewolf/protocol';
import type { Ctx } from './context';
import type { DeathRecord, RuleError, Step, StepHandler, ToolCatalogContext } from './types';
import type { RoleCheck } from './role-data';
import { getRole } from './registry';

export interface AbilityStateMap {
  none: Record<string, unknown>;
  mirror: { checks: RoleCheck[] };
  poison: { available: boolean };
  guard: { last: Seat | null };
  wolf: { claw: boolean };
  hunter: { spent: boolean };
}
export interface AbilityInstance {
  id: string;
  definition: string;
  version: number;
  state: Record<string, unknown>;
  active: boolean;
  activeFromNight: number;
  activateAfterNight?: number;
  source?: string;
}
/** 定义只保存行为；所有可变资源和时间都在传入的实例中。 */
export interface AbilityDefinition {
  id: string;
  version: number;
  initialState(): Record<string, unknown>;
  catalog?(context: ToolCatalogContext): ToolSpec[];
  tools?(ctx: Ctx, seat: Seat, instance: AbilityInstance): ToolSpec[];
  validate?(ctx: Ctx, seat: Seat, instance: AbilityInstance, call: ToolCall): RuleError | null;
  apply?(ctx: Ctx, seat: Seat, instance: AbilityInstance, call: ToolCall): void;
  fallback?(ctx: Ctx, seat: Seat, instance: AbilityInstance): ToolCall;
  onDeath?(ctx: Ctx, death: DeathRecord, instance: AbilityInstance): Step[];
  knowledge?(ctx: Ctx, seat: Seat, instance: AbilityInstance): IdentityKnowledge[];
  appendix?(ctx: Ctx, seat: Seat, instance: AbilityInstance): string[];
}
const definitions = new Map<string, AbilityDefinition>();
export function registerAbility(definition: AbilityDefinition): void {
  if (definitions.has(definition.id)) throw new Error(`能力定义重复：${definition.id}`);
  definitions.set(definition.id, Object.freeze({ ...definition }));
}
export function getAbility(id: string): AbilityDefinition {
  const definition = definitions.get(id);
  if (!definition) throw new Error(`未注册的能力：${id}`);
  return definition;
}
export function abilityState<K extends keyof AbilityStateMap>(instance: AbilityInstance, kind: K): AbilityStateMap[K] {
  if (instance.definition !== kind) throw new Error(`能力 ${instance.id} 不是 ${kind}`);
  return instance.state as unknown as AbilityStateMap[K];
}
export function findAbility(ctx: Ctx, seat: Seat, id: string): AbilityInstance {
  const instance = ctx.player(seat).abilities?.find((a) => a.id === id);
  if (!instance) throw new Error(`座位 ${seat} 缺少能力 ${id}`);
  if (instance.version !== getAbility(instance.definition).version) throw new Error(`不支持能力版本 ${instance.definition}:${instance.version}`);
  return instance;
}
export function grantAbility(ctx: Ctx, seat: Seat, definition: string,
  options: Omit<AbilityInstance, 'definition' | 'version' | 'state'> & { state?: Record<string, unknown> }): AbilityInstance {
  const def = getAbility(definition);
  if (!(getRole(ctx.player(seat).role).abilityCatalog ?? []).includes(definition)) throw new Error(`身份未声明能力目录：${definition}`);
  const list = ctx.player(seat).abilities ??= [];
  if (list.some((a) => a.id === options.id)) throw new Error(`能力实例重复：${options.id}`);
  const instance: AbilityInstance = { ...options, definition, version: def.version, state: structuredClone(options.state ?? def.initialState()) };
  list.push(instance);
  return instance;
}
export function activateAbilities(ctx: Ctx): void {
  for (const player of ctx.state.players) for (const instance of player.abilities ?? []) {
    if (!instance.active && instance.activateAfterNight !== undefined && ctx.state.day >= instance.activateAfterNight) instance.active = true;
  }
}
export function abilityDeathSteps(ctx: Ctx, death: DeathRecord): Step[] {
  return (ctx.player(death.seat).abilities ?? []).filter((a) => a.active)
    .flatMap((a) => (getAbility(a.definition).onDeath?.(ctx, death, a) ?? [])
      .map((step) => ({ ...step, dutySeat: death.seat, abilitySeat: death.seat, abilityId: a.id })));
}
/** 可叠加：每个步骤绑定持有人及实例；同席同名工具也各自完成一次。 */
export function abilityNightSteps(ctx: Ctx, seats: Seat[], type = 'ability.act'): Step[] {
  return seats.flatMap((seat) => (ctx.player(seat).abilities ?? []).filter((a) => a.active && ctx.state.day >= a.activeFromNight)
    .map((a) => ({ type, abilitySeat: seat, abilityId: a.id })));
}
function binding(ctx: Ctx, step: Step): { seat: Seat; instance: AbilityInstance } {
  const seat = step.abilitySeat as Seat;
  return { seat, instance: findAbility(ctx, seat, step.abilityId as string) };
}
export const abilityAction: StepHandler = {
  run(ctx, step) {
    const { seat, instance } = binding(ctx, step);
    if (!ctx.isAlive(seat) || !instance.active || ctx.state.day < instance.activeFromNight) return;
    const tools = getAbility(instance.definition).tools?.(ctx, seat, instance) ?? [];
    if (!tools.length) return;
    ctx.ask({ step, actors: [seat], tools: () => tools,
      prompt: () => gameText(ctx.rules.locale, "你的模仿技能已经启用，请从本轮合法工具中选择。继承狼刀是另一独立决策。"),
      title: gameText(ctx.rules.locale, "第{0}夜 · 模仿技能", ctx.state.day), publicStage: gameText(ctx.rules.locale, "夜晚") });
  },
  validate(ctx, step, _seat, call) {
    const { seat, instance } = binding(ctx, step);
    return getAbility(instance.definition).validate?.(ctx, seat, instance, call) ?? null;
  },
  decide(ctx, step, subs) {
    const { seat, instance } = binding(ctx, step);
    getAbility(instance.definition).apply?.(ctx, seat, instance, subs[seat]);
  },
  fallback(ctx, step) {
    const { seat, instance } = binding(ctx, step);
    const fallback = getAbility(instance.definition).fallback;
    if (!fallback) throw new Error(`能力 ${instance.definition} 没有托管行动`);
    return fallback(ctx, seat, instance);
  },
};
