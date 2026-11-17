import { gameText } from '@werewolf/protocol';
import type { NightActionRound, Seat, ToolSpec } from '@werewolf/protocol';
import { grantAbility, merchantAbilities } from '../abilities';
import type { GiftSkill } from '../abilities';
import { giftSkillName } from '../lucky-abilities';
import { roleData } from '../role-data';
import { seatLabel } from '../text';
import { seatParam } from '../tools';
import type { RoleModule } from '../types';

const giftSkills: GiftSkill[] = ['seer', 'poison', 'guard'];
const waitTool = (locale?: string): ToolSpec => ({
  name: 'merchant_wait', title: gameText(locale, '本夜等待'),
  description: gameText(locale, '本夜等待，保留交易机会。无参数，填写 {}。'), params: [],
});

function merchantTools(targets: Seat[], locale: string | undefined, v2: boolean): ToolSpec[] {
  const gift: ToolSpec = {
    name: 'merchant_gift', title: gameText(locale, '赠予技能'),
    description: gameText(locale, '选择一名其他存活玩家和一种技能，使用整局唯一一次交易机会。'),
    params: [
      seatParam('target', gameText(locale, '赠予目标'), targets),
      { kind: 'choice', name: 'skill', label: gameText(locale, '赠予技能'),
        options: giftSkills.map((value) => ({ value, label: giftSkillName(locale, value) })) },
    ],
  };
  return v2 ? [gift] : [gift, waitTool(locale)];
}

export const miracleMerchant: RoleModule = {
  id: 'miracle_merchant',
  name: '奇迹商人',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '每夜可以等待，或用整局一次的交易机会赠予查验、毒药或守护。选中狼人会反噬出局。',
  nightPhase: { id: 'miracle_merchant', order: 8 },
  tools: ({ seats, seat, rules }) => merchantTools(seats.filter((s) => s !== seat), rules.locale, rules.toolsetVersion === 2),
  appendix(ctx, seat) {
    const gift = roleData(ctx.player(seat), 'miracle_merchant').gift;
    const locale = ctx.rules.locale;
    return [gift
      ? gameText(locale, '第{0}夜，你选择向{1}赠予{2}，交易机会已用完。', gift.night, seatLabel(gift.target, locale), giftSkillName(locale, gift.skill))
      : gameText(locale, '你还有一次交易机会。你可以等待，也可以选择一名其他存活玩家赠予技能。')];
  },
  steps: {
    'night:miracle_merchant': {
      run(ctx, step) {
        const seat = ctx.seatsOf('miracle_merchant')[0];
        if (seat === undefined || roleData(ctx.player(seat), 'miracle_merchant').gift) return;
        const locale = ctx.rules.locale;
        ctx.ask({
          step, actors: [seat],
          tools: () => merchantTools(ctx.alive().filter((s) => s !== seat), locale, ctx.rules.toolsetVersion === 2),
          prompt: () => gameText(locale, '请选择一名其他存活玩家赠予查验、毒药或守护，或等待并保留交易机会。法官只回执你的选择。'),
          title: gameText(locale, '第{0}夜 · 奇迹商人', ctx.state.day),
          publicStage: gameText(locale, '夜晚'),
        });
      },
      decide(ctx, _step, subs) {
        const seat = Number(Object.keys(subs)[0]);
        const call = subs[seat];
        const target = call.tool === 'merchant_wait' ? null : call.args.target as Seat | null;
        const locale = ctx.rules.locale;
        const night = ctx.state.night!;
        const round: NightActionRound = {
          roundKind: 'merchant', roundId: `night-${night.n}-merchant`,
          actionKind: target === null ? 'wait' : 'gift', actorSeatId: seat, targetSeatId: target,
        };
        if (target === null) {
          ctx.priv([seat], 'merchant.wait', gameText(locale, '你选择等待，保留交易机会。'), {}, round);
          night.lines.push(gameText(locale, '奇迹商人（{0}）等待', seatLabel(seat, locale)));
          return;
        }
        const skill = call.args.skill as GiftSkill;
        const name = giftSkillName(locale, skill);
        roleData(ctx.player(seat), 'miracle_merchant').gift = { night: night.n, target, skill };
        ctx.priv([seat], 'merchant.gift', gameText(locale, '你选择向{0}赠予{1}。', seatLabel(target, locale), name), { target, skill }, round);
        night.lines.push(gameText(locale, '奇迹商人（{0}）选择向{1}赠予{2}', seatLabel(seat, locale), seatLabel(target, locale), name));
        if (ctx.roleOf(target).faction === 'wolf') {
          night.attacks.push({ target: seat, kind: 'merchant_backfire', by: [seat] });
          return;
        }
        grantAbility(ctx, target, merchantAbilities[skill], {
          id: `lucky:${target}`, active: true, activeFromNight: night.n, source: 'miracle_merchant',
        });
        ctx.priv([target], 'merchant.gift.received',
          gameText(locale, '你成为幸运儿，获得一次{0}。从今夜起可在幸运儿阶段使用，也可留到后续夜晚。', name),
          { skill, activeFromNight: night.n });
      },
      fallback: () => ({ tool: 'merchant_gift', args: { target: null, skill: null } }),
    },
  },
};
