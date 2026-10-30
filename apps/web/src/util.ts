import type { Audience, Catalog } from '@werewolf/protocol';

export const seatName = (seat: number) => `${seat}号`;

/** 按身份目录里的阵营和类别上色，新增身份不需要改网页。 */
export function roleTone(catalog: Catalog | null, role?: string): string {
  const r = role ? catalog?.roles.find((x) => x.id === role) : undefined;
  if (!r) return '';
  return r.faction === 'wolf' ? 'wolf' : r.category === 'villager' ? 'villager' : 'god';
}

export function audienceText(a: Audience): string {
  if (a === 'public') return '公开';
  if (!a.length) return '仅上帝';
  return `受众：${a.map(seatName).join('、')}`;
}

export function phaseLabel(day: number, phase: string): string {
  if (phase === 'setup' || day === 0) return '准备';
  if (phase === 'end') return '终局';
  return `第${day}${phase === 'night' ? '夜' : '天'}`;
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
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
