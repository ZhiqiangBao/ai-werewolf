import type { Clip, Script } from './project';

/** Labels use the real cast identity, never a role claimed in the speech. */
export function speakerIdentity(script: Pick<Script, 'cast'>, clip: Pick<Clip, 'seat' | 'voiceKey' | 'type' | 'data'>) {
  if (clip.seat !== undefined) {
    const player = script.cast.find((c) => c.seat === clip.seat);
    if (!player) throw Error(`Missing speaker seat ${clip.seat}`);
    const marker = clip.data.systemFallback ? '系统托管' : clip.type === 'hosting.choice' ? '行动转述' : clip.type === 'wolf.chat' ? '狼队密谈' : '';
    return { kind: 'player' as const, seat: player.seat, title: `${player.seat}号 · ${player.roleName}`, name: player.name, marker };
  }
  return clip.voiceKey === 'commentator'
    ? { kind: 'commentator' as const, title: '上帝解说', name: '全知视角', marker: '' }
    : { kind: 'judge' as const, title: '法官', name: '流程主持', marker: '' };
}
