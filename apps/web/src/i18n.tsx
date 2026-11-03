import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { gameLanguage, isGameLocale } from '@werewolf/protocol';
import { uiMessages } from './locales/ui';
import { gameUiMessages } from './locales/game-ui';

export type UiLocale = string;
export interface UiLanguagePack { id: string; label: string; fallback?: string; messages: Readonly<Record<string, string>> }
const STORAGE_KEY = 'werewolf.ui-locale';
let inMemoryLocale: string | undefined;
let storageUnavailable = false;
const packs = new Map<string, UiLanguagePack>();
const slots = (text: string) => [...text.matchAll(/\{(\d+)\}/g)].map((match) => match[1]).sort().join(',');
/** Reject duplicates and missing or incompatible translations before building maps. */
export function checkedUiMessages(rows: readonly (readonly [string, string, string])[]) {
  const keys = new Set<string>();
  for (const [source, en, ja] of rows) {
    if (!source?.trim() || keys.has(source)) throw Error(`Duplicate interface template: ${source}`);
    if (!en?.trim() || !ja?.trim() || slots(source) !== slots(en) || slots(source) !== slots(ja)) throw Error(`Invalid interface template: ${source}`);
    keys.add(source);
  }
  return rows;
}
/** A language may omit entries only when it names a registered fallback. */
export function registerUiLanguage(pack: UiLanguagePack): void {
  let canonical: string;
  try { canonical = Intl.getCanonicalLocales(pack.id)[0]; } catch { throw Error('Invalid interface language'); }
  if (!canonical || canonical !== pack.id || !pack.label.trim() || packs.has(pack.id)) throw Error('Invalid or duplicate interface language');
  if (pack.fallback && !packs.has(pack.fallback)) throw Error('Register the fallback interface language first');
  if (packs.size && !pack.fallback) throw Error('Interface language requires a fallback');
  for (const [key, message] of Object.entries(pack.messages)) {
    if (!key.trim() || typeof message !== 'string' || !message.trim() || slots(key) !== slots(message)) throw Error(`Invalid interface translation: ${key}`);
  }
  packs.set(pack.id, Object.freeze({ ...pack, messages: Object.freeze(Object.assign(Object.create(null), pack.messages)) }));
}
const entries = checkedUiMessages([...uiMessages, ...gameUiMessages]);
export const uiMessageKeys = () => entries.map(([source]) => source);
registerUiLanguage({ id: 'zh-CN', label: '简体中文', messages: {} });
registerUiLanguage({ id: 'en', label: 'English', fallback: 'zh-CN', messages: Object.fromEntries(entries.map(([source, en]) => [source, en])) });
registerUiLanguage({ id: 'ja', label: '日本語', fallback: 'zh-CN', messages: Object.fromEntries(entries.map(([source, , ja]) => [source, ja])) });
const supported = (value: unknown): value is string => typeof value === 'string' && packs.has(value);
export const availableUiLanguages = () => [...packs.values()].map(({ id, label }) => ({ id, label }));
/** 响应文案也沿用 UI 包的回退顺序，避免仅浏览器注册的方言落回服务器默认语言。 */
export function uiLanguageHeader(locale = getUiLocale()): string {
  let pack = packs.get(supported(locale) ? locale : 'zh-CN')!;
  const ids = [pack.id];
  while (pack.fallback) { pack = packs.get(pack.fallback)!; ids.push(pack.id); }
  return ids.join(', ');
}
export function getUiLocale(): UiLocale {
  if (storageUnavailable && supported(inMemoryLocale)) return inMemoryLocale;
  try { const value = localStorage.getItem(STORAGE_KEY); return supported(value) ? value : value === null && supported(inMemoryLocale) ? inMemoryLocale : 'zh-CN'; } catch { return supported(inMemoryLocale) ? inMemoryLocale : 'zh-CN'; }
}
export function saveUiLocale(value: string): boolean {
  if (!supported(value)) return false;
  inMemoryLocale = value;
  try { localStorage.setItem(STORAGE_KEY, value); storageUnavailable = false; } catch { storageUnavailable = true; }
  return true;
}
/** Find an explicitly registered protocol template in a locale and its game fallback chain. */
function protocolTemplate(locale: string, source: string): { text: string; inherited: boolean } | undefined {
  if (!isGameLocale(locale)) return undefined;
  let pack = gameLanguage(locale);
  while (pack) {
    if (Object.hasOwn(pack.messages, source)) return { text: pack.messages[source], inherited: pack.id !== locale };
    if (!pack.fallback) break;
    pack = gameLanguage(pack.fallback);
  }
  return undefined;
}
function resolveTemplate(locale: string, source: string): { text?: string; inherited: boolean } {
  const initial = packs.get(locale);
  if (!initial) throw Error(`Unsupported interface language: ${locale}`);
  let pack = initial, protocol: { text: string; inherited: boolean } | undefined, protocolInherited = false;
  for (;;) {
    if (Object.hasOwn(pack.messages, source)) return { text: pack.messages[source], inherited: pack !== initial };
    if (protocol === undefined && pack.id !== 'zh-CN') {
      protocol = protocolTemplate(pack.id, source);
      protocolInherited = pack !== initial || !!protocol?.inherited;
    }
    if (!pack.fallback) break;
    pack = packs.get(pack.fallback)!;
  }
  if (protocol !== undefined) return { text: protocol.text, inherited: protocolInherited };
  if (initial.id === 'zh-CN') return { text: source, inherited: false };
  return { inherited: false };
}
/** Report untranslated templates; the Chinese root intentionally uses the source as its text. */
export function checkUiLanguage(locale: string, keys: readonly string[] = uiMessageKeys()): { missing: string[]; inherited: string[] } {
  const missing: string[] = [], inherited: string[] = [];
  for (const key of keys) {
    const result = resolveTemplate(locale, key);
    if (result.text === undefined) missing.push(key);
    else if (result.inherited) inherited.push(key);
  }
  return { missing, inherited };
}
export function uiText(locale: string | undefined, source: string, ...values: unknown[]): string {
  const selected = supported(locale) ? locale : 'zh-CN';
  const translated = resolveTemplate(selected, source).text ?? source;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? (typeof values[Number(index)] === 'number' ? new Intl.NumberFormat(selected).format(values[Number(index)] as number) : String(values[Number(index)])) : match);
}
interface I18n { locale: UiLocale; t: (source: string, ...values: unknown[]) => string; setLocale: (locale: string) => void }
const I18nContext = createContext<I18n | null>(null);
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setCurrent] = useState<UiLocale>(getUiLocale);
  const setLocale = useCallback((value: string) => {
    if (saveUiLocale(value) && supported(value)) setCurrent(value);
  }, []);
  useEffect(() => { document.documentElement.lang = locale; document.title = uiText(locale, 'AI 狼人杀'); }, [locale]);
  useEffect(() => {
    const update = (event: StorageEvent) => { if (event.key === STORAGE_KEY) { storageUnavailable = false; inMemoryLocale = supported(event.newValue) ? event.newValue : 'zh-CN'; setCurrent(inMemoryLocale); } };
    window.addEventListener('storage', update); return () => window.removeEventListener('storage', update);
  }, []);
  const value = useMemo(() => ({ locale, setLocale, t: (source: string, ...values: unknown[]) => uiText(locale, source, ...values) }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useI18n(): I18n {
  const value = useContext(I18nContext);
  return value ?? { locale: 'zh-CN', t: (source, ...values) => uiText('zh-CN', source, ...values), setLocale: () => {} };
}
export function UiLanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  return <select className="ui-language-picker" aria-label={t('界面语言')} value={locale} onChange={(event) => setLocale(event.target.value)}>{availableUiLanguages().map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}</select>;
}
