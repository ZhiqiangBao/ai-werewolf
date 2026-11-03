type Viewer = { kind: 'god' } | { kind: 'spectator' } | { kind: 'seat'; seat: number };
type GameEvent = { seq: number; type: string; audience: 'public' | number[]; payload: Record<string, unknown> };

export type SkillEffectKind = 'poison' | 'shot' | 'inspect' | 'guard' | 'wolf';
export interface SkillEffect { kind: SkillEffectKind; target: number; sourceSeq: number }
export const SKILL_EFFECT_DURATION_MS = 1800;

/** 仅消费已授权投影中的事件；throughSeq 是当前播放位置，不得传入未来事实。 */
export function skillEffectForEvent(event: GameEvent, viewer: Viewer, throughSeq: number): SkillEffect | null {
  if (!Number.isInteger(throughSeq) || !Number.isInteger(event.seq) || event.seq < 1 || event.seq > throughSeq) return null;
  if (viewer.kind !== 'god' && event.audience !== 'public' &&
      (!Array.isArray(event.audience) || viewer.kind !== 'seat' || !event.audience.includes(viewer.seat))) return null;
  const p = event.payload;
  let kind: SkillEffectKind | undefined;
  let target: unknown = p.target;
  switch (event.type) {
    case 'witch.poison': kind = 'poison'; break;
    case 'hunter.shot': kind = 'shot'; break;
    case 'seer.result': case 'mirror.result': kind = 'inspect'; break;
    case 'guard.protect': kind = 'guard'; break;
    case 'wolf.kill.result': kind = 'wolf'; target = p.knife; break;
    case 'awakened.knife': kind = 'wolf'; break;
    case 'awakened.skill':
      kind = p.tool === 'awakened_poison' ? 'poison' : p.tool === 'awakened_guard' ? 'guard' : p.tool === 'awakened_claw' ? 'wolf' : undefined;
      break;
  }
  if (!kind || typeof target !== 'number' || !Number.isSafeInteger(target) || target < 1) return null;
  return { kind, target, sourceSeq: event.seq };
}

/** 100 × 100 坐标系，供 SVG 和离线 Canvas 消费；所有动画均由时间确定。 */
export interface SkillEffectShape {
  path: string;
  fill?: string;
  stroke?: string;
  width?: number;
  opacity?: number;
  transform?: string;
}
const path = (d: string, stroke: string, width = 3, opacity = 1, transform?: string): SkillEffectShape => ({ path: d, stroke, width, opacity, transform });
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function skillEffectFrame(kind: SkillEffectKind, elapsedMs: number): SkillEffectShape[] {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= SKILL_EFFECT_DURATION_MS) return [];
  const t = elapsedMs / SKILL_EFFECT_DURATION_MS;
  const fade = Math.min(1, t * 8, (1 - t) * 5);
  const grow = clamp(t * 2.5);
  const pulse = 1 + .08 * Math.sin(t * Math.PI * 6);
  const ring = (r: number, color: string, opacity: number): SkillEffectShape => path(`M ${50-r} 50 a ${r} ${r} 0 1 0 ${2*r} 0 a ${r} ${r} 0 1 0 ${-2*r} 0`, color, 2, opacity * fade);
  if (kind === 'poison') return [
    ring(24 + t * 20, '#b9f795', (1-t) * .7),
    { path: 'M42 22h16v9l10 15v25q0 6-6 6H38q-6 0-6-6V46l10-15Z', fill: '#2c8658', stroke: '#ccffbd', width: 2, opacity: fade, transform: `translate(0 ${-3 * Math.sin(t * Math.PI * 4)})` },
    path('M40 20h20v7H40Z M37 56q13-7 26 0 M44 61h.1 M55 57h.1 M51 68h.1', '#edffb6', 3, fade),
    ...[0, 1, 2].map((i) => ring(3 + i, '#d4ffb1', fade * .8)).map((s, i) => ({ ...s, transform: `translate(${(i-1)*10} ${-18 - ((t*32+i*11)%26)})` })),
  ];
  if (kind === 'shot') return [
    ring(15 + grow * 29, '#ffe19b', (1-grow*.65)),
    { path: 'M16 47h50v10H16l-5 15H3l6-19v-6Z', fill: '#846044', stroke: '#fff0c9', width: 2, opacity: fade, transform: `translate(${-8 * Math.exp(-t*12)} 0)` },
    { path: 'M67 43 76 47 87 32 84 47 98 51 84 55 88 69 76 57 67 60Z', fill: '#ffca62', stroke: '#fff5cf', width: 2, opacity: fade * (1 - clamp(t * 2)), transform: `translate(${t*14} 0)` },
    path(`M${73+t*17} 50h${8+t*10} M${77+t*14} 40l8-4 M${77+t*14} 60l8 4`, '#fff0b5', 3, fade * (1-t)),
  ];
  if (kind === 'inspect') return [
    ring(20 + t * 23, '#c4adff', 1-t),
    { path: 'M12 50q38-38 76 0-38 38-76 0Z', fill: '#332b58', stroke: '#e2d5ff', width: 3, opacity: fade },
    { path: 'M50 36a14 14 0 1 0 0 28 14 14 0 1 0 0-28Z', fill: '#b79afa', stroke: '#fff', width: 2, opacity: fade, transform: `translate(${Math.sin(t*Math.PI*2)*5} 0) scale(1 ${.55 + .45*pulse})` },
    path(`M${20+t*60} 30v40`, '#f7ebff', 2, fade * .8),
  ];
  if (kind === 'guard') return [
    ring(23 + t * 20, '#9af0ff', 1-t),
    { path: 'M50 12 78 23v23q0 25-28 40Q22 71 22 46V23Z', fill: '#3985a3', stroke: '#d5faff', width: 3, opacity: fade, transform: `translate(50 50) scale(${.8 + .2*grow}) translate(-50 -50)` },
    path('M36 49l10 10 20-24', '#f0ffff', 5, fade),
    path(`M50 ${7+t*15}v8 M${18+t*7} 32l7 3 M${82-t*7} 32l-7 3`, '#d4faff', 3, fade),
  ];
  return [
    ring(20 + t * 24, '#ffacb1', 1-t),
    { path: 'M22 18 39 28h22l17-10-3 35-11 22-14 10-14-10-11-22Z', fill: '#694557', stroke: '#ffd6d2', width: 2, opacity: fade },
    path('M31 43l11 5 M69 43l-11 5 M43 66l7-6 7 6-7 7Z', '#ffd6aa', 3, fade),
    ...[0,1,2].map((i) => path(`M${17+i*15+t*25} 18l-20 52`, '#ff778a', 4, fade * Math.sin(Math.PI * clamp(t*1.4)), `translate(${i*9} 0)`)),
  ];
}
