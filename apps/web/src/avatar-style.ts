export const AVATAR_STYLES = [
  { id: 'storybook', name: '童话绘本', detail: '月影小镇 · 手绘奇遇' },
  { id: 'campus', name: '日式校园', detail: '青春物语 · 清新二次元' },
  { id: 'gufeng', name: '中式古风', detail: '云间雅集 · 汉服风华' },
  { id: 'fantasy', name: '剑与魔法', detail: '异世界 · 精灵与旅人' },
  { id: 'urban', name: '现代都市', detail: '城市来客 · 摩登日常' },
  { id: 'future', name: '未来科技', detail: '霓虹纪元 · 未来来客' },
] as const;

export type AvatarStyleId = (typeof AVATAR_STYLES)[number]['id'];
const KEY = 'werewolf.avatar-style';

export function avatarSheet(style: AvatarStyleId): string {
  return '/art/moon-village/avatars-' + style + '-v1.webp';
}

export function currentAvatarStyle(): AvatarStyleId {
  const value = document.documentElement.dataset.avatarStyle;
  return AVATAR_STYLES.find((s) => s.id === value)?.id ?? 'storybook';
}

export function selectAvatarStyle(style: AvatarStyleId): void {
  document.documentElement.dataset.avatarStyle = style;
  document.documentElement.style.setProperty('--avatar-sheet', 'url("' + avatarSheet(style) + '")');
  try { localStorage.setItem(KEY, style); } catch { /* The selection still works when storage is unavailable. */ }
}

export function initializeAvatarStyle(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* Use the default. */ }
  selectAvatarStyle(AVATAR_STYLES.find((s) => s.id === saved)?.id ?? 'storybook');
}
