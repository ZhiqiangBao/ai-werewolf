import type { CSSProperties } from 'react';
import type { Audience, Catalog } from '@werewolf/protocol';
import { gameText } from '@werewolf/protocol';
import { getUiLocale } from './i18n';

export const seatName = (seat: number) => `${seat}号`;

/** 每个座位一个固定色相：1 号到 12 号沿座位环走一圈彩虹。圆桌、日志、票型和选择器用同一套颜色认人。 */
export const seatHue = (seat: number): number => (8 + (seat - 1) * 30) % 360;

/** 把座位色相注入元素，样式表里用 hsl(var(--h) …) 取色。 */
export const seatStyle = (seat: number): CSSProperties => ({ '--h': seatHue(seat) }) as CSSProperties;

/** 按身份目录里的阵营和类别上色，新增身份不需要改网页。 */
export function roleTone(catalog: Catalog | null, role?: string): string {
  const r = role ? catalog?.roles.find((x) => x.id === role) : undefined;
  if (!r) return '';
  return r.faction === 'wolf' ? 'wolf' : r.category === 'villager' ? 'villager' : 'god';
}

export function audienceText(a: Audience, locale?: string): string {
  if (a === 'public') return gameText(locale, '公开');
  if (!a.length) return gameText(locale, '仅上帝');
  return gameText(locale, '受众：{0}', a.map((s) => gameText(locale, '{0}号', s)).join(gameText(locale, '、')));
}

export function phaseLabel(day: number, phase: string, locale?: string): string {
  if (phase === 'end') return gameText(locale, '终局');
  if (phase === 'setup' || day === 0) return gameText(locale, '准备');
  return gameText(locale, '第{0}{1}', day, gameText(locale, phase === 'night' ? '夜' : '天'));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export const link = (kind: 'host' | 'seat' | 'watch', roomId: string, token: string) =>
  `${location.origin}${location.pathname}#/${kind}/${roomId}/${token}`;

export function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(getUiLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));
}
