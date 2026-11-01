import type { ToolSpec } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import { seatLabel } from '../text';
import { seatParam } from '../tools';
import type { RoleModule } from '../types';

interface Check {
  night: number;
  target: Seat;
  result: 'good' | 'wolf';
}

export const seer: RoleModule = {
  id: 'seer',
  tools: ({ seats, rules }) => [seerTool(seats)],
  name: '预言家',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '每晚查验一名其他存活玩家，结果只区分好人或狼人。',
  nightPhase: { id: 'seer', order: 30 },

  ruleCard: () => ['预言家：每晚查验一名其他存活玩家，结果只区分好人或狼人。'],

  setup(ctx, seats) {
    for (const s of seats) ctx.player(s).data.checks = [];
  },

  knowledge(ctx, seat) {
    return ((ctx.player(seat).data.checks ?? []) as Check[]).map((check) => ({
      seat: check.target, kind: 'alignment' as const, alignment: check.result, source: 'inspection' as const,
    }));
  },

  appendix(ctx, seat) {
    const checks = (ctx.player(seat).data.checks ?? []) as Check[];
    if (!checks.length) return ['你的查验记录：暂无。'];
    return [
      `你的查验记录：${checks.map((c) => `第${c.night}夜 ${seatLabel(c.target)}=${c.result === 'wolf' ? '狼人' : '好人'}`).join('；')}。`,
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
              title: '查验',
              description: '查验一名其他存活玩家，立刻得知他是好人还是狼人。',
              params: [seatParam('target', '查验目标', ctx.alive().filter((x) => x !== seat))],
            },
          ],
          prompt: () => '请选择今晚要查验的玩家。',
          title: `第${ctx.state.day}夜 · 预言家`,
          publicStage: '夜晚',
        });
      },
      validate(ctx, _step, seat, call) {
        if (call.args.target === seat) return { code: 'TARGET_SELF_FORBIDDEN', reason: '预言家不能查验自己' };
        return null;
      },
      decide(ctx, _step, subs) {
        const night = ctx.state.night;
        for (const [seatKey, call] of Object.entries(subs)) {
          const seat = Number(seatKey);
          const target = call.args.target as Seat | null;
          if (target === null) {
            ctx.priv([seat], 'seer.skip', '本夜没有查验。', {});
            night?.lines.push(`预言家（${seatLabel(seat)}）未查验`);
            continue;
          }
          const mod = ctx.roleOf(target);
          const result: 'good' | 'wolf' = mod.inspectAs ?? (mod.faction === 'wolf' ? 'wolf' : 'good');
          (ctx.player(seat).data.checks as Check[]).push({ night: ctx.state.day, target, result });
          const label = result === 'wolf' ? '狼人' : '好人';
          ctx.priv([seat], 'seer.result', `查验结果：${seatLabel(target)}是${label}。`, { target, result });
          night?.lines.push(`预言家（${seatLabel(seat)}）查验 ${seatLabel(target)}：${label}`);
        }
      },
      fallback: () => ({ tool: 'seer_inspect', args: { target: null } }),
    },
  },
};

function seerTool(seats: Seat[]): ToolSpec {
  return {
    name: 'seer_inspect',
    title: '查验',
    description: '预言家夜间查验时使用。target 是一名其他存活玩家，不能查自己。target 必须为整数，不能填 null；例：{"target":3}（须为其他存活玩家）。可以重复查验。结果只区分好人或狼人，不返回具体神职，只有你能看到。其他阶段不要调用。',
    params: [seatParam('target', '查验目标', seats)],
  };
}
