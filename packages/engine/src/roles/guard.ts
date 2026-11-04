import { roleData } from '../role-data';
import { gameText, isEnglishGameLocale } from '@werewolf/protocol';
import type { RuleSet, ToolSpec } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { seatLabel } from '../text';
import { err, seatParam } from '../tools';
import type { ResolutionRow, RoleModule } from '../types';

const lastOf = (ctx: Ctx, seat: Seat) => roleData(ctx.player(seat), 'guard').last ?? null;

function targetsFor(ctx: Ctx, seat: Seat): Seat[] {
  const last = lastOf(ctx, seat);
  return ctx
    .alive()
    .filter((x) => ctx.opt<boolean>('guard.allowSelf') || x !== seat)
    .filter((x) => !(ctx.opt<boolean>('guard.noConsecutive') && x === last));
}

export const guard: RoleModule = {
  copiedAbility: 'guard',
  id: 'guard',
  tools: ({ seats, rules }) => [guardTool(seats, rules.values, rules.locale)],
  name: '守卫',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '每晚可以守护一名存活玩家，也可以选择不守护任何人；不能连续两夜守护同一人。',
  nightPhase: { id: 'guard', order: 10 },
  options: [
    { key: 'guard.noConsecutive', group: '守卫', label: '不能连续两晚守护同一人', type: 'boolean', default: true, editable: false },
    { key: 'guard.allowSelf', group: '守卫', label: '可以守护自己', type: 'boolean', default: true, editable: false },
    { key: 'resolve.guardAndSaveKills', group: '守卫', label: '同守同救则刀口出局', type: 'boolean', default: true, editable: false },
  ],

  ruleCard(rules) {
    const v = rules.values;
    const sentenceSeparator = isEnglishGameLocale(rules.locale) ? ' ' : '';
    return [
      gameText(rules.locale, "守卫：每晚可以守护一名存活玩家，也可以选择不守护任何人。") + sentenceSeparator +
        (v['guard.allowSelf'] ? gameText(rules.locale, "可以守护自己。") : gameText(rules.locale, "不能守护自己。")) + sentenceSeparator +
        (v['guard.noConsecutive']
          ? gameText(rules.locale, "不能连续两夜守护同一名玩家；如果一夜没有守护任何人，下一夜可以守护任何符合条件的存活玩家。")
          : gameText(rules.locale, "可以连续两夜守护同一名玩家。")) + sentenceSeparator +
        gameText(rules.locale, "法官只向守卫回执其自己的选择，不告知狼人的攻击目标或守护结果；被守护的玩家不会收到通知。"),
    ];
  },

  setup(ctx, seats) {
    for (const s of seats) Object.assign(roleData(ctx.player(s), 'guard'), { last: null, log: [] });
  },

  appendix(ctx, seat) {
    const log = roleData(ctx.player(seat), 'guard').log ?? [];
    if (!log.length) return [gameText(ctx.rules.locale, "你还没有守护记录。")];
    const last = log[log.length - 1];
    return [
      gameText(ctx.rules.locale, "你的守护记录：{0}。", log.map((r) => gameText(ctx.rules.locale, "第{0}夜 {1}", r.night, r.target === null ? gameText(ctx.rules.locale, "空守") : seatLabel(r.target, ctx.rules.locale))).join('；')),
      last.target === null || !ctx.opt<boolean>('guard.noConsecutive')
        ? gameText(ctx.rules.locale, "下一晚没有禁守座位。")
        : gameText(ctx.rules.locale, "下一晚不能再守护 {0}。", seatLabel(last.target, ctx.rules.locale)),
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
              title: gameText(ctx.rules.locale, "守护"),
              description: gameText(ctx.rules.locale, "守护一名存活玩家免受今晚的狼刀，或空守。"),
              params: [seatParam('target', gameText(ctx.rules.locale, "守护目标"), targetsFor(ctx, seat), gameText(ctx.rules.locale, "空守"))],
            },
          ],
          prompt: (seat) => {
            const last = lastOf(ctx, seat);
            return last !== null && ctx.opt<boolean>('guard.noConsecutive')
              ? gameText(ctx.rules.locale, "请选择今晚守护的玩家，或空守。上一晚你守护了 {0}，今晚不能再守他。", seatLabel(last, ctx.rules.locale))
              : gameText(ctx.rules.locale, "请选择今晚守护的玩家，或空守。");
          },
          title: gameText(ctx.rules.locale, "第{0}夜 · 守卫", ctx.state.day),
          publicStage: gameText(ctx.rules.locale, "夜晚"),
        });
      },
      validate(ctx, _step, seat, call) {
        const t = call.args.target;
        if (t === null || t === undefined) return null;
        if (t === lastOf(ctx, seat) && ctx.opt<boolean>('guard.noConsecutive')) {
          return err('GUARD_REPEAT', gameText(ctx.rules.locale, "不能连续两晚守护同一名玩家"));
        }
        if (t === seat && !ctx.opt<boolean>('guard.allowSelf')) return err('TARGET_SELF_FORBIDDEN', gameText(ctx.rules.locale, "本局规则不允许守护自己"));
        return null;
      },
      decide(ctx, _step, subs) {
        const night = ctx.state.night;
        if (!night) throw new Error(gameText(ctx.rules.locale, "守卫行动缺少夜晚状态"));
        for (const [key, call] of Object.entries(subs)) {
          const seat = Number(key);
          const target = (call.args.target as Seat | null) ?? null;
          const data = roleData(ctx.player(seat), 'guard');
          data.last = target;
          data.log.push({ night: ctx.state.day, target });
          if (target === null) {
            ctx.priv([seat], 'guard.skip', gameText(ctx.rules.locale, "你今晚空守。"), {});
            night.lines.push(gameText(ctx.rules.locale, "守卫（{0}）空守", seatLabel(seat, ctx.rules.locale)));
          } else {
            night.protections.push({ target, kind: 'guard', blocks: ['wolf'], by: seat });
            ctx.priv([seat], 'guard.protect', gameText(ctx.rules.locale, "你今晚守护了 {0}。", seatLabel(target, ctx.rules.locale)), { target });
            night.lines.push(gameText(ctx.rules.locale, "守卫（{0}）守护 {1}", seatLabel(seat, ctx.rules.locale), seatLabel(target, ctx.rules.locale)));
          }
        }
      },
      fallback: (ctx) => ({ tool: 'guard_protect', args: { target: null } }),
    },
  },
};

