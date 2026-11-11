import { gameText } from '@werewolf/protocol';
import type { Seat, ToolSpec } from '@werewolf/protocol';
import { abilityState, registerAbility } from './abilities';
import type { AbilityInstance } from './abilities';
import type { Ctx } from './context';
import { roleData } from './role-data';
import { hunter } from './roles/hunter';
import { inspectRole, inspectionKnowledge, inspectionAppendix, mirrorTool } from './roles/inspection';
import { err, seatParam } from './tools';
import { seatLabel } from './text';
import { getRole } from './registry';

const action = (name: string, title: string, description: string, seats?: Seat[], locale: string | undefined = 'zh-CN'): ToolSpec => ({
  name, title, description, params: seats ? [seatParam('targetSeat', gameText(locale, '目标玩家'), seats, undefined)] : [],
});
export const skipSkill = (locale: string | undefined = 'zh-CN') => action('awakened_skip_skill', gameText(locale, '本夜不用模仿技能'), gameText(locale, '本夜不发动模仿技能。无参数，填写 {}。'), undefined, locale);
export const poisonTool = (seats: Seat[], locale: string | undefined = 'zh-CN') => action('awakened_poison', gameText(locale, '使用模仿毒药'), gameText(locale, '对 targetSeat 使用模仿毒药。填写目标座位号，例如 {"targetSeat":3}。'), seats, locale);
export const guardTool = (seats: Seat[], locale: string | undefined = 'zh-CN') => action('awakened_guard', gameText(locale, '使用增强守护'), gameText(locale, '对 targetSeat 使用增强守护。填写目标座位号，例如 {"targetSeat":3}。'), seats, locale);
export const clawTool = (seats: Seat[], locale: string | undefined = 'zh-CN') => action('awakened_claw', gameText(locale, '使用一次额外爪击'), gameText(locale, '对 targetSeat 使用额外爪击。填写目标座位号，例如 {"targetSeat":3}。'), seats, locale);

