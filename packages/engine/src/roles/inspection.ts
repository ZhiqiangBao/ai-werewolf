import type { IdentityKnowledge, Seat, ToolSpec } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { getRole } from '../registry';
import { seatParam } from '../tools';
import { seatLabel } from '../text';

export interface RoleCheck { night: number; target: Seat; role: string }

export const INSPECTION_PRIVACY_RULE = '法官只向查验者私密反馈查验结果，不向被查验者通知查验行为或结果；未收到通知不代表没有被查验。';

export const roleChecks = (ctx: Ctx, seat: Seat): RoleCheck[] => ctx.player(seat).data.roleChecks ?? [];
export const inspectionTargets = (ctx: Ctx, seat: Seat): Seat[] =>
  ctx.alive().filter((s) => s !== seat && !roleChecks(ctx, seat).some((c) => c.target === s));

export function mirrorTool(seats: Seat[]): ToolSpec {
  return {
    name: 'mirror_inspect', title: '查验具体身份',
    description: '法官允许使用魔镜查验时，查验一名其他存活且自己从未查验过的玩家。targetSeat 为真实整数座位号，例：{"targetSeat":3}。结果仅自己可见。觉醒隐狼模仿后显示模仿身份，查验表现不保证真实阵营；不能查自己、重复查验或传 null。',
    params: [seatParam('targetSeat', '查验目标', seats)],
  };
}

export function inspectRole(ctx: Ctx, seat: Seat, target: Seat | null): void {
  if (target === null) {
    ctx.priv([seat], 'mirror.skip', '本夜没有查验。');
    return;
  }
  const mod = ctx.roleOf(target);
  const role = mod.inspectRole?.(ctx, target) ?? mod.id;
  const check: RoleCheck = { night: ctx.state.day, target, role };
  (ctx.player(seat).data.roleChecks ??= []).push(check);
  const roleName = getRole(role).name;
  ctx.priv([seat], 'mirror.result', `查验结果：${seatLabel(target)}的身份表现为${roleName}。`, { target, role, roleName });
  ctx.state.night?.lines.push(`魔镜查验（${seatLabel(seat)}）查验 ${seatLabel(target)}：${roleName}`);
}

export function inspectionKnowledge(ctx: Ctx, seat: Seat): IdentityKnowledge[] {
  return roleChecks(ctx, seat).map((c) => ({ seat: c.target, kind: 'role', role: c.role, roleName: getRole(c.role).name, source: 'inspection' }));
}

export function inspectionAppendix(ctx: Ctx, seat: Seat): string {
  const checks = roleChecks(ctx, seat);
  return checks.length
    ? `你的具体身份查验记录：${checks.map((c) => `第${c.night}夜 ${seatLabel(c.target)}=${getRole(c.role).name}`).join('；')}。这是当时的身份表现，不等于真实阵营。`
    : '你的具体身份查验记录：暂无。';
}
