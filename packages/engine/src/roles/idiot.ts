import { seatLabel } from '../text';
import type { RoleModule } from '../types';

/** 扩展身份示例：只用 beforeExile 与 canVote 两个钩子接入，不改核心流程。 */
export const idiot: RoleModule = {
  id: 'idiot',
  name: '白痴',
  faction: 'good',
  category: 'god',
  maxPerGame: 1,
  summary: '被投票放逐时翻牌，留在场上但此后失去投票权。',
  options: [
    {
      key: 'idiot.badgeOnFlip',
      group: '白痴',
      label: '警长白痴翻牌后',
      type: 'choice',
      choices: [
        { value: 'lost', label: '警徽流失' },
        { value: 'keep', label: '保留警徽（仍不能投票）' },
      ],
      default: 'lost',
      editable: true,
    },
  ],

  ruleCard(rules) {
    return [
      '白痴：被投票放逐时翻牌亮明身份，留在场上，此后不能投票但仍可发言；翻牌后再被放逐则出局。被刀、被毒、被枪正常出局。' +
        (rules.values['idiot.badgeOnFlip'] === 'lost' ? '警长白痴翻牌后警徽流失。' : '警长白痴翻牌后保留警徽。'),
    ];
  },

  setup(ctx, seats) {
    for (const s of seats) ctx.player(s).data.flipped = false;
  },

  appendix(ctx, seat) {
    return [ctx.player(seat).data.flipped ? '你已翻牌，不能再投票，仍可发言。' : '你被投票放逐时会翻牌留在场上。'];
  },

  beforeExile(ctx, seat) {
    const p = ctx.player(seat);
    if (p.data.flipped) return false;
    p.data.flipped = true;
    p.revealed = true;
    ctx.pub('idiot.flip', `${seatLabel(seat)}被投票放逐，翻牌：白痴。留在场上，此后不能投票。`, { seat, role: 'idiot' });
    if (ctx.state.sheriff === seat && ctx.opt<string>('idiot.badgeOnFlip') === 'lost') {
      ctx.state.sheriff = null;
      ctx.state.history.badge.push(`第${ctx.state.day}天 ${seatLabel(seat)}翻牌白痴，警徽流失`);
      ctx.pub('badge.lost', `${seatLabel(seat)}翻牌后警徽流失。`, { from: seat });
    }
    return true;
  },

  canVote(ctx, seat) {
    return !ctx.player(seat).data.flipped;
  },
};
