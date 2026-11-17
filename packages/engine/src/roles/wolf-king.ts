import { gameText } from '@werewolf/protocol';
import type { Seat, ToolSpec } from '@werewolf/protocol';
import { evaluateWin } from '../flow/win';
import { seatParam } from '../tools';
import type { RoleModule } from '../types';
import { hunterCanShootOnShot, resolveShot } from './hunter';
import { werewolf } from './werewolf';

function shootTool(targets: Seat[], locale?: string): ToolSpec {
  return {
    name: 'wolf_king_shoot', title: gameText(locale, '狼王开枪'),
    description: gameText(locale, '开枪带走一名存活玩家并亮出狼王牌，或放弃开枪。'),
    params: [seatParam('target', gameText(locale, '开枪目标'), targets, gameText(locale, '放弃开枪'))],
  };
}

export const wolfKing: RoleModule = {
  id: 'wolf_king',
  name: '狼王',
  faction: 'wolf',
  category: 'wolf',
  maxPerGame: 1,
  inspectAs: 'wolf',
  wolfTeam: true,
  canExplode: true,
  nightPhase: werewolf.nightPhase,
  summary: '参加狼队密谈和落刀。符合条件出局后可开枪带走一名存活玩家，开枪或自爆时公开狼王牌。',
  tools: (context) => [...werewolf.tools!(context), shootTool(context.seats.filter((s) => s !== context.seat), context.rules.locale)],
  setup(ctx, seats) {
    if (!ctx.rules.roles.includes('werewolf')) werewolf.setup?.(ctx, seats);
  },
  appendix(ctx, seat) {
    return [
      ...(werewolf.appendix?.(ctx, seat) ?? []),
      gameText(ctx.rules.locale, '胜负未分且符合本局死因条件时，法官会私下询问你是否开枪。中毒或自爆出局时不能开枪。'),
    ];
  },
  onDeath(ctx, death) {
    const causes = death.causes;
    if (causes.includes('poison') || causes.includes('explode')) return [];
    const canShoot = causes.includes('wolf') || causes.includes('guard_and_save') || causes.includes('exile') ||
      (causes.includes('shot') && hunterCanShootOnShot(ctx.rules));
    return canShoot ? [{ type: 'wolf_king.shoot', seat: death.seat, batch: death.batch }] : [];
  },
  steps: {
    'wolf_king.shoot': {
      run(ctx, step) {
        if (ctx.rules.deathResolutionVersion !== 2 && evaluateWin(ctx)) return;
        const seat = step.seat as Seat;
        const targets = ctx.alive();
        if (!targets.length) return;
        ctx.ask({
          step, actors: [seat],
          tools: () => [shootTool(targets, ctx.rules.locale)],
          prompt: () => gameText(ctx.rules.locale, '你已出局，可以开枪带走一名存活玩家并亮出狼王牌，也可以放弃。'),
          title: gameText(ctx.rules.locale, '第{0}天 · 狼王开枪', ctx.state.day),
          publicStage: gameText(ctx.rules.locale, '法官结算中'),
        });
      },
      decide(ctx, step, subs) {
        const seat = step.seat as Seat;
        resolveShot(ctx, step, seat, subs[seat].args.target as Seat | null, 'wolf_king');
      },
      fallback: () => ({ tool: 'wolf_king_shoot', args: { target: null } }),
    },
  },
};
