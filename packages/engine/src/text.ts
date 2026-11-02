import { gameText } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import type { Direction } from './types';

export const seatLabel = (s: Seat, locale: string | undefined = 'zh-CN'): string => gameText(locale, "{0}号", s);

export const seatList = (seats: Seat[], locale: string | undefined = 'zh-CN'): string =>
  [...seats].sort((a, b) => a - b).map((value) => seatLabel(value, locale)).join('、');

export const orderList = (seats: Seat[], locale: string | undefined = 'zh-CN'): string => seats.map((value) => seatLabel(value, locale)).join('、');

export const directionLabel = (d: Direction, locale: string | undefined = 'zh-CN'): string =>
  d === 'clockwise' ? gameText(locale, "顺时针（号码增大）") : gameText(locale, "逆时针（号码减小）");

/** 内部权重为 2 的整数，展示时除以 2。 */
export const weightLabel = (w: number): string => {
  const v = w / 2;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

export const factionName = (f: string, locale: string | undefined = 'zh-CN'): string =>
  f === 'wolf' ? gameText(locale, "狼人阵营") : f === 'good' ? gameText(locale, "好人阵营") : f;

export const categoryName = (c: string, locale: string | undefined = 'zh-CN'): string =>
  c === 'god' ? gameText(locale, "神职") : c === 'villager' ? gameText(locale, "平民") : c === 'wolf' ? gameText(locale, "狼人") : c;
