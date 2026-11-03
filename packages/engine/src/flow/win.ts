import { gameText } from '@werewolf/protocol';
import type { GameResult } from '@werewolf/protocol';
import type { Ctx } from '../context';

/** 新版在死亡批次及各项出局职责前检查；旧版在技能处理后检查。双方同时满足时好人优先。 */
export function evaluateWin(ctx: Ctx): GameResult | null {
  const players = ctx.state.players.map((p) => ({ p, mod: ctx.roleOf(p.seat) }));
  const alive = players.filter((x) => x.p.alive);
  if (!alive.some((x) => x.mod.faction === 'wolf')) {
    return { winner: 'good', winnerName: gameText(ctx.rules.locale, "好人阵营"), reason: gameText(ctx.rules.locale, "所有狼人出局。") };
  }
  if (ctx.opt<string>('winCondition') === 'side') {
    const gods = players.filter((x) => x.mod.category === 'god');
    if (gods.length && !gods.some((x) => x.p.alive)) {
      return { winner: 'wolf', winnerName: gameText(ctx.rules.locale, "狼人阵营"), reason: gameText(ctx.rules.locale, "所有神职出局（屠边）。") };
    }
    const villagers = players.filter((x) => x.mod.category === 'villager');
    if (villagers.length && !villagers.some((x) => x.p.alive)) {
      return { winner: 'wolf', winnerName: gameText(ctx.rules.locale, "狼人阵营"), reason: gameText(ctx.rules.locale, "所有平民出局（屠边）。") };
    }
  } else if (!alive.some((x) => x.mod.faction === 'good')) {
    return { winner: 'wolf', winnerName: gameText(ctx.rules.locale, "狼人阵营"), reason: gameText(ctx.rules.locale, "所有好人出局（屠城）。") };
  }
  return null;
}
