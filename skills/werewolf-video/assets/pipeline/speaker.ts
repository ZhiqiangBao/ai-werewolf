import type { Clip, Script } from './project';
import { videoLocale, videoRole, videoText } from './video-locale';

/** Labels use the real cast identity, never a role claimed in the speech. */
export function speakerIdentity(script: Pick<Script, 'cast'> & Partial<Pick<Script, 'locale'>>, clip: Pick<Clip, 'seat' | 'voiceKey' | 'type' | 'data'>, locale = videoLocale(script.locale)) {
  if (clip.seat !== undefined) {
    const player = script.cast.find((c) => c.seat === clip.seat);
    if (!player) throw Error(`Missing speaker seat ${clip.seat}`);
    const marker = clip.data.systemFallback ? '系统托管' : clip.type === 'hosting.choice' ? '行动转述' : clip.type === 'wolf.chat' ? '狼队密谈' : '';
    return { kind: 'player' as const, seat: player.seat, title: videoText(locale, '{0}号 · {1}', player.seat, videoRole(locale, player.role, player.roleName)), name: player.name, marker: marker ? videoText(locale, marker) : '' };
  }
  return clip.voiceKey === 'commentator'
    ? { kind: 'commentator' as const, title: videoText(locale, '上帝解说'), name: videoText(locale, '全知视角'), marker: '' }
    : { kind: 'judge' as const, title: videoText(locale, '法官'), name: videoText(locale, '流程主持'), marker: '' };
}
