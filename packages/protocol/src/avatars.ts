/** 每套人物按头像图集从左到右、从上到下排列，与游戏身份无关。 */
export const AVATAR_STYLES = [
  {
    id: 'storybook', name: '童话绘本', detail: '月影小镇 · 手绘奇遇',
    characters: ['Oliver', 'Alice', 'Arthur', 'Clara', 'Felix', 'Hazel', 'Ruby', 'Hugo', 'Mabel', 'Julian', 'Theo', 'Violet'].map((defaultName) => ({ defaultName })),
  },
  {
    id: 'campus', name: '日式校园', detail: '青春物语 · 清新二次元',
    characters: ['大老师', '雪之下雪乃', '叶山', '团子', '坂本', '一色', '五条悟', '长门', '桐人', '三浦', '户部', '海老名'].map((defaultName) => ({ defaultName })),
  },
  {
    id: 'gufeng', name: '中式古风', detail: '云间雅集 · 汉服风华',
    characters: ['沈砚', '顾清辞', '萧长风', '唐棠', '谢玄', '苏晚晴', '陆怀瑾', '叶红绡', '裴松龄', '温知意', '许墨白', '柳如霜'].map((defaultName) => ({ defaultName })),
  },
  {
    id: 'fantasy', name: '剑与魔法', detail: '异世界 · 精灵与旅人',
    characters: ['Rowan', 'Elara', 'Bram', 'Poppy', 'Silas', 'Zara', 'Ember', 'Magnus', 'Evelyn', 'Caspian', 'Milo', 'Lyra'].map((defaultName) => ({ defaultName })),
  },
  {
    id: 'urban', name: '现代都市', detail: '城市来客 · 摩登日常',
    characters: ['Ethan', 'Audrey', 'Vincent', 'Sofia', 'Adrian', 'Naomi', 'Chloe', 'Daniel', 'Vivian', 'Ryan', 'Noah', 'Isabel'].map((defaultName) => ({ defaultName })),
  },
  {
    id: 'future', name: '未来科技', detail: '霓虹纪元 · 未来来客',
    characters: ['Axel', 'Nova', 'Victor', 'Raven', 'Leon', 'Jade', 'Scarlet', 'Dante', 'Iris', 'Orion', 'Ezra', 'Nyx'].map((defaultName) => ({ defaultName })),
  },
] as const;

export type AvatarStyleId = (typeof AVATAR_STYLES)[number]['id'];

export function isAvatarStyleId(value: unknown): value is AvatarStyleId {
  return AVATAR_STYLES.some((style) => style.id === value);
}

export function avatarDefaultName(style: AvatarStyleId, seat: number): string {
  const characters = AVATAR_STYLES.find((item) => item.id === style)!.characters;
  const index = ((seat - 1) % characters.length + characters.length) % characters.length;
  return characters[index].defaultName;
}
