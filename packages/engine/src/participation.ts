import type { Seat } from '@werewolf/protocol';
import type { GameState, Step } from './types';

/** 只控制模型调用；不改变事件、订阅或任何真人投影。按完整死亡议程判断，兼容未存停止标记的旧局。 */
export function seatTasksComplete(state: GameState, seat: Seat): boolean {
  const player = state.players.find((p) => p.seat === seat);
  if (!player) return false;
  if (player.alive) return false;
  if (state.result) return true;
  const deaths = state.deaths.filter((d) => d.seat === seat);
  if (deaths.some((d) => !d.hooked)) return false;
  // 警徽职责尚未展开时，也必须继续收取上下文。
  if (state.sheriff === seat) return false;
  const batches = new Set(deaths.map((d) => d.batch));
  const relevant = (step: Step) => step.seat === seat || step.abilitySeat === seat || step.dutySeat === seat ||
    (['deaths.batch', 'lastwords'].includes(step.type) && typeof step.batch === 'number' && batches.has(step.batch) &&
      deaths.some((d) => d.batch === step.batch && d.lastWords));
  if (state.pending && (state.pending.actors.includes(seat) || relevant(state.pending.step))) return false;
  return !state.agenda.some(relevant);
}
