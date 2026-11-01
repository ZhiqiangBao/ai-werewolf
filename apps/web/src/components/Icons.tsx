import type { CSSProperties } from 'react';

export type IconName = 'moon' | 'sun' | 'spark' | 'arrow' | 'users' | 'eye' | 'scroll' | 'flag' | 'withdraw' | 'sheriff' | 'mic' | 'bot' | 'person' | 'close' | 'check' | 'pause' | 'play' | 'crown' | 'shield' | 'potion' | 'target' | 'cards';

const paths: Record<IconName, string> = {
  moon: 'M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6 8.6 8.6 0 1 0 20.4 14.2Z M17.5 3v4 M15.5 5h4',
  sun: 'M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6 7 7 M17 17l1.4 1.4 M5.6 18.4 7 17 M17 7l1.4-1.4 M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z',
  spark: 'm12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8L12 2Z',
  arrow: 'M4 12h15 M13 5l7 7-7 7',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  scroll: 'M7 4h12a2 2 0 0 1 2 2v3h-4 M7 4a3 3 0 0 0-3 3v11a2 2 0 1 0 4 0v-2h12v2a3 3 0 0 1-3 3H6 M10 8h5 M10 12h5',
  flag: 'M5 22V3 M5 4c5-4 9 4 15 0v10c-6 4-10-4-15 0',
  withdraw: 'M5 21V3 M5 4c5-4 9 4 15 0v9 M3 3l18 18',
  sheriff: 'm12 2 3 3.2 4.4.7.7 4.4L23 13l-3.2 3-.7 4.4-4.4.7L12 24l-3-2.9-4.4-.7-.7-4.4L1 13l2.9-2.7.7-4.4L9 5.2 12 2Z M12 7l1.6 3.2 3.5.5-2.6 2.5.7 3.5-3.2-1.7-3.2 1.7.7-3.5-2.6-2.5 3.5-.5L12 7Z',
  mic: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V5Z M5 10v1a7 7 0 0 0 14 0v-1 M12 18v4 M8 22h8',
  bot: 'M8 3h8 M12 3v4 M5 7h14v13H5V7Z M2 11v5 M22 11v5 M9 11v2 M15 11v2 M9 17h6',
  person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M4 21v-2a8 8 0 0 1 16 0v2',
  close: 'M6 6l12 12 M18 6 6 18',
  check: 'm5 12 4 4L19 6',
  pause: 'M8 5v14 M16 5v14',
  play: 'm8 4 12 8-12 8V4Z',
  crown: 'm3 6 4.5 5L12 3l4.5 8L21 6l-2 13H5L3 6Z M6 22h12',
  shield: 'M12 2 3 6v6c0 6 9 10 9 10s9-4 9-10V6l-9-4Z M8 12l3 3 5-6',
  potion: 'M9 2h6 M10 2v6l-6 10a3 3 0 0 0 2.6 4h10.8a3 3 0 0 0 2.6-4L14 8V2 M7 15h10',
  target: 'M21 12a9 9 0 1 1-9-9 M17 2v5h5 M21 3l-9 9 M16 12a4 4 0 1 1-4-4',
  cards: 'M7 3h13v17H7V3Z M4 6H2v16h14 M13.5 7l3 4-3 4-3-4 3-4Z',
};

export function Icon({ name, size = 18, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 26" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
export function Moon({ size = 18 }: { size?: number }) { return <Icon name="moon" size={size} />; }
export function Sun({ size = 18 }: { size?: number }) { return <Icon name="sun" size={size} />; }
export function PhaseIcon({ phase, size }: { phase: string; size?: number }) { return <Icon name={phase === 'night' ? 'moon' : phase === 'end' ? 'spark' : 'sun'} size={size} />; }

export function Logo({ size = 36 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="m24 2 19 11v22L24 46 5 35V13L24 2Z" stroke="currentColor" strokeWidth="1" opacity=".55" /><path d="m13 13 8 5h6l8-5-2 18-9 8-9-8-2-18Z" stroke="currentColor" strokeWidth="1.5" /><path d="m13 13 9 16-7 2 M35 13l-9 16 7 2 M22 29h4l-2 5-2-5Z M18 24l3 1 M30 24l-3 1" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M24 7v4 M22 9h4" stroke="currentColor" /></svg>;
}

export function RoleIcon({ role, size = 24 }: { role?: string; size?: number }) {
  if (role === 'werewolf' || role === 'awakened_wolf') return <Logo size={size} />;
  const name: IconName = role === 'seer' || role === 'mirror_maiden' ? 'eye' : role === 'witch' ? 'potion' : role === 'hunter' ? 'target' : role === 'guard' ? 'shield' : role === 'idiot' ? 'spark' : 'person';
  return <Icon name={name} size={size} />;
}
