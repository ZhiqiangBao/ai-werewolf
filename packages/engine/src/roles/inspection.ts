import { gameText } from '@werewolf/protocol';
import type { IdentityKnowledge, Seat, ToolSpec } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { getRole } from '../registry';
import { seatParam } from '../tools';
import { seatLabel } from '../text';
import { abilityState } from '../abilities';

export interface RoleCheck { night: number; target: Seat; role: string }

export const INSPECTION_PRIVACY_RULE = '结果只私密反馈给查验者，不通知被查验者；没有通知不代表未被查验。';

export const roleChecks = (ctx: Ctx, seat: Seat): RoleCheck[] => (ctx.player(seat).data.roleChecks ?? []) as RoleCheck[];
/** 只供附录聚合；各个技能的复验限制使用自己的 checks。 */
export const allRoleChecks = (ctx: Ctx, seat: Seat): RoleCheck[] => [
  ...roleChecks(ctx, seat),
  ...(ctx.player(seat).abilities ?? []).filter((a) => a.definition === 'mirror').flatMap((a) => abilityState(a, 'mirror').checks),
];
export const inspectionTargets = (ctx: Ctx, seat: Seat): Seat[] =>
  ctx.alive().filter((s) => s !== seat && !roleChecks(ctx, seat).some((c) => c.target === s));

export function mirrorTool(seats: Seat[], locale: string | undefined = 'zh-CN', allowSkip = false): ToolSpec {
  return {
    name: 'mirror_inspect', title: gameText(locale, "查验具体身份"),
    description: gameText(locale, "查验 targetSeat 指定玩家的身份表现。填写目标座位号，例如 {\"targetSeat\":3}。"),
    params: [seatParam('targetSeat', gameText(locale, "查验目标"), seats, allowSkip ? gameText(locale, '本夜不查验') : undefined)],
  };
}

export function inspectRole(ctx: Ctx, seat: Seat, target: Seat | null, checks?: RoleCheck[]): void {
  if (target === null) {
    ctx.priv([seat], 'mirror.skip', gameText(ctx.rules.locale, "本夜没有查验。"));
    return;
  }
  const mod = ctx.roleOf(target);
  const role = mod.inspectRole?.(ctx, target) ?? mod.id;
  const check: RoleCheck = { night: ctx.state.day, target, role };
  (checks ?? (ctx.player(seat).data.roleChecks ??= []) as RoleCheck[]).push(check);
  const roleName = gameText(ctx.rules.locale, getRole(role).name);
  ctx.priv([seat], 'mirror.result', gameText(ctx.rules.locale, "查验结果：{0}的身份表现为{1}。", seatLabel(target, ctx.rules.locale), roleName), { target, role, roleName });
  ctx.state.night?.lines.push(gameText(ctx.rules.locale, "魔镜查验（{0}）查验 {1}：{2}", seatLabel(seat, ctx.rules.locale), seatLabel(target, ctx.rules.locale), roleName));
}

export function inspectionKnowledge(ctx: Ctx, seat: Seat, checks = roleChecks(ctx, seat)): IdentityKnowledge[] {
  return checks.map((c) => ({ seat: c.target, kind: 'role', role: c.role, roleName: gameText(ctx.rules.locale, getRole(c.role).name), source: 'inspection' }));
}

export function inspectionAppendix(ctx: Ctx, seat: Seat, checks = roleChecks(ctx, seat)): string {
  return checks.length
    ? gameText(ctx.rules.locale, "你的具体身份查验记录：{0}。这是当时的身份表现，不等于真实阵营。", checks.map((c) => gameText(ctx.rules.locale, "第{0}夜 {1}={2}", c.night, seatLabel(c.target, ctx.rules.locale), gameText(ctx.rules.locale, getRole(c.role).name))).join('；'))
    : gameText(ctx.rules.locale, "你的具体身份查验记录：暂无。");
}
