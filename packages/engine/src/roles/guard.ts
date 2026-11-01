import type { RuleSet, ToolSpec } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { seatLabel } from '../text';
import { err, seatParam } from '../tools';
import type { RoleModule } from '../types';

const lastOf = (ctx: Ctx, seat: Seat) => (ctx.player(seat).data.last ?? null) as Seat | null;

function targetsFor(ctx: Ctx, seat: Seat): Seat[] {
  const last = lastOf(ctx, seat);
  return ctx
    .alive()
    .filter((x) => ctx.opt<boolean>('guard.allowSelf') || x !== seat)
    .filter((x) => !(ctx.opt<boolean>('guard.noConsecutive') && x === last));
}

export const guard: RoleModule = {
  id: 'guard',
  tools: ({ seats, rules }) => [guardTool(seats, rules.values)],
  name: '守卫',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '每晚守护一名玩家免受狼刀，也可以空守；不能连续两晚守护同一人。',
  nightPhase: { id: 'guard', order: 10 },
  options: [
    { key: 'guard.noConsecutive', group: '守卫', label: '不能连续两晚守护同一人', type: 'boolean', default: true, editable: false },
    { key: 'guard.allowSelf', group: '守卫', label: '可以守护自己', type: 'boolean', default: true, editable: false },
    { key: 'resolve.guardAndSaveKills', group: '守卫', label: '同守同救则刀口出局', type: 'boolean', default: true, editable: false },
  ],

  ruleCard(rules) {
    const v = rules.values;
    return [
      `守卫：每晚守护一名存活玩家，也可以空守。${v['guard.allowSelf'] ? '可以守护自己。' : '不能守护自己。'}` +
        (v['guard.noConsecutive']
          ? '不能连续两晚守护同一人；上一晚空守的话，下一晚可以守护任何人。'
          : '可以连续守护同一人。') +
        '守护只挡狼刀，挡不住毒药。' +
        '法官仅向守卫本人反馈守护选择，不告知刀口或是否挡住攻击，不向被守护者另发通知。' +
        (v['resolve.guardAndSaveKills'] ? '同一晚守卫守护了刀口、女巫也救了刀口，该玩家出局（同守同救）。' : ''),
    ];
  },

  setup(ctx, seats) {
    for (const s of seats) Object.assign(ctx.player(s).data, { last: null, log: [] });
  },

  appendix(ctx, seat) {
    const log = (ctx.player(seat).data.log ?? []) as { night: number; target: Seat | null }[];
    if (!log.length) return ['你还没有守护记录。'];
    const last = log[log.length - 1];
    return [
      `你的守护记录：${log.map((r) => `第${r.night}夜 ${r.target === null ? '空守' : seatLabel(r.target)}`).join('；')}。`,
      last.target === null || !ctx.opt<boolean>('guard.noConsecutive')
        ? '下一晚没有禁守座位。'
        : `下一晚不能再守护 ${seatLabel(last.target)}。`,
    ];
  },

  steps: {
    'night:guard': {
      run(ctx, step) {
        const guards = ctx.seatsOf('guard');
        if (!guards.length) return;
        ctx.ask({
          step,
          actors: guards,
          tools: (seat) => [
            {
              name: 'guard_protect',
              title: '守护',
              description: '守护一名存活玩家免受今晚的狼刀，或空守。',
              params: [seatParam('target', '守护目标', targetsFor(ctx, seat), '空守')],
            },
          ],
          prompt: (seat) => {
            const last = lastOf(ctx, seat);
            return last !== null && ctx.opt<boolean>('guard.noConsecutive')
              ? `请选择今晚守护的玩家，或空守。上一晚你守护了 ${seatLabel(last)}，今晚不能再守他。`
              : '请选择今晚守护的玩家，或空守。';
          },
          title: `第${ctx.state.day}夜 · 守卫`,
          publicStage: '夜晚',
        });
      },
      validate(ctx, _step, seat, call) {
        const t = call.args.target;
        if (t === null || t === undefined) return null;
        if (t === lastOf(ctx, seat) && ctx.opt<boolean>('guard.noConsecutive')) {
          return err('GUARD_REPEAT', '不能连续两晚守护同一名玩家');
        }
        if (t === seat && !ctx.opt<boolean>('guard.allowSelf')) return err('TARGET_SELF_FORBIDDEN', '本局规则不允许守护自己');
        return null;
      },
      decide(ctx, _step, subs) {
        const night = ctx.state.night;
        if (!night) throw new Error('守卫行动缺少夜晚状态');
        for (const [key, call] of Object.entries(subs)) {
          const seat = Number(key);
          const target = (call.args.target as Seat | null) ?? null;
          const data = ctx.player(seat).data;
          data.last = target;
          data.log.push({ night: ctx.state.day, target });
          if (target === null) {
            ctx.priv([seat], 'guard.skip', '你今晚空守。', {});
            night.lines.push(`守卫（${seatLabel(seat)}）空守`);
          } else {
            night.protections.push({ target, kind: 'guard', blocks: ['wolf'], by: seat });
            ctx.priv([seat], 'guard.protect', `你今晚守护了 ${seatLabel(target)}。`, { target });
            night.lines.push(`守卫（${seatLabel(seat)}）守护 ${seatLabel(target)}`);
          }
        }
      },
      fallback: () => ({ tool: 'guard_protect', args: { target: null } }),
    },
  },

  resolveNight(ctx, rows) {
    if (!ctx.opt<boolean>('resolve.guardAndSaveKills')) return;
    for (const r of rows) {
      if (r.attack.kind !== 'wolf') continue;
      const guarded = r.blockers.some((b) => b.kind === 'guard' || b.kind === 'awakened_guard');
      const saved = r.blockers.some((b) => b.kind === 'antidote');
      if (guarded && saved) {
        r.blocked = false;
        r.causes = ['guard_and_save'];
      }
    }
  },
};

function guardTool(seats: Seat[], v: RuleSet['values']): ToolSpec {
  return {
    name: 'guard_protect',
    title: '守护',
    description: `守卫夜间守护时使用。target 是今晚守护的存活玩家，null 表示空守。${v['guard.allowSelf'] === true ? '可以守护自己。' : '不能守护自己。'}${v['guard.noConsecutive'] === true ? '不能连续两晚守护同一人。' : ''}守护只挡狼刀，挡不住毒药；上一晚空守会解除连续守护限制。例：{"target":3} 为守3号，{"target":null} 为空守，目标以本轮限制为准。其他阶段不要调用。`,
    params: [seatParam('target', '守护目标', seats, '空守')],
  };
}
