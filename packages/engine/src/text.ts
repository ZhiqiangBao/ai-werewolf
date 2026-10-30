import type { Seat } from '@werewolf/protocol';
import type { Direction } from './types';

export const seatLabel = (s: Seat): string => `${s}号`;

export const seatList = (seats: Seat[]): string =>
  [...seats].sort((a, b) => a - b).map(seatLabel).join('、');

export const orderList = (seats: Seat[]): string => seats.map(seatLabel).join('、');

export const directionLabel = (d: Direction): string =>
  d === 'clockwise' ? '顺时针（号码增大）' : '逆时针（号码减小）';

/** 内部权重为 2 的整数，展示时除以 2。 */
export const weightLabel = (w: number): string => {
  const v = w / 2;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

export const factionName = (f: string): string =>
  f === 'wolf' ? '狼人阵营' : f === 'good' ? '好人阵营' : f;

export const categoryName = (c: string): string =>
  c === 'god' ? '神职' : c === 'villager' ? '平民' : c === 'wolf' ? '狼人' : c;