export const copiedDefinition = (role: string): string => getRole(role).copiedAbility ?? 'none';
const mirrorTargets = (ctx: Ctx, seat: Seat, instance: AbilityInstance) => ctx.alive().filter((s) => s !== seat && !abilityState(instance, 'mirror').checks.some((c) => c.target === s));
const skip = (ctx: Ctx, seat: Seat) => ctx.priv([seat], 'awakened.skip', gameText(ctx.rules.locale, '你本夜未使用模仿技能。'));
function announce(ctx: Ctx, seat: Seat, tool: string, target: Seat): void {
  ctx.priv([seat], 'awakened.skill', gameText(ctx.rules.locale, '你对{0}使用了{1}。', seatLabel(target, ctx.rules.locale), tool === 'awakened_poison' ? gameText(ctx.rules.locale, '模仿毒药') : tool === 'awakened_guard' ? gameText(ctx.rules.locale, '增强守护') : gameText(ctx.rules.locale, '额外爪击')), { tool, target });
  ctx.state.night!.lines.push(gameText(ctx.rules.locale, '觉醒隐狼（{0}）{1}：{2}', seatLabel(seat, ctx.rules.locale), tool, seatLabel(target, ctx.rules.locale)));
}
const fallback = () => ({ tool: 'awakened_skip_skill', args: {} });
registerAbility({ id: 'none', version: 1, initialState: () => ({}) });
registerAbility({
  id: 'mirror', version: 1, initialState: () => ({ checks: [] }), catalog: ({ seats, rules }) => [mirrorTool(seats, rules.locale, rules.inspectionVersion === 2)],
  tools: (ctx, seat, instance) => mirrorTargets(ctx, seat, instance).length ? [mirrorTool(mirrorTargets(ctx, seat, instance), ctx.rules.locale, ctx.rules.inspectionVersion === 2)] : [],
  validate: (ctx, _seat, instance, call) => abilityState(instance, 'mirror').checks.some((c) => c.target === call.args.targetSeat) ? err('MIRROR_REPEAT', gameText(ctx.rules.locale, '魔镜查验不能重复选择同一玩家')) : null,
  apply: (ctx, seat, instance, call) => inspectRole(ctx, seat, call.args.targetSeat as Seat | null, abilityState(instance, 'mirror').checks),
  fallback: () => ({ tool: 'mirror_inspect', args: { targetSeat: null } }),
  knowledge: (ctx, seat, instance) => inspectionKnowledge(ctx, seat, abilityState(instance, 'mirror').checks),
  appendix: (ctx, seat, instance) => [inspectionAppendix(ctx, seat, abilityState(instance, 'mirror').checks)],
});
registerAbility({
  id: 'poison', version: 1, initialState: () => ({ available: true }), catalog: ({ seats, rules }) => [poisonTool(seats, rules.locale), skipSkill(rules.locale)],
  tools: (ctx, seat, instance) => abilityState(instance, 'poison').available ? [poisonTool(ctx.alive().filter((s) => s !== seat), ctx.rules.locale), skipSkill(ctx.rules.locale)] : [],
  apply(ctx, seat, instance, call) {
    if (call.tool === 'awakened_skip_skill') { skip(ctx, seat); return; }
    abilityState(instance, 'poison').available = false;
    const target = call.args.targetSeat as Seat;
    ctx.state.night!.attacks.push({ target, kind: 'poison', by: [seat] });
    announce(ctx, seat, call.tool, target);
  }, fallback,
});
registerAbility({
  id: 'guard', version: 1, initialState: () => ({ last: null }), catalog: ({ seats, rules }) => [guardTool(seats, rules.locale), skipSkill(rules.locale)],
  tools: (ctx, _seat, instance) => [guardTool(ctx.alive().filter((s) => s !== abilityState(instance, 'guard').last), ctx.rules.locale), skipSkill(ctx.rules.locale)],
  apply(ctx, seat, instance, call) {
    const state = abilityState(instance, 'guard');
    if (call.tool === 'awakened_skip_skill') { state.last = null; skip(ctx, seat); return; }
    const target = call.args.targetSeat as Seat;
    state.last = target;
    ctx.state.night!.protections.push({ target, kind: 'awakened_guard', blocks: ['wolf', 'poison'], by: seat });
    announce(ctx, seat, call.tool, target);
  }, fallback,
});
registerAbility({
  id: 'wolf', version: 1, initialState: () => ({ claw: true }), catalog: ({ seats, rules }) => [clawTool(seats, rules.locale), skipSkill(rules.locale)],
  tools: (ctx, seat, instance) => abilityState(instance, 'wolf').claw && (instance.source !== 'awakened_mimic' ||
    (ctx.player(seat).role === 'awakened_wolf' && roleData(ctx.player(seat), 'awakened_wolf').awakened.knifeFromNight !== null))
    ? [clawTool(ctx.alive().filter((s) => ctx.opt<boolean>('wolf.allowTeammateTarget') || ctx.roleOf(s).faction !== 'wolf'), ctx.rules.locale), skipSkill(ctx.rules.locale)] : [],
  apply(ctx, seat, instance, call) {
    if (call.tool === 'awakened_skip_skill') { skip(ctx, seat); return; }
    abilityState(instance, 'wolf').claw = false;
    const target = call.args.targetSeat as Seat;
    ctx.state.night!.attacks.push({ target, kind: 'wolf', by: [seat] });
    announce(ctx, seat, call.tool, target);
  }, fallback,
});
registerAbility({
  id: 'hunter', version: 1, initialState: () => ({ spent: false }), catalog: hunter.tools,
  onDeath(ctx, death, instance) {
    const state = abilityState(instance, 'hunter');
    if (state.spent) return [];
    const steps = hunter.onDeath?.(ctx, death) ?? [];
    if (steps.length) state.spent = true;
    return steps.map((step) => ({ ...step, abilityId: instance.id }));
  },
});
