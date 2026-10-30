import type { Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import type { Direction } from '../types';

function stepSeat(n: number, from: Seat, dir: Direction, i: number): Seat {
  return dir === 'clockwise' ? ((from - 1 + i) % n) + 1 : ((((from - 1 - i) % n) + n) % n) + 1;
}

/** nextAlive(from, direction)：沿方向找下一名在 pool 里的玩家（默认存活玩家），1 与 N 之间折返。 */
export function nextIn(n: number, from: Seat, dir: Direction, pool: Seat[]): Seat | null {
  const set = new Set(pool);
  for (let i = 1; i <= n; i++) {
    const s = stepSeat(n, from, dir, i);
    if (set.has(s)) return s;
  }
  return null;
}

export function nextAlive(ctx: Ctx, from: Seat, dir: Direction): Seat | null {
  return nextIn(ctx.playerCount, from, dir, ctx.alive());
}

/** 从 start（含）沿方向绕环一圈，只保留 pool 里的座位。 */
export function ringOrder(n: number, start: Seat, dir: Direction, pool: Seat[]): Seat[] {
  const set = new Set(pool);
  const out: Seat[] = [];
  for (let i = 0; i < n; i++) {
    const s = stepSeat(n, start, dir, i);
    if (set.has(s)) out.push(s);
  }
  return out;
}

/** 警长选择方向后的发言顺序：从警长下一位开始，警长最后。 */
export function sheriffOrder(ctx: Ctx, sheriff: Seat, dir: Direction): Seat[] {
  const first = nextAlive(ctx, sheriff, dir) ?? sheriff;
  return ringOrder(ctx.playerCount, first, dir, ctx.alive());
}

/** PK 发言：沿用本白天已宣布的方向和起点；还没有方向时按座位号升序。 */
export function pkOrder(ctx: Ctx, seats: Seat[]): Seat[] {
  const { direction, firstSpeaker } = ctx.state.dayState;
  if (direction && firstSpeaker !== null) return ringOrder(ctx.playerCount, firstSpeaker, direction, seats);
  return [...seats].sort((a, b) => a - b);
}

export function randomDirection(ctx: Ctx): Direction {
  return ctx.random() < 0.5 ? 'clockwise' : 'counterclockwise';
}
