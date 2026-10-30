export interface Style {
  id: string;
  name: string;
  text: string;
}

export const STYLES: Style[] = [
  { id: 'balanced', name: '均衡', text: '在逻辑和直觉之间保持平衡。发言简洁清楚，有明确的站边和理由。' },
  { id: 'logical', name: '冷静逻辑', text: '说话冷静、有条理，先摆事实再下结论，喜欢引用具体的发言和票型。' },
  { id: 'aggressive', name: '激进强势', text: '说话直接强势，敢于点名、带节奏，不怕起冲突，愿意冒险。' },
  { id: 'cautious', name: '保守谨慎', text: '说话谨慎，不轻易下结论，倾向稳妥的选择，尽量不暴露自己。' },
  { id: 'intuitive', name: '直觉', text: '凭直觉和对发言状态的感受做判断，语言口语化、简短。' },
];

export const DEFAULT_STYLE = 'balanced';

export function styleText(id: string, persona = ''): string {
  const s = STYLES.find((x) => x.id === id) ?? STYLES[0];
  return persona.trim() ? `${s.text}\n补充性格：${persona.trim()}` : s.text;
}
