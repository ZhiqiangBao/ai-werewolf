import { roleData } from '../role-data';
import { gameText } from '@werewolf/protocol';
import type { RuleSet, ToolSpec } from '@werewolf/protocol';
import type { ParamSpec, Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { seatLabel } from '../text';
import { err, seatParam } from '../tools';
import type { RoleModule } from '../types';

const potions = (ctx: Ctx, seat: Seat) => roleData(ctx.player(seat), 'witch');

function selfSaveAllowed(ctx: Ctx): boolean {
  const rule = ctx.opt<string>('witch.selfSave');
  return rule === 'always' || (rule === 'first_night' && ctx.state.day === 1);
}

function knifeOf(ctx: Ctx): Seat | null {
  return ctx.state.night?.knife ?? null;
}

function paramsFor(ctx: Ctx, seat: Seat): ParamSpec[] {
  const p = potions(ctx, seat);
  const knife = knifeOf(ctx);
  const params: ParamSpec[] = [];
  if (p.antidote && knife !== null && (knife !== seat || selfSaveAllowed(ctx))) {
    params.push({ kind: 'boolean', name: 'save', label: gameText(ctx.rules.locale, "对 {0} 使用解药", seatLabel(knife, ctx.rules.locale)), trueLabel: gameText(ctx.rules.locale, "救"), falseLabel: gameText(ctx.rules.locale, "不救") });
  }
  if (p.poison) {
    params.push(seatParam('poisonTarget', gameText(ctx.rules.locale, "毒药目标"), ctx.alive().filter((x) => x !== seat), gameText(ctx.rules.locale, "不用毒药")));
  }
  return params;
}

function promptFor(ctx: Ctx, seat: Seat): string {
  const p = potions(ctx, seat);
  const knife = knifeOf(ctx);
  const parts: string[] = [];
  if (p.antidote) {
    parts.push(knife !== null ? gameText(ctx.rules.locale, "狼人今晚选择刀 {0}。", seatLabel(knife, ctx.rules.locale)) : gameText(ctx.rules.locale, "狼人今晚没有落刀。"));
    if (knife === seat && !selfSaveAllowed(ctx)) parts.push(gameText(ctx.rules.locale, "本局规则不允许你自救。"));
  }
  parts.push(gameText(ctx.rules.locale, "你现在持有：{0}。", [p.antidote ? gameText(ctx.rules.locale, "解药") : '', p.poison ? gameText(ctx.rules.locale, "毒药") : ''].filter(Boolean).join('、')));
  if (p.antidote && p.poison && !ctx.opt<boolean>('witch.bothPotionsSameNight')) parts.push(gameText(ctx.rules.locale, "同一晚不能既救又毒。"));
  return parts.join('');
}

export const witch: RoleModule = {
  copiedAbility: 'poison',
  id: 'witch',
  tools: ({ seats, rules }) => [witchTool(seats, rules.values, rules.locale)],
  name: '女巫',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '有一瓶解药和一瓶毒药。解药还在的夜晚，法官会告诉你当晚刀口。',
  nightPhase: { id: 'witch', order: 40 },
  options: [
    {
      key: 'witch.selfSave',
      group: '女巫',
      label: '女巫自救',
      type: 'choice',
      choices: [
        { value: 'never', label: '不能自救' },
        { value: 'first_night', label: '仅第 1 夜可以自救' },
        { value: 'always', label: '任何夜晚都可以自救' },
      ],
      default: 'never',
      editable: true,
    },
    { key: 'witch.bothPotionsSameNight', group: '女巫', label: '同一晚可以既救又毒', type: 'boolean', default: false, editable: false },
  ],

  ruleCard(rules) {
    const v = rules.values;
    const self =
      v['witch.selfSave'] === 'always' ? gameText(rules.locale, "可以自救") : v['witch.selfSave'] === 'first_night' ? gameText(rules.locale, "仅第 1 夜可以自救") : gameText(rules.locale, "不能自救");
    const knife = rules.roles.includes('guard') ? gameText(rules.locale, "狼人选择的目标，不含守卫结果") : gameText(rules.locale, "狼人选择的目标");
    return [
      gameText(rules.locale, "女巫：解药、毒药各一瓶。仅持有解药时得知当晚刀口（{0}；空刀会告知）。", knife) +
        gameText(rules.locale, "解药只能救当晚刀口，{0}。{1}", self, v['witch.bothPotionsSameNight'] ? gameText(rules.locale, "同一晚可以既救又毒。") : gameText(rules.locale, "同一晚不能既救又毒。")) +
        gameText(rules.locale, "毒药可毒其他存活者（含刀口），不能毒自己。刀口和用药仅反馈本人，不通知目标；双药用尽后夜里不再行动。"),
    ];
  },

  setup(ctx, seats) {
    for (const s of seats) Object.assign(roleData(ctx.player(s), 'witch'), { antidote: true, poison: true });
  },

  appendix(ctx, seat) {
    const p = potions(ctx, seat);
    const lines = [gameText(ctx.rules.locale, "药品：解药{0}，毒药{1}。", p.antidote ? gameText(ctx.rules.locale, "未使用") : gameText(ctx.rules.locale, "已使用"), p.poison ? gameText(ctx.rules.locale, "未使用") : gameText(ctx.rules.locale, "已使用"))];
    if (!p.antidote) lines.push(gameText(ctx.rules.locale, "解药已用，之后法官不再告诉你刀口。"));
    return lines;
  },

  steps: {
    'night:witch': {
      run(ctx, step) {
        const witches = ctx.seatsOf('witch').filter((w) => potions(ctx, w).antidote || potions(ctx, w).poison);
        if (!witches.length) return;
        const knife = knifeOf(ctx);
        for (const w of witches) {
          if (!potions(ctx, w).antidote) continue;
          ctx.priv([w], 'witch.knife', knife !== null ? gameText(ctx.rules.locale, "狼人今晚选择刀 {0}。", seatLabel(knife, ctx.rules.locale)) : gameText(ctx.rules.locale, "狼人今晚没有落刀。"), {
            knife,
          });
        }
        const actors = witches.filter((w) => paramsFor(ctx, w).length > 0);
        if (!actors.length) return;
        ctx.ask({
          step,
          actors,
          tools: (seat) => [
            {
              name: 'witch_act',
              title: gameText(ctx.rules.locale, "用药"),
              description: gameText(ctx.rules.locale, "一次提交本晚的用药决定，救和毒都在这里选。"),
              params: paramsFor(ctx, seat),
            },
          ],
          prompt: (seat) => promptFor(ctx, seat),
          title: gameText(ctx.rules.locale, "第{0}夜 · 女巫", ctx.state.day),
          publicStage: gameText(ctx.rules.locale, "夜晚"),
        });
      },
      validate(ctx, _step, seat, call) {
        const p = potions(ctx, seat);
        const knife = knifeOf(ctx);
        const save = call.args.save === true;
        const poisonTarget = call.args.poisonTarget;
        if (save) {
          if (!p.antidote) return err('POTION_USED', gameText(ctx.rules.locale, "解药已经用过"));
          if (knife === null) return err('INVALID_ARGUMENT', gameText(ctx.rules.locale, "今晚没有刀口，不能使用解药"));
          if (knife === seat && !selfSaveAllowed(ctx)) return err('CANNOT_SELF_SAVE', gameText(ctx.rules.locale, "本场规则不允许自救"));
        }
        if (poisonTarget !== null && poisonTarget !== undefined) {
          if (!p.poison) return err('POTION_USED', gameText(ctx.rules.locale, "毒药已经用过"));
          if (poisonTarget === seat) return err('TARGET_SELF_FORBIDDEN', gameText(ctx.rules.locale, "不能对自己使用毒药"));
        }
        if (save && poisonTarget !== null && poisonTarget !== undefined && !ctx.opt<boolean>('witch.bothPotionsSameNight')) {
          return err('SAME_NIGHT_BOTH_POTIONS', gameText(ctx.rules.locale, "同一晚不能既救又毒"));
        }
        return null;
      },
      decide(ctx, _step, subs) {
        const night = ctx.state.night;
        if (!night) throw new Error(gameText(ctx.rules.locale, "女巫行动缺少夜晚状态"));
        const knife = knifeOf(ctx);
        for (const [key, call] of Object.entries(subs)) {
          const seat = Number(key);
          const p = potions(ctx, seat);
          const save = call.args.save === true && knife !== null;
          const target = (call.args.poisonTarget as Seat | null | undefined) ?? null;
          const done: string[] = [];
          if (save && knife !== null) {
            night.protections.push({ target: knife, kind: 'antidote', blocks: ['wolf'], by: seat });
            p.antidote = false;
            ctx.priv([seat], 'witch.save', gameText(ctx.rules.locale, "你对 {0} 使用了解药。", seatLabel(knife, ctx.rules.locale)), { target: knife });
            done.push(gameText(ctx.rules.locale, "救 {0}", seatLabel(knife, ctx.rules.locale)));
          }
          if (target !== null) {
            night.attacks.push({ target, kind: 'poison', by: [seat] });
            p.poison = false;
            ctx.priv([seat], 'witch.poison', gameText(ctx.rules.locale, "你对 {0} 使用了毒药。", seatLabel(target, ctx.rules.locale)), { target });
            done.push(gameText(ctx.rules.locale, "毒 {0}", seatLabel(target, ctx.rules.locale)));
          }
          if (!done.length) ctx.priv([seat], 'witch.idle', gameText(ctx.rules.locale, "你今晚没有用药。"), {});
          night.lines.push(gameText(ctx.rules.locale, "女巫（{0}）{1}", seatLabel(seat, ctx.rules.locale), done.length ? done.join('、') : gameText(ctx.rules.locale, "未用药")));
        }
      },
      fallback: (ctx) => ({ tool: 'witch_act', args: { save: false, poisonTarget: null } }),
    },
  },
};

function witchTool(seats: Seat[], v: RuleSet['values'], locale: string | undefined = 'zh-CN'): ToolSpec {
  const self = v['witch.selfSave'] === 'always' ? gameText(locale, "可以自救。") : v['witch.selfSave'] === 'first_night' ? gameText(locale, "仅第 1 夜可以自救。") : gameText(locale, "不能自救。");
  const both = v['witch.bothPotionsSameNight'] === true ? gameText(locale, "同一晚可以既救又毒。") : gameText(locale, "同一晚不能既救又毒。");
  return {
    name: 'witch_act',
    title: gameText(locale, "用药"),
    description: gameText(locale, "女巫夜间用药时使用。save 为 true 表示用尚未用过的解药救当晚刀口，false 表示不救。解药只能救当晚刀口，{0}poisonTarget 是毒药目标的整数座位号，只可选其他存活玩家，null 表示不用毒药。药品各只能用一次；解药用尽时 save 必须 false，毒药用尽时 poisonTarget 必须 null。{1}两个字段一次提交：不用药填 {\"save\":false,\"poisonTarget\":null}；只救人填 {\"save\":true,\"poisonTarget\":null}；只毒3号填 {\"save\":false,\"poisonTarget\":3}（须为合法目标）。其他阶段不要调用。", self, both),
    params: [
      { kind: 'boolean', name: 'save', label: gameText(locale, "使用解药"), trueLabel: gameText(locale, "救"), falseLabel: gameText(locale, "不救") },
      seatParam('poisonTarget', gameText(locale, "毒药目标"), seats, gameText(locale, "不用毒药")),
    ],
  };
}
