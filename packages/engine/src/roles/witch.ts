import { roleData } from '../role-data';
import { gameText, isEnglishGameLocale } from '@werewolf/protocol';
import type { RuleSet, ToolSpec } from '@werewolf/protocol';
import type { ParamSpec, Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { seatLabel, seatList } from '../text';
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

function choosesAntidoteTarget(rules: RuleSet): boolean {
  return rules.awakenedNightVersion === 2 && rules.roles.includes('werewolf') && rules.roles.includes('awakened_wolf');
}

function wolfAttackTargets(ctx: Ctx): Seat[] {
  return [...new Set(ctx.state.night?.attacks.filter(({ kind }) => kind === 'wolf').map(({ target }) => target))].sort((a, b) => a - b);
}

function attackNotice(ctx: Ctx, targets: Seat[]): string {
  return targets.length ? gameText(ctx.rules.locale, "今晚受到狼人攻击的玩家：{0}。", seatList(targets, ctx.rules.locale))
    : gameText(ctx.rules.locale, "今晚无人受到狼人攻击。");
}

function selectedSave(ctx: Ctx, args: Record<string, unknown>): Seat | null {
  if (choosesAntidoteTarget(ctx.rules)) return (args.saveTarget as Seat | null | undefined) ?? null;
  return args.save === true ? knifeOf(ctx) : null;
}

function paramsFor(ctx: Ctx, seat: Seat): ParamSpec[] {
  const p = potions(ctx, seat);
  const knife = knifeOf(ctx);
  const params: ParamSpec[] = [];
  if (p.antidote) {
    if (choosesAntidoteTarget(ctx.rules)) {
      const targets = wolfAttackTargets(ctx).filter((target) => target !== seat || selfSaveAllowed(ctx));
      if (targets.length) params.push(seatParam('saveTarget', gameText(ctx.rules.locale, "解药目标"), targets, gameText(ctx.rules.locale, "不用解药")));
    } else if (knife !== null && (knife !== seat || selfSaveAllowed(ctx))) {
      params.push({ kind: 'boolean', name: 'save', label: gameText(ctx.rules.locale, "对 {0} 使用解药", seatLabel(knife, ctx.rules.locale)), trueLabel: gameText(ctx.rules.locale, "救"), falseLabel: gameText(ctx.rules.locale, "不救") });
    }
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
    const targets = choosesAntidoteTarget(ctx.rules) ? wolfAttackTargets(ctx) : null;
    parts.push(targets ? attackNotice(ctx, targets) : knife !== null ? gameText(ctx.rules.locale, "狼人今晚选择刀 {0}。", seatLabel(knife, ctx.rules.locale)) : gameText(ctx.rules.locale, "狼人今晚没有落刀。"));
  }
  parts.push(gameText(ctx.rules.locale, "你现在持有：{0}。", [p.antidote ? gameText(ctx.rules.locale, "解药") : '', p.poison ? gameText(ctx.rules.locale, "毒药") : ''].filter(Boolean).join(gameText(ctx.rules.locale, '、'))));
  return parts.join(isEnglishGameLocale(ctx.rules.locale) ? '\n' : '');
}

export const witch: RoleModule = {
  copiedAbility: 'poison',
  id: 'witch',
  tools: ({ seats, rules }) => [witchTool(seats, rules)],
  name: '女巫',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '有一瓶解药和一瓶毒药。解药尚未使用时，法官会私下告知狼人当晚选择的攻击目标。',
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
    const sentenceSeparator = isEnglishGameLocale(rules.locale) ? ' ' : '';
    const hasCopiedClaw = rules.roles.includes('werewolf') && rules.roles.includes('awakened_wolf');
    const self =
      v['witch.selfSave'] === 'always' ? gameText(rules.locale, "可以自救") : v['witch.selfSave'] === 'first_night' ? gameText(rules.locale, "仅第 1 夜可以自救") : gameText(rules.locale, "不能自救");
    const guardInfo = rules.roles.includes('guard') ? gameText(rules.locale, "法官不会告知守卫的选择。") : '';
    return [
      gameText(rules.locale, "女巫：有一瓶解药和一瓶毒药，每瓶只能使用一次。") + sentenceSeparator +
        gameText(rules.locale, choosesAntidoteTarget(rules)
          ? "解药尚未使用时，法官私下告知女巫本夜受到普通狼刀或额外爪击的玩家，只报座位，不区分攻击来源；同一座位只报一次。若无人受到攻击，也会告知。"
          : hasCopiedClaw
            ? "解药尚未使用时，法官只告知女巫普通狼刀的攻击目标，不告知额外爪击的目标。若普通狼刀没有目标，额外爪击不会成为可选解药目标。"
            : "解药尚未使用时，法官会私下告知女巫狼人当晚选择的最终攻击目标；如果当晚没有狼人攻击，法官会告知女巫无人受到攻击。") + sentenceSeparator +
        (guardInfo ? guardInfo + sentenceSeparator : '') +
        gameText(rules.locale, choosesAntidoteTarget(rules)
          ? "一瓶解药只能选一名当夜受到狼人攻击的玩家；{0}。{1}"
          : hasCopiedClaw
            ? "解药只能救普通狼刀的攻击目标；额外爪击与普通狼刀目标相同时也会被这瓶解药挡住；{0}。{1}"
            : "解药只能用于当晚狼人的攻击目标；{0}。{1}", self, v['witch.bothPotionsSameNight'] ? gameText(rules.locale, "一夜可以同时使用两瓶药。") : gameText(rules.locale, "一夜不能同时使用两瓶药。")) + sentenceSeparator +
        gameText(rules.locale, "毒药可以用于其他存活玩家，包括狼人的攻击目标；不能对自己使用，也可以选择不用药。用药选择在游戏期间不公开，用药目标不会收到通知。"),
    ];
  },

  setup(ctx, seats) {
    for (const s of seats) Object.assign(roleData(ctx.player(s), 'witch'), { antidote: true, poison: true });
  },

  appendix(ctx, seat) {
    const p = potions(ctx, seat);
    const lines = [gameText(ctx.rules.locale, "药品：解药{0}，毒药{1}。", p.antidote ? gameText(ctx.rules.locale, "未使用") : gameText(ctx.rules.locale, "已使用"), p.poison ? gameText(ctx.rules.locale, "未使用") : gameText(ctx.rules.locale, "已使用"))];
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
          if (choosesAntidoteTarget(ctx.rules)) {
            const targets = wolfAttackTargets(ctx);
            ctx.priv([w], 'witch.targets', attackNotice(ctx, targets), { targets });
          } else {
            ctx.priv([w], 'witch.knife', knife !== null ? gameText(ctx.rules.locale, "狼人今晚选择刀 {0}。", seatLabel(knife, ctx.rules.locale)) : gameText(ctx.rules.locale, "狼人今晚没有落刀。"), { knife });
          }
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
        const targeted = choosesAntidoteTarget(ctx.rules);
        const saveTarget = selectedSave(ctx, call.args);
        const save = saveTarget !== null || call.args.save === true;
        const poisonTarget = call.args.poisonTarget;
        if (save) {
          if (!p.antidote) return err('POTION_USED', gameText(ctx.rules.locale, "解药已经用过"));
          if (targeted && (saveTarget === null || !wolfAttackTargets(ctx).includes(saveTarget))) {
            return err('INVALID_ARGUMENT', gameText(ctx.rules.locale, "请从当夜受到狼人攻击的玩家中选择一名使用解药。"));
          }
          if (saveTarget === null) return err('INVALID_ARGUMENT', gameText(ctx.rules.locale, "今晚没有刀口，不能使用解药"));
          if (saveTarget === seat && !selfSaveAllowed(ctx)) return err('CANNOT_SELF_SAVE', gameText(ctx.rules.locale, "本场规则不允许自救"));
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
        for (const [key, call] of Object.entries(subs)) {
          const seat = Number(key);
          const p = potions(ctx, seat);
          const saveTarget = selectedSave(ctx, call.args);
          const target = (call.args.poisonTarget as Seat | null | undefined) ?? null;
          const knife = knifeOf(ctx);
          const knownTargets = !p.antidote ? [] : choosesAntidoteTarget(ctx.rules)
            ? wolfAttackTargets(ctx) : knife === null ? [] : [knife];
          const knownKnife = knownTargets.length === 1 ? knownTargets[0] : null;
          const done: string[] = [];
          if (saveTarget !== null) {
            night.protections.push({ target: saveTarget, kind: 'antidote', blocks: ['wolf'], by: seat });
            p.antidote = false;
            ctx.priv([seat], 'witch.save', gameText(ctx.rules.locale, "你对 {0} 使用了解药。", seatLabel(saveTarget, ctx.rules.locale)), { target: saveTarget });
            done.push(gameText(ctx.rules.locale, "救 {0}", seatLabel(saveTarget, ctx.rules.locale)));
          } else {
            ctx.priv([seat], 'witch.no_save', knownKnife === null
              ? gameText(ctx.rules.locale, "你今晚没有使用解药。")
              : gameText(ctx.rules.locale, "你今晚没有对 {0} 使用解药。", seatLabel(knownKnife, ctx.rules.locale)), knownKnife === null ? {} : { target: knownKnife });
          }
          if (target !== null) {
            night.attacks.push({ target, kind: 'poison', by: [seat] });
            p.poison = false;
            ctx.priv([seat], 'witch.poison', gameText(ctx.rules.locale, "你对 {0} 使用了毒药。", seatLabel(target, ctx.rules.locale)), { target });
            done.push(gameText(ctx.rules.locale, "毒 {0}", seatLabel(target, ctx.rules.locale)));
          } else {
            ctx.priv([seat], 'witch.no_poison', gameText(ctx.rules.locale, "你今晚没有使用毒药。"), {});
          }
          night.lines.push(gameText(ctx.rules.locale, "女巫（{0}）{1}", seatLabel(seat, ctx.rules.locale), done.length ? done.join('、') : gameText(ctx.rules.locale, "未用药")));
        }
      },
      fallback: (ctx) => ({ tool: 'witch_act', args: { ...(choosesAntidoteTarget(ctx.rules) ? { saveTarget: null } : { save: false }), poisonTarget: null } }),
    },
  },
};

