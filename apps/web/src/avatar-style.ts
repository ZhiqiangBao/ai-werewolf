import { AVATAR_STYLES, type AvatarStyleId } from '@werewolf/protocol';
export { AVATAR_STYLES, type AvatarStyleId } from '@werewolf/protocol';
const KEY = 'werewolf.avatar-style';

export function avatarSheet(style: AvatarStyleId): string {
  return '/art/moon-village/avatars-' + style + '-v1.webp';
}

export function currentAvatarStyle(): AvatarStyleId {
  const value = document.documentElement.dataset.avatarStyle;
  return AVATAR_STYLES.find((s) => s.id === value)?.id ?? 'storybook';
}

export function applyAvatarStyle(style: AvatarStyleId): void {
  document.documentElement.dataset.avatarStyle = style;
  document.documentElement.style.setProperty('--avatar-sheet', 'url("' + avatarSheet(style) + '")');
}

export function selectAvatarStyle(style: AvatarStyleId): void {
  applyAvatarStyle(style);
  try { localStorage.setItem(KEY, style); } catch { /* The selection still works when storage is unavailable. */ }
}

export function initializeAvatarStyle(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* Use the default. */ }
  selectAvatarStyle(AVATAR_STYLES.find((s) => s.id === saved)?.id ?? 'storybook');
}
