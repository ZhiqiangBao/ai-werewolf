import { gameText, isEnglishGameLocale } from '@werewolf/protocol';
import type { Seat, ToolSpec } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { getRole } from '../registry';
import { seatLabel } from '../text';
import { err, seatParam } from '../tools';
import type { RoleModule } from '../types';
import { hunter } from './hunter';
import { abilityAction, abilityNightSteps, findAbility, grantAbility } from '../abilities';
import { copiedDefinition, poisonTool, guardTool, clawTool, skipSkill } from '../copied-abilities';
import { roleData } from '../role-data';
import { allRoleChecks, inspectionAppendix, inspectionKnowledge, mirrorTool } from './inspection';
import { wolfKillFallbackTarget, wolfKillTargets } from './werewolf';

const data = (ctx: Ctx, seat: Seat) => roleData(ctx.player(seat), 'awakened_wolf').awakened;
const learnedAbility = (ctx: Ctx, seat: Seat) => {
  const learned = data(ctx, seat).learned;
  return learned ? findAbility(ctx, seat, learned.abilityId) : undefined;
};
const holders = (ctx: Ctx) => ctx.seatsOf('awakened_wolf');
const action = (name: string, title: string, description: string, seats?: Seat[], locale: string | undefined = 'zh-CN'): ToolSpec => ({
  name, title, description, params: seats ? [seatParam('targetSeat', gameText(locale, "目标玩家"), seats, undefined)] : [],
});
const killTool = (seats: Seat[], locale: string | undefined = 'zh-CN') => action('awakened_kill', gameText(locale, "提交继承狼刀"), gameText(locale, "对 targetSeat 提交继承狼刀。填写目标座位号，例如 {\"targetSeat\":3}。"), seats, locale);
const emptyKill = (locale: string | undefined = 'zh-CN') => action('awakened_empty_kill', gameText(locale, "继承狼刀空刀"), gameText(locale, "继承狼刀选择空刀。无参数，填写 {}。"), undefined, locale);
const mimicTool = (seats: Seat[], locale: string | undefined = 'zh-CN') => action('awakened_mimic', gameText(locale, "模仿一名玩家"), gameText(locale, "模仿 targetSeat 指定的玩家。填写目标座位号，例如 {\"targetSeat\":3}。"), seats, locale);
const waitTool = (locale: string | undefined = 'zh-CN') => action('awakened_wait', gameText(locale, "本夜暂不模仿"), gameText(locale, "本夜不模仿。无参数，填写 {}。"), undefined, locale);
export const awakenedWolf: RoleModule = {
  abilityCatalog: ['mirror', 'poison', 'guard', 'wolf', 'hunter', 'none'],
  id: 'awakened_wolf', name: '觉醒隐狼', faction: 'wolf', category: 'wolf', maxPerGame: 1,
  inspectAs: 'good', wolfTeam: false, canExplode: false,
  summary: '不与小狼互认、不能自爆。整局模仿一次，立即改变具体身份查验表现，当夜结束获得技能；其余狼人全灭后下一夜继承刀权。',
  nightPhases: [
    { id: 'awakened_mimic', order: 5, name: '觉醒隐狼模仿' },
    { id: 'awakened_knife', order: 25, name: '觉醒隐狼继承狼刀' },
    { id: 'awakened_skill', order: 45, name: '觉醒隐狼模仿技能' },
  ],
  tools: ({ seats, rules }) => [
    mimicTool(seats, rules.locale), waitTool(rules.locale), killTool(seats, rules.locale), ...(rules.values['wolf.allowEmpty'] ? [emptyKill(rules.locale)] : []),
    mirrorTool(seats, rules.locale), poisonTool(seats, rules.locale), guardTool(seats, rules.locale), clawTool(seats, rules.locale), skipSkill(rules.locale),
    ...(hunter.tools?.({ seat: 0, seats, rules }) ?? []),
  ],
  setup(ctx, seats) {
    for (const seat of seats) {
      ctx.player(seat).data.awakened = { learned: null, knifeFromNight: null };
      ctx.player(seat).data.roleChecks = [];
      ctx.priv([seat], 'awakened.identity', gameText(ctx.rules.locale, "你是觉醒隐狼，真实阵营始终为狼人。你与其他狼人互不知晓身份，不参与他们的密谈，也不能自爆。"));
    }
  },
  inspectRole: (ctx, seat) => data(ctx, seat).learned?.role ?? 'awakened_wolf',
  knowledge: inspectionKnowledge,
  appendix(ctx, seat) {
    const d = data(ctx, seat);
    const l = d.learned;
    const ability = learnedAbility(ctx, seat);
    const skill = ability ? { kind: ability.definition, available: ability.state.available, last: ability.state.last as Seat | null, claw: ability.state.claw } : undefined;
    return [
      gameText(ctx.rules.locale, "你始终属于狼人阵营，但不参与普通狼队密谈、不能自爆，其他狼人身份不会因继承刀权而告诉你。"),
      l ? gameText(ctx.rules.locale, "你模仿了 {0}（{1}）。查验表现已改变。{2}，夜间主动技能从第{3}夜可用。", seatLabel(l.target, ctx.rules.locale), gameText(ctx.rules.locale, getRole(l.role).name), l.active ? gameText(ctx.rules.locale, "复制技能已获得") : gameText(ctx.rules.locale, "当夜结束后才获得技能"), l.activeFromNight) : gameText(ctx.rules.locale, "你尚未模仿。从第1夜起，每晚轮到模仿阶段时均可选择本夜模仿或暂不模仿；整局只能成功模仿一次。"),
      ...(skill?.kind === 'poison' ? [gameText(ctx.rules.locale, "模仿毒药：{0}；没有解药。", skill.available ? gameText(ctx.rules.locale, "尚有一瓶") : gameText(ctx.rules.locale, "已用完"))] : []),
      ...(skill?.kind === 'guard' ? [gameText(ctx.rules.locale, "上次增强守护：{0}。", skill.last === null ? gameText(ctx.rules.locale, "空守或尚未行动") : seatLabel(skill.last, ctx.rules.locale))] : []),
      ...(skill?.kind === 'wolf' ? [gameText(ctx.rules.locale, "额外爪击：{0}。", skill.claw ? gameText(ctx.rules.locale, "尚未使用，须继承刀权后才可发动") : gameText(ctx.rules.locale, "已用完"))] : []),
      ...(skill?.kind === 'hunter' ? [gameText(ctx.rules.locale, ctx.rules.deathResolutionVersion === 2
        ? ctx.rules.hunterShotVersion === 2
          ? "模仿猎人：学习夜天亮出局时，按猎人规则判断是否可开枪；若猎枪造成你的出局，且胜负未分、枪仍可用，可继续选择开枪或放弃。"
          : "模仿猎人：学习夜天亮出局时，开枪条件与猎人规则相同；若胜负已分，不再发动开枪技能。"
        : "模仿猎人：学习夜天亮出局时，开枪条件与猎人规则相同。")] : []),
      d.knifeFromNight === null ? gameText(ctx.rules.locale, "尚未继承狼刀。") : gameText(ctx.rules.locale, "已从第{0}夜起继承普通狼刀，每夜独立落刀。", d.knifeFromNight),
      inspectionAppendix(ctx, seat, allRoleChecks(ctx, seat)),
    ];
  },
  ruleCard(rules) {
    const has = (id: string) => rules.roles.includes(id);
    const isUnifiedNightOrder = rules.awakenedNightVersion === 2;
    const canContinueShot = has('hunter') && has('awakened_wolf') &&
      rules.hunterShotVersion === 2 && rules.deathResolutionVersion === 2;
    const details: string[] = [];
    const hunterDetail = has('hunter') ? gameText(rules.locale, canContinueShot
      ? "模仿猎人：学习夜结束后取得猎人技能；学习夜天亮出局时，按猎人规则判断是否可开枪；胜负已分时不再开枪。若猎枪造成你的出局，且胜负未分、枪仍可用，可继续选择开枪或放弃；连续开枪时，被枪带走玩家的遗言资格按第一枪触发的出局情形确定。"
      : rules.deathResolutionVersion === 2
        ? "模仿猎人：学习夜结束后取得猎人技能；学习夜天亮出局时，开枪条件与猎人规则相同；若胜负已分，不再发动开枪技能。"
        : "模仿猎人：学习夜结束后取得猎人技能；学习夜天亮出局时，开枪条件与猎人规则相同。") : undefined;
    if (has('mirror_maiden')) details.push(gameText(rules.locale, "模仿魔镜：独立查验具体身份，不可重复。"));
    if (has('witch')) details.push(gameText(rules.locale, "模仿女巫：独立一毒无解药，不继承已用库存。"));
    if (has('guard')) details.push(gameText(rules.locale, "模仿守卫：独立记录，可自守不可连守，也可以阻挡毒药。"));
    if (has('werewolf')) details.push(gameText(rules.locale, isUnifiedNightOrder
      ? "模仿狼人：获得一次额外爪击；其他普通狼人全部出局后的夜间，可在觉醒隐狼轮次选择发动或保留。额外爪击按狼刀结算。"
      : "模仿狼人：额外获得一次爪击，技能启用且继承刀权后可用，也可保留；按狼刀结算。继承狼刀与模仿技能独立决策。"));
    const noAbilityRoles = [...new Set(rules.roles.filter((id) => id !== 'awakened_wolf' && !getRole(id).copiedAbility))].map((id) => gameText(rules.locale, getRole(id).name));
    if (noAbilityRoles.length) {
      const noAbilityNames = isEnglishGameLocale(rules.locale) && noAbilityRoles.length > 1
        ? `${noAbilityRoles.slice(0, -1).join(', ')} and ${noAbilityRoles[noAbilityRoles.length - 1]}`
        : noAbilityRoles.join(isEnglishGameLocale(rules.locale) ? ', ' : '、');
      details.push(gameText(rules.locale, "模仿{0}不获得主动技能。", noAbilityNames));
    }
    return [
      gameText(rules.locale, isUnifiedNightOrder
        ? "觉醒隐狼：真实身份和胜负归属始终为狼；与普通狼互不知晓，不密谈、不自爆。尚未成功模仿时，每夜自己的行动轮次可模仿一名其他存活玩家或暂不模仿；整局只能成功一次。立即得知目标真实身份并改变自身具体身份查验表现，目标不获通知；阵营查验始终显示好人。"
        : "觉醒隐狼：真实身份和胜负归属始终为狼；与普通狼互不知晓，不密谈、不自爆。每夜可模仿一名其他存活玩家或暂不模仿，整局仅成功一次。立即得知目标真实身份并改变自身具体身份查验表现，目标不获通知；阵营查验始终显示好人。"),
      gameText(rules.locale, isUnifiedNightOrder
        ? "模仿和已学的夜间主动技能在觉醒隐狼自己的同一夜间轮次处理。成功模仿后，技能在当夜结束时获得；夜间主动技能从下一夜起可用。"
        : "学习夜结束时取得所模仿的技能；夜间主动技能从下一夜起可用；模仿没有主动技能的身份时不会获得技能。"),
      ...(hunterDetail ? [gameText(rules.locale, "{0}只公开猎人表现，终局公开真实身份。", hunterDetail)] : []),
      ...details,
      gameText(rules.locale, has('werewolf')
        ? isUnifiedNightOrder
          ? "其他普通狼人全部出局后，觉醒隐狼从下一夜起负责普通狼人的攻击，并在狼人轮次单独提交；不获得队友资料。"
          : "其他普通狼人全部出局后，觉醒隐狼从下一夜起负责普通狼人的攻击；不获得队友资料。"
        : isUnifiedNightOrder
          ? "从第 1 夜起负责普通狼人的攻击，并在狼人轮次单独提交；不获得队友资料。"
          : "从第 1 夜起负责普通狼人的攻击；不获得队友资料。"),
    ];
  },
  nightStart(ctx) {
    for (const seat of holders(ctx)) {
      const d = data(ctx, seat);
      if (d.knifeFromNight === null && !ctx.alive().some((s) => s !== seat && ctx.roleOf(s).faction === 'wolf')) {
        d.knifeFromNight = ctx.state.day;
        const text = ctx.rules.awakenedNightVersion === 2 && !ctx.rules.roles.includes('werewolf')
          ? gameText(ctx.rules.locale, "你从今晚开始负责普通狼人的攻击。")
          : gameText(ctx.rules.locale, "其余狼人已经全部出局，你从今晚开始继承普通狼刀。");
        ctx.priv([seat], 'awakened.inherit', text, { night: ctx.state.day });
      }
    }
  },
  afterNight(ctx) {
    for (const seat of holders(ctx)) {
      const l = data(ctx, seat).learned;
      if (!l || l.active) continue;
      l.active = true;
      findAbility(ctx, seat, l.abilityId).active = true;
      ctx.priv([seat], 'awakened.activated', gameText(ctx.rules.locale, "学习夜已结束，你已获得{0}的模仿技能。夜间主动技能从第{1}夜起可用。", gameText(ctx.rules.locale, getRole(l.role).name), l.activeFromNight), { activeFromNight: l.activeFromNight });
    }
  },
  steps: {
    'night:awakened_mimic': {
      run(ctx, step) {
        if (ctx.rules.awakenedNightVersion === 2) ctx.pushFront({ type: 'night:awakened_skill' });
        const actors = holders(ctx).filter((s) => !data(ctx, s).learned && ctx.alive().some((x) => x !== s));
        if (!actors.length) return;
        ctx.ask({ step, actors, tools: (seat) => [mimicTool(ctx.alive().filter((s) => s !== seat), ctx.rules.locale), waitTool(ctx.rules.locale)],
          prompt: () => gameText(ctx.rules.locale, "选择一名其他存活玩家模仿，或本夜暂不模仿。模仿身份立即生效，技能在当夜结束后获得。"),
          title: gameText(ctx.rules.locale, "第{0}夜 · 模仿", ctx.state.day), publicStage: gameText(ctx.rules.locale, "夜晚") });
      },
      validate(ctx, _step, seat, call) {
        if (data(ctx, seat).learned) return err('MIMIC_USED', gameText(ctx.rules.locale, "你已经模仿过，不能再次模仿"));
        const target = call.args.targetSeat;
        if (call.tool === 'awakened_mimic' && typeof target === 'number' && target >= 1 && target <= ctx.playerCount) {
          if (target === seat) return err('TARGET_SELF_FORBIDDEN', gameText(ctx.rules.locale, "不能模仿自己"));
          if (!ctx.isAlive(target)) return err('TARGET_DEAD', gameText(ctx.rules.locale, "不能模仿已经出局的玩家"));
        }
        return null;
      },
      decide(ctx, _step, subs) {
        for (const [s, call] of Object.entries(subs)) {
          const seat = Number(s);
          if (call.tool === 'awakened_wait') { ctx.priv([seat], 'awakened.wait', gameText(ctx.rules.locale, "本夜暂不模仿，保留模仿机会。")); continue; }
          const target = call.args.targetSeat as Seat;
          const role = ctx.player(target).role;
          const abilityId = `mimic:${seat}`;
          grantAbility(ctx, seat, copiedDefinition(role), { id: abilityId, active: false, activeFromNight: ctx.state.day + 1, activateAfterNight: ctx.state.day, source: 'awakened_mimic' });
          data(ctx, seat).learned = { target, role, learnedNight: ctx.state.day, activeFromNight: ctx.state.day + 1, active: false, abilityId };
          ctx.priv([seat], 'awakened.mimic', gameText(ctx.rules.locale, "你模仿了{0}，目标真实身份为{1}。你的查验表现已改变，技能在当夜结束后获得。", seatLabel(target, ctx.rules.locale), gameText(ctx.rules.locale, getRole(role).name)), { target, role, activeFromNight: ctx.state.day + 1 });
          ctx.state.night?.lines.push(gameText(ctx.rules.locale, "觉醒隐狼（{0}）模仿 {1}（{2}）", seatLabel(seat, ctx.rules.locale), seatLabel(target, ctx.rules.locale), gameText(ctx.rules.locale, getRole(role).name)));
        }
      },
      fallback: (ctx) => ({ tool: 'awakened_wait', args: {} }),
    },
    'night:awakened_knife': {
      run(ctx, step) {
        const actors = holders(ctx).filter((s) => data(ctx, s).knifeFromNight !== null);
        if (!actors.length) return;
        ctx.ask({ step, actors, tools: (seat) => {
          const targets = ctx.rules.awakenedNightVersion === 2 ? wolfKillTargets(ctx, seat)
            : ctx.alive().filter((s) => ctx.opt<boolean>('wolf.allowTeammateTarget') || ctx.roleOf(s).faction !== 'wolf');
          return [killTool(targets, ctx.rules.locale), ...(ctx.opt<boolean>('wolf.allowEmpty') ? [emptyKill(ctx.rules.locale)] : [])];
        }, prompt: () => gameText(ctx.rules.locale, "你已继承普通狼刀，请独立提交今晚刀口。"), title: gameText(ctx.rules.locale, "第{0}夜 · 继承狼刀", ctx.state.day), publicStage: gameText(ctx.rules.locale, "夜晚") });
      },
      decide(ctx, _step, subs) {
        for (const [s, call] of Object.entries(subs)) {
          const seat = Number(s), target = call.tool === 'awakened_empty_kill' ? null : call.args.targetSeat as Seat;
          const n = ctx.state.night!;
          n.knife = target;
          if (target !== null) n.attacks.push({ target, kind: 'wolf', by: [seat] });
          ctx.priv([seat], 'awakened.knife', target === null ? gameText(ctx.rules.locale, "你今晚的继承狼刀为空刀。") : gameText(ctx.rules.locale, "你的继承狼刀选择了{0}。", seatLabel(target, ctx.rules.locale)), { target });
          n.lines.push(gameText(ctx.rules.locale, "觉醒隐狼（{0}）继承狼刀：{1}", seatLabel(seat, ctx.rules.locale), target === null ? gameText(ctx.rules.locale, "空刀") : seatLabel(target, ctx.rules.locale)));
        }
      },
      fallback(ctx, _step, seat) {
        const targetSeat = wolfKillFallbackTarget(ctx, seat);
        return targetSeat === null ? { tool: 'awakened_empty_kill', args: {} } : { tool: 'awakened_kill', args: { targetSeat } };
      },
    },
    'night:awakened_skill': {
      run(ctx, step) {
        if (step.abilityId) { abilityAction.run(ctx, step); return; }
        const steps = abilityNightSteps(ctx, holders(ctx), 'night:awakened_skill');
        if (!steps.length) return;
        const [first, ...rest] = steps;
        ctx.pushFront(...rest);
        abilityAction.run(ctx, first);
      },
      validate(ctx, step, seat, call) { return abilityAction.validate?.(ctx, legacyAbilityStep(ctx, step, seat), seat, call) ?? null; },
      decide(ctx, step, subs) {
        const seat = Number(Object.keys(subs)[0]);
        abilityAction.decide?.(ctx, legacyAbilityStep(ctx, step, seat), subs);
      },
      fallback(ctx, step, seat) { return abilityAction.fallback!(ctx, legacyAbilityStep(ctx, step, seat), seat); },
    },
  },
};

/** v0 快照可能已经停在技能询问；继续原 decision，不重新 ask。 */
function legacyAbilityStep(ctx: Ctx, step: import('../types').Step, seat: Seat): import('../types').Step {
  return step.abilityId ? step : { ...step, abilitySeat: seat, abilityId: data(ctx, seat).learned?.abilityId };
}
