import type { Seat } from '@werewolf/protocol';
import { seatLabel } from '../text';
import { seatParam } from '../tools';
import type { DeathRecord, RoleModule } from '../types';

const bool = (key: string, label: string, def: boolean) => ({
  key,
  group: '猎人',
  label,
  type: 'boolean' as const,
  default: def,
  editable: false,
});

export const hunter: RoleModule = {
  id: 'hunter',
  name: '猎人',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '出局时（死因不含毒药）可以开枪带走一名存活玩家，也可以放弃。',
  options: [
    bool('hunter.shootOnKnife', '被狼刀出局可以开枪', true),
    bool('hunter.shootOnVote', '被放逐可以开枪', true),
    bool('hunter.shootOnPoison', '死因含毒药可以开枪', false),
    bool('hunter.shootOnGuardAndSave', '同守同救出局可以开枪', true),
    bool('hunter.declineReveals', '放弃开枪公开身份', false),
  ],

  ruleCard(rules) {
    const v = rules.values;
    const can = [
      v['hunter.shootOnKnife'] && '被狼刀',
      v['hunter.shootOnVote'] && '被放逐',
      v['hunter.shootOnGuardAndSave'] && rules.roles.includes('guard') && '同守同救',
    ].filter(Boolean);
    return [
      `猎人：${can.join('、')}出局时可以开枪带走一名存活玩家，也可以放弃。` +
        (v['hunter.shootOnPoison'] ? '' : '死因里包含毒药时不能开枪。') +
        `开枪会公开猎人身份；${v['hunter.declineReveals'] ? '放弃开枪也会公开身份。' : '放弃开枪不公开身份。'}`,
    ];
  },

  appendix: () => ['你出局时如果死因不含毒药，法官会私下询问你是否开枪。开枪会公开你的身份。'],

  onDeath(ctx, death: DeathRecord) {
    const c = death.causes;
    const opt = (k: string) => ctx.opt<boolean>(k);
    if (c.includes('poison') && !opt('hunter.shootOnPoison')) return [];
    const allowed =
      (c.includes('wolf') && opt('hunter.shootOnKnife')) ||
      (c.includes('guard_and_save') && opt('hunter.shootOnGuardAndSave')) ||
      (c.includes('exile') && opt('hunter.shootOnVote')) ||
      (c.includes('poison') && opt('hunter.shootOnPoison'));
    return allowed ? [{ type: 'hunter.shoot', seat: death.seat, batch: death.batch }] : [];
  },

  steps: {
    'hunter.shoot': {
      run(ctx, step) {
        const seat = step.seat as Seat;
        const targets = ctx.alive().filter((x) => x !== seat);
        if (!targets.length) return;
        ctx.ask({
          step,
          actors: [seat],
          tools: () => [
            {
              name: 'hunter_shoot',
              title: '开枪',
              description: '带走一名存活玩家，或放弃开枪。开枪会公开你的猎人身份。',
              params: [seatParam('target', '开枪目标', targets, '放弃开枪')],
            },
          ],
          prompt: () => '你已出局，可以开枪带走一名存活玩家，也可以放弃。',
          title: `第${ctx.state.day}天 · 猎人开枪`,
          publicStage: '法官结算中',
        });
      },
      decide(ctx, step, subs) {
        const seat = step.seat as Seat;
        const target = (subs[seat].args.target as Seat | null) ?? null;
        if (target === null) {
          ctx.priv([seat], 'hunter.decline', '你放弃了开枪。', {});
          if (ctx.opt<boolean>('hunter.declineReveals')) {
            ctx.player(seat).revealed = true;
            ctx.pub('hunter.decline', `${seatLabel(seat)}是猎人，放弃开枪。`, { seat });
          }
          return;
        }
        const own = ctx.state.deaths.find((d) => d.seat === seat);
        ctx.player(seat).revealed = true;
        ctx.kill(target, {
          via: 'shot',
          causes: ['shot'],
          by: seat,
          shooterVia: own?.via,
          batch: step.batch as number,
        });
        ctx.state.history.shots.push(`第${ctx.state.day}天 ${seatLabel(seat)}开枪带走${seatLabel(target)}`);
        ctx.pub('hunter.shot', `${seatLabel(seat)}开枪，${seatLabel(target)}出局。`, { shooter: seat, target, role: 'hunter' });
      },
      fallback: () => ({ tool: 'hunter_shoot', args: { target: null } }),
    },
  },
};
