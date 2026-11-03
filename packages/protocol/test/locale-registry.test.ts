import { expect, it } from 'vitest';
import { checkedMessages, checkGameLanguage, gameLanguages, gameText, localizeTool, registerGameLanguage, type ToolSpec } from '../src/index';

it('基础语言完整，方言可继承而未注册语言不展示，占位符与重复项可检查', () => {
  for (const locale of ['zh-CN', 'en', 'ja']) expect(checkGameLanguage(locale)).toEqual({ missing: [], inherited: [] });
  expect(gameLanguages().map((l) => l.id)).not.toContain('fr-CA');
  expect(() => checkedMessages([['目标 {0}', 'Target {0}', '対象{0}'], ['目标 {0}', 'Target {0}', '対象{0}']])).toThrow('Duplicate');
  expect(() => checkedMessages([['目标 {0}', 'Target', '対象{0}']])).toThrow('Invalid');
  registerGameLanguage({ id: 'en-AU', label: 'English (Australia)', languageName: 'Australian English', speechLang: 'en-AU', ttsLanguageHints: ['en'], fallback: 'en', messages: { 发言: 'Speak (AU)' } });
  expect(gameLanguages().map((l) => l.id)).toContain('en-AU');
  expect(gameText('en-AU', '发言')).toBe('Speak (AU)');
  expect(gameText('en-AU', '{0}号', 8)).toBe('Player 8');
  expect(checkGameLanguage('en-AU', ['发言', '{0}号', 'not-a-known-template'])).toEqual({ missing: ['not-a-known-template'], inherited: ['{0}号'] });
  expect(gameText('en-AU', '法官：{0}{1}', '原话 {1}', '日本語')).toBe('Moderator: 原话 {1}日本語');
});

it('工具的提示和占位文本可译，协议值与映射不改变', () => {
  const tool: ToolSpec = { name: 'extension_tool', title: '行动', description: '发言', operation: { tool: 'canonical_tool', constants: { mode: 'raw' }, parameters: {} }, params: [
    { kind: 'choice', name: 'mode', label: '行动', options: [{ value: 'literal_enum', label: '不选', hint: '同时行动' }] },
    { kind: 'text', name: 'content', label: '发言', minLength: 0, placeholder: '可以留空' },
  ] };
  const before = structuredClone(tool), result = localizeTool(tool, 'en');
  expect(result).toMatchObject({ name: 'extension_tool', operation: tool.operation, title: 'Action', params: [
    { name: 'mode', options: [{ value: 'literal_enum', label: 'No selection', hint: 'Simultaneous actions' }] },
    { name: 'content', placeholder: 'May be left empty' },
  ] });
  expect(tool).toEqual(before);
});