function witchTool(seats: Seat[], rules: RuleSet): ToolSpec {
  const { locale } = rules;
  if (choosesAntidoteTarget(rules)) return {
    name: 'witch_act',
    title: gameText(locale, "用药"),
    description: gameText(locale, "提交用药决定。saveTarget 和 poisonTarget 分别填写解药和毒药的目标座位号，null 表示不用对应的药；只填写本轮提供的字段。例：{\"saveTarget\":null,\"poisonTarget\":3}。"),
    params: [
      seatParam('saveTarget', gameText(locale, "解药目标"), seats, gameText(locale, "不用解药")),
      seatParam('poisonTarget', gameText(locale, "毒药目标"), seats, gameText(locale, "不用毒药")),
    ],
  };
  return {
    name: 'witch_act',
    title: gameText(locale, "用药"),
    description: gameText(locale, "提交用药决定。save 为 true 表示使用解药救刀口，false 表示不用解药；poisonTarget 填毒药目标座位号，null 表示不用毒药。只填写本轮提供的字段。例：{\"save\":false,\"poisonTarget\":3}。"),
    params: [
      { kind: 'boolean', name: 'save', label: gameText(locale, "使用解药"), trueLabel: gameText(locale, "救"), falseLabel: gameText(locale, "不救") },
      seatParam('poisonTarget', gameText(locale, "毒药目标"), seats, gameText(locale, "不用毒药")),
    ],
  };
}
