import { gameText } from '@werewolf/protocol';
import type { ToolSpec } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import { seatLabel } from '../text';
import { seatParam } from '../tools';
import type { DeathRecord, RoleModule } from '../types';

const bool = (key: string, label: string, def: boolean, locale: string | undefined = 'zh-CN') => ({
  key,
  group: gameText(locale, "猎人"),
  label,
  type: 'boolean' as const,
  default: def,
  editable: false,
});

export const hunter: RoleModule = {
  id: 'hunter',
  tools: ({ seats, rules }) => [hunterTool(seats, rules.locale)],
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
      v['hunter.shootOnKnife'] && gameText(rules.locale, "被狼刀"),
      v['hunter.shootOnVote'] && gameText(rules.locale, "被放逐"),
      v['hunter.shootOnGuardAndSave'] && rules.roles.includes('guard') && gameText(rules.locale, "同守同救"),
    ].filter(Boolean);
    return [
      gameText(rules.locale, "猎人：{0}出局时可以开枪带走一名存活玩家，也可以放弃。", can.join('、')) +
        (v['hunter.shootOnPoison'] ? '' : gameText(rules.locale, "死因里包含毒药时不能开枪。")) +
        gameText(rules.locale, "符合发动条件时，法官私下询问本人；开枪结果和猎人表现公开。{0}", v['hunter.declineReveals'] ? gameText(rules.locale, "放弃开枪也会公开身份。") : gameText(rules.locale, "放弃开枪不公开身份。")),
    ];
  },

  appendix: (ctx) => [gameText(ctx.rules.locale, "你出局时如果死因不含毒药，法官会私下询问你是否开枪。开枪会公开你的身份。")],

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
              title: gameText(ctx.rules.locale, "开枪"),
              description: gameText(ctx.rules.locale, "带走一名存活玩家，或放弃开枪。开枪会公开你的猎人身份。"),
              params: [seatParam('target', gameText(ctx.rules.locale, "开枪目标"), targets, gameText(ctx.rules.locale, "放弃开枪"))],
            },
          ],
          prompt: () => gameText(ctx.rules.locale, "你已出局，可以开枪带走一名存活玩家，也可以放弃。"),
          title: gameText(ctx.rules.locale, "第{0}天 · 猎人开枪", ctx.state.day),
          publicStage: gameText(ctx.rules.locale, "法官结算中"),
        });
      },
      decide(ctx, step, subs) {
        const seat = step.seat as Seat;
        const target = (subs[seat].args.target as Seat | null) ?? null;
        if (target === null) {
          ctx.priv([seat], 'hunter.decline', gameText(ctx.rules.locale, "你放弃了开枪。"), {});
          if (ctx.opt<boolean>('hunter.declineReveals')) {
            ctx.player(seat).revealed = true;
            ctx.player(seat).revealedAs = 'hunter';
            ctx.pub('hunter.decline', gameText(ctx.rules.locale, "{0}是猎人，放弃开枪。", seatLabel(seat, ctx.rules.locale)), { seat });
          }
          return;
        }
        const own = ctx.state.deaths.find((d) => d.seat === seat);
        ctx.player(seat).revealed = true;
        ctx.player(seat).revealedAs = 'hunter';
        ctx.kill(target, {
          via: 'shot',
          causes: ['shot'],
          by: seat,
          shooterVia: own?.via,
          batch: step.batch as number,
        });
        ctx.state.history.shots.push(gameText(ctx.rules.locale, "第{0}天 {1}开枪带走{2}", ctx.state.day, seatLabel(seat, ctx.rules.locale), seatLabel(target, ctx.rules.locale)));
        ctx.pub('hunter.shot', gameText(ctx.rules.locale, "{0}开枪，{1}出局。", seatLabel(seat, ctx.rules.locale), seatLabel(target, ctx.rules.locale)), { shooter: seat, target, role: 'hunter' });
      },
      fallback: (ctx) => ({ tool: 'hunter_shoot', args: { target: null } }),
    },
  },
};

function hunterTool(seats: Seat[], locale: string | undefined = 'zh-CN'): ToolSpec {
  return {
    name: 'hunter_shoot',
    title: gameText(locale, "开枪"),
    description: gameText(locale, "猎人出局且法官允许开枪时使用。target 是要带走的存活玩家，null 表示放弃开枪。开枪会公开猎人身份。不能射自己。例：{\"target\":3} 为带走3号，{\"target\":null} 为放弃。是否能发动由死因和本局规则决定，以法官询问为准。其他阶段不要调用。"),
    params: [seatParam('target', gameText(locale, "开枪目标"), seats, gameText(locale, "放弃开枪"))],
  };
}
