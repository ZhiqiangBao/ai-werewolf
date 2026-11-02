export type DeathCause = 'exile' | 'poison' | 'wolf' | 'shot' | 'explode' | 'guard_and_save' | 'night' | 'other';
/** 只供页面展示，与模型使用的 Projection 分开传输。 */
export interface SeatDeathView { seat: number; day: number; causes: DeathCause[] }

export function deathCauses(via: string, causes: readonly string[], god: boolean): DeathCause[] {
  if (via !== 'night') return [via === 'exile' || via === 'shot' || via === 'explode' ? via : 'other'];
  if (!god) return ['night'];
  const known = causes.map((cause): DeathCause => ['wolf', 'poison', 'guard_and_save'].includes(cause) ? cause as DeathCause : 'other');
  return [...new Set(known.length ? known : ['night' as const])];
}

export interface DeathGlyphLayer { path: string; fill?: string; stroke?: string; width?: number }
/** 原创具象图标：人物出门、毒瓶、狼头、猎枪、炸弹和月亮。 */
export const DEATH_GLYPHS: Record<DeathCause, { label: string; shortLabel: string; layers: readonly DeathGlyphLayer[] }> = {
  exile: { label: '放逐出局', shortLabel: '放逐', layers: [
    { path: 'M15 3h6v18h-6', stroke: '#9dd7f0', width: 1.8 },
    { path: 'M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z', fill: '#ffda94', stroke: '#fff1cd' },
    { path: 'm7 9 3 3h5 M6 9l-2 5 M7 10l-1 5-3 6 M6 15l5 6', stroke: '#fff1cd', width: 2.1 },
    { path: 'M13 12h10 M20 9l3 3-3 3', stroke: '#ffd16d', width: 1.8 },
  ] },
  poison: { label: '中毒出局', shortLabel: '毒药', layers: [
    { path: 'M9 3h6v5l4 4v8H5v-8l4-4Z', fill: '#3c925e', stroke: '#b7f5bd', width: 1.3 },
    { path: 'M8 2h8v3H8Z', fill: '#d7b77e', stroke: '#fff0bd' },
    { path: 'M8 14a4 4 0 1 1 8 0v3h-2v2h-4v-2H8Z', fill: '#fff4d7', stroke: '#fff4d7', width: .7 },
    { path: 'M10 13v1 M14 13v1 M11 17h2', stroke: '#314c40', width: 1.7 },
  ] },
  wolf: { label: '狼刀出局', shortLabel: '狼刀', layers: [
    { path: 'M3 3 9 6h6l6-3-1 10-4 7-4 3-4-3-4-7Z', fill: '#826c7d', stroke: '#e6d1dd', width: 1.2 },
    { path: 'M4 5 8 8 M20 5l-4 3 M6 11l3 2 M18 11l-3 2', stroke: '#ffd075', width: 1.8 },
    { path: 'm8 16 4-3 4 3-2 4h-4Z', fill: '#e3d6d5', stroke: '#e3d6d5', width: .5 },
    { path: 'm10 16 2-1 2 1-2 2Z', fill: '#352936', stroke: '#352936' },
    { path: 'M9 19v2 M15 19v2', stroke: '#fff4df', width: 1.5 },
  ] },
  shot: { label: '猎枪出局', shortLabel: '猎枪', layers: [
    { path: 'M2 11h7l-3 8H2l2-7Z', fill: '#bb8154', stroke: '#f5d3a2', width: 1.2 },
    { path: 'M7 8h13v4H7Z M18 6h3v2h-3Z', fill: '#aabac6', stroke: '#ecf7ff', width: 1.2 },
    { path: 'M9 12v4h3l2-4', stroke: '#d7e5ed', width: 1.2 },
    { path: 'm21 9 2-2 M22 10h2 M21 11l2 2', stroke: '#ffca62', width: 1.4 },
  ] },
  explode: { label: '自爆出局', shortLabel: '自爆', layers: [
    { path: 'M17 15A7 7 0 1 1 3 15a7 7 0 0 1 14 0Z', fill: '#34313c', stroke: '#ffe0bb', width: 1.4 },
    { path: 'm12 8 2-3 3 1 1-3', stroke: '#e5b67c', width: 1.8 },
    { path: 'm19 1 1 2 3-1-1 3 2 1-3 1 1 3-3-2-2 1V6l-2-1 3-1Z', fill: '#ffbc4f', stroke: '#ff7660', width: .6 },
    { path: 'M6 13q0-2 2-2', stroke: '#aab1c7', width: 1.4 },
  ] },
  guard_and_save: { label: '同守同救出局', shortLabel: '同守同救', layers: [
    { path: 'M9 2 2 5v7q0 6 7 10 7-4 7-10V5Z', fill: '#4d849a', stroke: '#bdeaf1', width: 1.2 },
    { path: 'M16 6h5v4l2 3v7h-9v-7l2-3Z', fill: '#72ad75', stroke: '#e1f3c3', width: 1 },
    { path: 'M7 10l10 9 M17 10l-10 9', stroke: '#ff8d80', width: 2.5 },
  ] },
  night: { label: '夜晚出局', shortLabel: '夜晚', layers: [
    { path: 'M16 3A9 9 0 1 0 21 17 9 9 0 0 1 16 3Z', fill: '#f8d67e', stroke: '#fff0bd', width: 1 },
    { path: 'm19 3 .7 2.3L22 6l-2.3.7L19 9l-.7-2.3L16 6l2.3-.7Z', fill: '#bbd8ff', stroke: '#bbd8ff', width: .5 },
  ] },
  other: { label: '其他原因出局', shortLabel: '其他', layers: [
    { path: 'M5 21V10a7 7 0 0 1 14 0v11Z M3 21h18', fill: '#87939c', stroke: '#dce5e8', width: 1.3 },
    { path: 'M10 9q0-3 3-2t-1 5v2 M12 17h.1', stroke: '#fff5d9', width: 1.8 },
  ] },
};