function guardTool(seats: Seat[], v: RuleSet['values'], locale: string | undefined = 'zh-CN'): ToolSpec {
  return {
    name: 'guard_protect',
    title: gameText(locale, "守护"),
    description: gameText(locale, "守卫夜间守护时使用。target 是今晚守护的存活玩家，null 表示空守。{0}{1}守护只挡狼刀，挡不住毒药；上一晚空守会解除连续守护限制。例：{\"target\":3} 为守3号，{\"target\":null} 为空守，目标以本轮限制为准。其他阶段不要调用。", v['guard.allowSelf'] === true ? gameText(locale, "可以守护自己。") : gameText(locale, "不能守护自己。"), v['guard.noConsecutive'] === true ? gameText(locale, "不能连续两晚守护同一人。") : ''),
    params: [seatParam('target', gameText(locale, "守护目标"), seats, gameText(locale, "空守"))],
  };
}

export function resolveGuardAndSave(ctx: Ctx, rows: ResolutionRow[]): void {
  if (!ctx.rules.values['resolve.guardAndSaveKills']) return;
  for (const row of rows) {
    if (row.attack.kind !== 'wolf') continue;
    const guarded = row.blockers.some((blocker) => blocker.kind === 'guard' || blocker.kind === 'awakened_guard');
    const saved = row.blockers.some((blocker) => blocker.kind === 'antidote');
    if (guarded && saved) {
      row.blocked = false;
      row.causes = ['guard_and_save'];
    }
  }
}
