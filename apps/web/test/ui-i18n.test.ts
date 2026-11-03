import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { gameLanguage, registerGameLanguage, preferredLanguage } from '@werewolf/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableUiLanguages, getUiLocale, saveUiLocale, uiText, registerUiLanguage, checkUiLanguage, checkedUiMessages, I18nProvider, UiLanguagePicker, uiLanguageHeader } from '../src/i18n';

afterEach(() => vi.unstubAllGlobals());
describe('personal interface language', () => {
  it('persists a registered language without changing room settings', () => {
    const values = new Map([['room.locale', 'ja']]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    expect(saveUiLocale('en')).toBe(true);
    expect(getUiLocale()).toBe('en');
    expect(values.get('room.locale')).toBe('ja');
    expect(saveUiLocale('fr')).toBe(false);
    expect(getUiLocale()).toBe('en');
    expect(availableUiLanguages().map((item) => item.id)).toEqual(['zh-CN', 'en', 'ja']);
  });
  it('falls back safely for unsupported or unavailable storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'fr' });
    expect(getUiLocale()).toBe('zh-CN');
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } });
    expect(saveUiLocale('ja')).toBe(true);
    expect(getUiLocale()).toBe('ja');
    vi.stubGlobal('localStorage', { getItem: () => 'en', setItem: () => { throw Error('denied'); } });
    expect(saveUiLocale('ja')).toBe(true);
    expect(getUiLocale()).toBe('ja');
    expect(uiText('unsupported', '界面语言')).toBe('界面语言');
    expect(uiText('en', '未知消息')).toBe('未知消息');
  });
  it('validates language registration and resolves a registered fallback', () => {
    expect(() => registerUiLanguage({ id: 'fr', label: 'Français', messages: {} })).toThrow();
    expect(() => registerUiLanguage({ id: 'fr', label: 'Français', fallback: 'missing', messages: {} })).toThrow();
    expect(() => registerUiLanguage({ id: 'fr', label: 'Français', fallback: 'en', messages: { '界面语言': '' } })).toThrow();
    registerUiLanguage({ id: 'fr', label: 'Français', fallback: 'en', messages: { '界面语言': 'Langue' } });
    expect(uiText('fr', '界面语言')).toBe('Langue');
    expect(uiText('fr', '创建房间')).toBe('Create room');
    expect(uiLanguageHeader('fr')).toBe('fr, en, zh-CN');
    expect(preferredLanguage(uiLanguageHeader('fr'), ['zh-CN', 'en', 'ja'])).toBe('en');
  });
  it('interpolates only the chosen template, leaving user content intact', () => {
    expect(uiText('en', '房间 {0}', '界面语言 {1}')).toBe('Room 界面语言 {1}');
    expect(uiText('ja', '房间 {0}', 42)).toBe('部屋 42');
  });
  it('rejects duplicate messages and placeholder mismatches', () => {
    expect(() => checkedUiMessages([['A {0}', 'B {0}', 'C {0}'], ['A {0}', 'B {0}', 'C {0}']])).toThrow(/Duplicate/);
    expect(() => checkedUiMessages([['A {0}', 'B {1}', 'C {0}']])).toThrow(/Invalid/);
    expect(() => registerUiLanguage({ id: 'de', label: 'Deutsch', fallback: 'en', messages: { 'A {0}': 'B {1}' } })).toThrow();
    expect(checkUiLanguage('en', ['not a registered template']).missing).toEqual(['not a registered template']);
    expect(checkUiLanguage('zh-CN', ['中文源文']).missing).toEqual([]);
  });
  it('inherits explicit protocol templates through a UI-only dialect fallback', () => {
    registerUiLanguage({ id: 'en-GB', label: 'British English', fallback: 'en', messages: {} });
    // This template is registered by the protocol, not in the web message tables.
    const source = '接口地址必须是无凭证、无查询参数的 HTTP(S) 地址';
    expect(uiText('en-GB', source)).not.toBe(source);
    expect(checkUiLanguage('en-GB', [source])).toEqual({ missing: [], inherited: [source] });
    const base = gameLanguage('en');
    registerGameLanguage({ ...base, id: 'en-AU', label: 'Australian English', fallback: 'en', messages: {} });
    registerUiLanguage({ id: 'en-AU', label: 'Australian English', fallback: 'en', messages: {} });
    expect(uiText('en-AU', source)).not.toBe(source);
    expect(checkUiLanguage('en-AU', [source])).toEqual({ missing: [], inherited: [source] });
  });
  it('renders the stored language and only registered options', () => {
    for (const [locale, label] of [['zh-CN', '界面语言'], ['en', 'Interface language'], ['ja', '表示言語']]) {
      vi.stubGlobal('localStorage', { getItem: () => locale, setItem: () => {} });
      saveUiLocale(locale);
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UiLanguagePicker)));
      expect(html).toContain(label);
      expect(html).toContain(`value="${locale}" selected`);
      expect(html).not.toContain('value="unsupported"');
    }
  });
  it('has registered translations for every literal interface template used by settings', () => {
    const files = ['pages/Home.tsx', 'pages/Setup.tsx', ...['ModelLibrary', 'ModelList', 'SpeechSettings', 'TimingSettings', 'RecentRooms', 'HumanPlayers', 'InviteQr', 'AvatarStylePicker', 'Pagination'].map((name) => `components/${name}.tsx`)];
    const keys = files.flatMap((file) => [...readFileSync(`apps/web/src/${file}`, 'utf8').matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]));
    expect(keys.length).toBeGreaterThan(200);
    for (const locale of ['zh-CN', 'en', 'ja']) expect(checkUiLanguage(locale, keys).missing, locale).toEqual([]);
  });
});
