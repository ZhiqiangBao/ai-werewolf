import type { GameResult } from '@werewolf/protocol';
import type { Ctx } from '../context';

/** 胜负检查点：开枪全部处理完之后。狼人全部出局优先判定好人获胜。 */
export function evaluateWin(ctx: Ctx): GameResult | null {
  const players = ctx.state.players.map((p) => ({ p, mod: ctx.roleOf(p.seat) }));
  const alive = players.filter((x) => x.p.alive);
  if (!alive.some((x) => x.mod.faction === 'wolf')) {
    return { winner: 'good', winnerName: '好人阵营', reason: '所有狼人出局。' };
  }
  if (ctx.opt<string>('winCondition') === 'side') {
    const gods = players.filter((x) => x.mod.category === 'god');
    if (gods.length && !gods.some((x) => x.p.alive)) {
      return { winner: 'wolf', winnerName: '狼人阵营', reason: '所有神职出局（屠边）。' };
    }
    const villagers = players.filter((x) => x.mod.category === 'villager');
    if (villagers.length && !villagers.some((x) => x.p.alive)) {
      return { winner: 'wolf', winnerName: '狼人阵营', reason: '所有平民出局（屠边）。' };
    }
  } else if (!alive.some((x) => x.mod.faction === 'good')) {
    return { winner: 'wolf', winnerName: '狼人阵营', reason: '所有好人出局（屠城）。' };
  }
  return null;
}
