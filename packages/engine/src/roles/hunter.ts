import { gameText, isEnglishGameLocale } from '@werewolf/protocol';
import type { RuleSet, ToolSpec } from '@werewolf/protocol';
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
        const inheritOrigin = hunterCanShootOnShot(ctx.rules);
        ctx.player(seat).revealed = true;
        ctx.player(seat).revealedAs = 'hunter';
        ctx.kill(target, {
          via: 'shot',
          causes: ['shot'],
          by: seat,
          // New chains retain the first elimination's timing. Legacy saves keep
          // their historical direct-shooter classification and date behavior.
          shooterVia: inheritOrigin && own?.via === 'shot' ? own.shooterVia ?? own.via : own?.via,
          ...(inheritOrigin && own ? { day: own.day } : {}),
          batch: step.batch as number,
        });
        ctx.state.history.shots.push(gameText(ctx.rules.locale, "第{0}天 {1}开枪带走{2}", ctx.state.day, seatLabel(seat, ctx.rules.locale), seatLabel(target, ctx.rules.locale)));
        ctx.pub('hunter.shot', gameText(ctx.rules.locale, "{0}开枪，{1}出局。", seatLabel(seat, ctx.rules.locale), seatLabel(target, ctx.rules.locale)), { shooter: seat, target, role: 'hunter' });
      },
      fallback: (ctx) => ({ tool: 'hunter_shoot', args: { target: null } }),
    },
  },
};

export function hunterAllowedCauseNames(rules: RuleSet): string[] {
  const v = rules.values;
  const hasWolfAttack = rules.roles.includes('werewolf') || rules.roles.includes('awakened_wolf');
  const hasPoison = rules.roles.includes('witch');
  const hasGuardAndSave = rules.roles.includes('guard') && rules.roles.includes('witch') && v['resolve.guardAndSaveKills'] === true;
  return [
    hasWolfAttack && v['hunter.shootOnKnife'] && gameText(rules.locale, "狼人攻击造成的出局"),
    v['hunter.shootOnVote'] && gameText(rules.locale, "被放逐"),
    hasPoison && v['hunter.shootOnPoison'] && gameText(rules.locale, "出局原因含毒药"),
    hasGuardAndSave && v['hunter.shootOnGuardAndSave'] && gameText(rules.locale, rules.roles.includes('awakened_wolf')
      ? "守卫或模仿守卫的保护与女巫解药同时作用于狼人攻击目标造成的出局"
      : "守卫守护和女巫解药同时作用于狼人攻击目标造成的出局"),
    hunterCanShootOnShot(rules) && rules.roles.includes('hunter') && rules.roles.includes('awakened_wolf') &&
      gameText(rules.locale, "猎枪造成的出局"),
  ].filter((cause): cause is string => typeof cause === 'string');
}

export function hunterPoisonIsExcluded(rules: RuleSet): boolean {
  return rules.roles.includes('witch') && rules.values['hunter.shootOnPoison'] !== true;
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
    description: gameText(locale, "猎人符合本局开枪条件且法官允许时使用。target 是要带走的存活玩家，null 表示放弃开枪。开枪会公开猎人身份。不能射自己。例：{\"target\":3} 为带走3号，{\"target\":null} 为放弃。是否能发动由出局原因和本局规则决定，以法官询问为准。其他阶段不要调用。"),
    params: [seatParam('target', gameText(locale, "开枪目标"), seats, gameText(locale, "放弃开枪"))],
  };
}
