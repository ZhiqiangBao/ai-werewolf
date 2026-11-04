import { roleData } from '../role-data';
import { gameText } from '@werewolf/protocol';
import type { ToolSpec } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import { seatLabel } from '../text';
import { seatParam } from '../tools';
import type { RoleModule } from '../types';
import { INSPECTION_PRIVACY_RULE } from './inspection';

export const seer: RoleModule = {
  id: 'seer',
  tools: ({ seats, rules }) => [seerTool(seats, rules.locale)],
  name: '预言家',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '每晚查验一名其他存活玩家，结果只区分好人或狼人。',
  nightPhase: { id: 'seer', order: 30 },

  ruleCard: (rules) => [gameText(rules.locale, "预言家：每晚查验一名其他存活玩家，结果只区分好人或狼人，不返回具体身份；可以重复查验。{0}", gameText(rules.locale, INSPECTION_PRIVACY_RULE))],

  setup(ctx, seats) {
    for (const s of seats) roleData(ctx.player(s), 'seer').checks = [];
  },

  knowledge(ctx, seat) {
    return roleData(ctx.player(seat), 'seer').checks.map((check) => ({
      seat: check.target, kind: 'alignment' as const, alignment: check.result, source: 'inspection' as const,
    }));
  },

  appendix(ctx, seat) {
    const checks = roleData(ctx.player(seat), 'seer').checks;
    if (!checks.length) return [gameText(ctx.rules.locale, "你的查验记录：暂无。")];
    return [
      gameText(ctx.rules.locale, "你的查验记录：{0}。", checks.map((c) => gameText(ctx.rules.locale, "第{0}夜 {1}={2}", c.night, seatLabel(c.target, ctx.rules.locale), c.result === 'wolf' ? gameText(ctx.rules.locale, "狼人") : gameText(ctx.rules.locale, "好人"))).join('；')),
    ];
  },

  steps: {
    'night:seer': {
      run(ctx, step) {
        const seers = ctx.seatsOf('seer');
        if (!seers.length) return;
        ctx.ask({
          step,
          actors: seers,
          tools: (seat) => [
            {
              name: 'seer_inspect',
              title: gameText(ctx.rules.locale, "查验"),
              description: gameText(ctx.rules.locale, "查验一名其他存活玩家，立刻得知他是好人还是狼人。"),
              params: [seatParam('target', gameText(ctx.rules.locale, "查验目标"), ctx.alive().filter((x) => x !== seat), undefined)],
            },
          ],
          prompt: () => gameText(ctx.rules.locale, "请选择今晚要查验的玩家。"),
          title: gameText(ctx.rules.locale, "第{0}夜 · 预言家", ctx.state.day),
          publicStage: gameText(ctx.rules.locale, "夜晚"),
        });
      },
      validate(ctx, _step, seat, call) {
        if (call.args.target === seat) return { code: 'TARGET_SELF_FORBIDDEN', reason: gameText(ctx.rules.locale, "预言家不能查验自己") };
        return null;
      },
      decide(ctx, _step, subs) {
        const night = ctx.state.night;
        for (const [seatKey, call] of Object.entries(subs)) {
          const seat = Number(seatKey);
          const target = call.args.target as Seat | null;
          if (target === null) {
            ctx.priv([seat], 'seer.skip', gameText(ctx.rules.locale, "本夜没有查验。"), {});
            night?.lines.push(gameText(ctx.rules.locale, "预言家（{0}）未查验", seatLabel(seat, ctx.rules.locale)));
            continue;
          }
          const mod = ctx.roleOf(target);
          const result: 'good' | 'wolf' = mod.inspectAs ?? (mod.faction === 'wolf' ? 'wolf' : 'good');
          roleData(ctx.player(seat), 'seer').checks.push({ night: ctx.state.day, target, result });
          const label = result === 'wolf' ? gameText(ctx.rules.locale, "狼人") : gameText(ctx.rules.locale, "好人");
          ctx.priv([seat], 'seer.result', gameText(ctx.rules.locale, "查验结果：{0}是{1}。", seatLabel(target, ctx.rules.locale), label), { target, result });
          night?.lines.push(gameText(ctx.rules.locale, "预言家（{0}）查验 {1}：{2}", seatLabel(seat, ctx.rules.locale), seatLabel(target, ctx.rules.locale), label));
        }
      },
      fallback: (ctx) => ({ tool: 'seer_inspect', args: { target: null } }),
    },
  },
};

function seerTool(seats: Seat[], locale: string | undefined = 'zh-CN'): ToolSpec {
  return {
    name: 'seer_inspect',
    title: gameText(locale, "查验"),
    description: gameText(locale, "查验 target 指定的玩家，获得好人或狼人结果。填写目标座位号，例如 {\"target\":3}。"),
    params: [seatParam('target', gameText(locale, "查验目标"), seats, undefined)],
  };
}
