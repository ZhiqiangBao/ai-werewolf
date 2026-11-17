import { gameText, isEnglishGameLocale } from '@werewolf/protocol';
import type { RuleSet, ToolSpec } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import { seatLabel } from '../text';
import { seatParam } from '../tools';
import type { DeathRecord, RoleModule, Step } from '../types';
import type { Ctx } from '../context';

const bool = (key: string, label: string, def: boolean, locale: string | undefined = 'zh-CN') => ({
  key,
  group: gameText(locale, "猎人"),
  label,
  type: 'boolean' as const,
  default: def,
  editable: false,
});

export const hunter: RoleModule = {
  copiedAbility: 'hunter',
  id: 'hunter',
  tools: ({ seats, rules }) => [hunterTool(seats, rules.locale)],
  name: '猎人',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '符合本局开枪条件时，法官才会询问；可选择向一名存活玩家开枪或放弃。',
  options: [
    bool('hunter.shootOnKnife', '被狼刀出局可以开枪', true),
    bool('hunter.shootOnVote', '被放逐可以开枪', true),
    bool('hunter.shootOnPoison', '出局原因含毒药可以开枪', false),
    bool('hunter.shootOnGuardAndSave', '同守同救出局可以开枪', true),
    bool('hunter.declineReveals', '放弃开枪公开身份', false),
  ],

  ruleCard(rules) {
    const v = rules.values;
    const can = hunterAllowedCauseNames(rules);
    const hasShootCause = can.length > 0;
    return [[
      (hasShootCause
        ? gameText(rules.locale, "猎人：以下出局原因符合本局开枪条件时，可开枪带走一名存活玩家，也可放弃：{0}。", can.join(isEnglishGameLocale(rules.locale) ? ', ' : '、'))
        : gameText(rules.locale, "猎人：本局没有可开枪的出局原因。")),
        (hunterPoisonIsExcluded(rules) ? gameText(rules.locale, "出局原因包含毒药时不能开枪。") : ''),
        (hasShootCause ? gameText(rules.locale, "符合发动条件时，法官私下询问本人；开枪结果和猎人表现公开。{0}", v['hunter.declineReveals'] ? gameText(rules.locale, "放弃开枪也会公开身份。") : gameText(rules.locale, "放弃开枪不公开身份。")) : ''),
        (rules.deathResolutionVersion === 2 ? gameText(rules.locale, "若胜负已分，不再发动开枪技能。") : ''),
    ].filter(Boolean).join(isEnglishGameLocale(rules.locale) ? ' ' : '')];
  },

  appendix: (ctx) => [[gameText(ctx.rules.locale, "是否可开枪由本局配置的出局原因决定；符合条件时，法官才会私下询问。你可以选择开枪或放弃。开枪会公开你的身份。"),
    (ctx.rules.deathResolutionVersion === 2 ? gameText(ctx.rules.locale, "若胜负已分，不再发动开枪技能。") : '')].filter(Boolean).join(isEnglishGameLocale(ctx.rules.locale) ? ' ' : '')],

  onDeath(ctx, death: DeathRecord) {
    return canHunterShoot(ctx.rules, death) ? [{ type: 'hunter.shoot', seat: death.seat, batch: death.batch }] : [];
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
        resolveShot(ctx, step, seat, target, 'hunter');
      },
      fallback: (ctx) => ({ tool: 'hunter_shoot', args: { target: null } }),
    },
  },
};

