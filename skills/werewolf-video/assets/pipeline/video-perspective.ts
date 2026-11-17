import type { Script } from './project';
import { videoRole, videoText, videoUiLocale } from './video-locale';

/** The selected view and only the identity already visible in its cast. */
export function videoPerspectiveLabel(script: Pick<Script, 'perspective' | 'playerSeat' | 'cast' | 'uiLocale'>, locale = videoUiLocale(script.uiLocale)): string {
  if (script.perspective === 'god') return videoText(locale, '全知视角');
  if (script.perspective === 'player') {
    if (!Number.isInteger(script.playerSeat) || !script.playerSeat || script.playerSeat < 1) throw Error('Player view requires a seat');
    const own = script.cast.find(player => player.seat === script.playerSeat);
    if (!own) throw Error('Player view seat is missing from cast');
    const label = videoText(locale, '{0}号玩家视角', script.playerSeat);
    return own.role === 'unknown' ? label : `${label} · ${videoRole(locale, own.role, own.roleName)}`;
  }
  if (script.perspective === 'public') return ({ 'zh-CN': '公开视角', en: 'Public view', ja: '公開視点' } as Record<string, string>)[locale] ?? 'Public view';
  throw Error(`Unsupported video perspective: ${script.perspective}`);
}
export function verticalVideoTitle(script: Pick<Script, 'perspective' | 'playerSeat' | 'cast' | 'uiLocale'>, locale = videoUiLocale(script.uiLocale)): string {
  return `${videoText(locale, 'AI 狼人杀')} · ${videoPerspectiveLabel(script, locale)}`;
}
