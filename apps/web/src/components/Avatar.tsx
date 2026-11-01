import type { CSSProperties } from 'react';
import { avatarSheet, type AvatarStyleId } from '../avatar-style';

/** Cosmetic portraits are fixed by seat number and never depend on a hidden role. */
export function Avatar({ seat, size = 48, className = '', styleId }: { seat: number; size?: number; className?: string; styleId?: AvatarStyleId }) {
  const index = ((seat - 1) % 12 + 12) % 12;
  return <span className={'avatar-art ' + className} aria-hidden="true" style={{
    width: size, height: size,
    backgroundPosition: ((index % 4) * 100 / 3) + '% ' + (Math.floor(index / 4) * 50) + '%',
    ...(styleId ? { backgroundImage: 'url("' + avatarSheet(styleId) + '")' } : {}),
  } as CSSProperties} />;
}