/** 共享枪击批次和遗言来源，按实际亮出的牌面发布对应角色事件。 */
export function resolveShot(ctx: Ctx, step: Step, seat: Seat, target: Seat | null, role: 'hunter' | 'wolf_king'): void {
  const locale = ctx.rules.locale;
  const shooter = seatLabel(seat, locale);
  const player = ctx.player(seat);
  if (target === null) {
    ctx.priv([seat], `${role}.decline`, gameText(locale, "你放弃了开枪。"), {});
    if (!ctx.opt<boolean>('hunter.declineReveals')) return;
    player.revealed = true;
    player.revealedAs = role;
    if (role === 'hunter') ctx.pub('hunter.decline', gameText(locale, "{0}是猎人，放弃开枪。", shooter), { seat });
    else ctx.pub('wolf_king.decline', gameText(locale, '{0}是狼王，放弃开枪。', shooter), { seat, role });
    return;
  }
  const own = ctx.state.deaths.find((death) => death.seat === seat);
  const inheritOrigin = hunterCanShootOnShot(ctx.rules);
  player.revealed = true;
  player.revealedAs = role;
  ctx.kill(target, {
    via: 'shot',
    causes: ['shot'],
    by: seat,
    // 新版枪击连锁沿用最初的出局时机，旧档保留原有的直接射手分类。
    shooterVia: inheritOrigin && own?.via === 'shot' ? own.shooterVia ?? own.via : own?.via,
    ...(inheritOrigin && own ? { day: own.day } : {}),
    batch: step.batch as number,
  });
  const victim = seatLabel(target, locale);
  ctx.state.history.shots.push(gameText(locale, "第{0}天 {1}开枪带走{2}", ctx.state.day, shooter, victim));
  ctx.pub(`${role}.shot`, gameText(locale, role === 'hunter' ? "{0}开枪，{1}出局。" : '狼王（{0}）开枪，{1}出局。', shooter, victim),
    { shooter: seat, target, role });
}

export function hunterAllowedCauseNames(rules: RuleSet): string[] {
  const v = rules.values;
  const hasMerchant = rules.roles.includes('miracle_merchant');
  const hasWolfAttack = rules.roles.some((id) => id === 'werewolf' || id === 'awakened_wolf' || id === 'wolf_king');
  const hasPoison = rules.roles.includes('witch') || hasMerchant;
  const hasGuardAndSave = (rules.roles.includes('guard') || hasMerchant) && rules.roles.includes('witch') && v['resolve.guardAndSaveKills'] === true;
  return [
    hasWolfAttack && v['hunter.shootOnKnife'] && gameText(rules.locale, "狼人攻击造成的出局"),
    v['hunter.shootOnVote'] && gameText(rules.locale, "被放逐"),
    hasPoison && v['hunter.shootOnPoison'] && gameText(rules.locale, "出局原因含毒药"),
    hasGuardAndSave && v['hunter.shootOnGuardAndSave'] && gameText(rules.locale, rules.roles.includes('awakened_wolf')
      ? "守卫或模仿守卫的保护与女巫解药同时作用于狼人攻击目标造成的出局"
      : "守卫守护和女巫解药同时作用于狼人攻击目标造成的出局"),
    hunterCanShootOnShot(rules) && rules.roles.includes('hunter') && (rules.roles.includes('awakened_wolf') || rules.roles.includes('wolf_king')) &&
      gameText(rules.locale, "猎枪造成的出局"),
  ].filter((cause): cause is string => typeof cause === 'string');
}

export function hunterPoisonIsExcluded(rules: RuleSet): boolean {
  return (rules.roles.includes('witch') || rules.roles.includes('miracle_merchant')) && rules.values['hunter.shootOnPoison'] !== true;
}

export function hunterCanShootOnShot(rules: RuleSet): boolean {
  return rules.hunterShotVersion === 2 && rules.deathResolutionVersion === 2;
}

/** 迁移和实际死亡职责共用当局的死因规则，不能把所有已处理死亡都当作开过枪。 */
export function canHunterShoot(rules: RuleSet, death: DeathRecord): boolean {
  const causes = death.causes;
  const allowed = (key: string) => rules.values[key] === true;
  if (causes.includes('poison') && !allowed('hunter.shootOnPoison')) return false;
  return (causes.includes('wolf') && allowed('hunter.shootOnKnife')) ||
    (causes.includes('guard_and_save') && allowed('hunter.shootOnGuardAndSave')) ||
    (causes.includes('exile') && allowed('hunter.shootOnVote')) ||
    (causes.includes('shot') && hunterCanShootOnShot(rules)) ||
    (causes.includes('poison') && allowed('hunter.shootOnPoison'));
}

function hunterTool(seats: Seat[], locale: string | undefined = 'zh-CN'): ToolSpec {
  return {
    name: 'hunter_shoot',
    title: gameText(locale, "开枪"),
    description: gameText(locale, "开枪带走 target 指定的玩家，或传 null 放弃开枪。例：{\"target\":3}、{\"target\":null}。"),
    params: [seatParam('target', gameText(locale, "开枪目标"), seats, gameText(locale, "放弃开枪"))],
  };
}
