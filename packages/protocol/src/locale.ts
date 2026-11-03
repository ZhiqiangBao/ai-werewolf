import { translations } from './locales/messages';
import { gameAdditions } from './locales/game-additions';
import { presentationMessages } from './locales/presentation';
import { catalogMessages } from './locales/catalog';
import { serviceMessages } from './locales/service';
import { thinkingMessages } from './locales/thinking';
import type { ToolSpec } from './index';

/** BCP 47 标签；扩展语言和方言不需要修改协议联合类型。 */
export type GameLocale = string;
export const DEFAULT_GAME_LOCALE = 'zh-CN';

export interface GameLanguage {
  id: GameLocale;
  label: string;
  /** 模型发言语言的明确名称，也可写方言及口音要求。 */
  languageName: string;
  speechLang: string;
  ttsLanguageHints: readonly string[];
}
export interface GameLanguagePack extends GameLanguage {
  /** 可复用基础语言；方言只覆盖需要不同表达的消息。 */
  fallback?: GameLocale;
  messages: Readonly<Record<string, string>>;
}

const packs = new Map<string, GameLanguagePack>();

/** 拒绝重复模板，避免 Object.fromEntries 静默覆盖。 */
export function checkedMessages(rows: readonly (readonly [string, string, string])[]): typeof rows {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row[0] || keys.has(row[0])) throw Error(`Duplicate translation template: ${row[0]}`);
    keys.add(row[0]);
    const slots = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
    if (!row[1]?.trim() || !row[2]?.trim() || slots(row[0]) !== slots(row[1]) || slots(row[0]) !== slots(row[2])) throw Error(`Invalid translation template: ${row[0]}`);
  }
  return rows;
}

const allTranslations = checkedMessages([...translations, ...gameAdditions, ...presentationMessages, ...catalogMessages, ...serviceMessages, ...thinkingMessages]);
export const gameMessageKeys = (): string[] => [...allTranslations.map(([key]) => key), ...deathShortLabels.map(([cause]) => `death.short.${cause}`)];

/** 检查有效回退链；inherited 是有意复用，missing 则没有可用译文。 */
export function checkGameLanguage(locale: GameLocale, keys: readonly string[] = gameMessageKeys()): { missing: string[]; inherited: string[] } {
  const own = gameLanguage(locale);
  const missing: string[] = [], inherited: string[] = [];
  for (const key of keys) {
    let pack = own;
    while (!Object.hasOwn(pack.messages, key) && pack.fallback) pack = gameLanguage(pack.fallback);
    if (!Object.hasOwn(pack.messages, key)) missing.push(key);
    else if (pack !== own) inherited.push(key);
  }
  return { missing, inherited };
}

/** 在应用启动时注册；消息是程序模板，绝不翻译玩家原话或改变工具参数。 */
export function registerGameLanguage(pack: GameLanguagePack): void {
  if (typeof pack.id !== 'string' || Intl.getCanonicalLocales(pack.id)[0] !== pack.id || packs.has(pack.id)) throw Error('Invalid or duplicate game language');
  if (!pack.label || !pack.languageName || !pack.speechLang || !pack.ttsLanguageHints.length) throw Error('Incomplete game language');
  if (pack.fallback && !packs.has(pack.fallback)) throw Error('Register the fallback language first');
  const base = pack.fallback ? packs.get(pack.fallback) : undefined;
  const reference = base?.messages ?? Object.fromEntries(allTranslations.map(([source]) => [source, source]));
  const slots = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [key, value] of Object.entries(pack.messages)) {
    if (typeof value !== 'string' || !value.trim() || slots(Object.hasOwn(reference, key) ? reference[key] : key) !== slots(value)) throw Error(`Translation placeholders differ: ${key}`);
  }
  packs.set(pack.id, Object.freeze({ ...pack, ttsLanguageHints: Object.freeze([...pack.ttsLanguageHints]), messages: Object.freeze(Object.assign(Object.create(null), pack.messages)) }));
}

export function gameLanguage(locale: GameLocale = DEFAULT_GAME_LOCALE): GameLanguagePack {
  const pack = packs.get(locale);
  if (!pack) throw Error(`Unsupported game language: ${locale}`);
  return pack;
}
export const isGameLocale = (value: unknown): value is GameLocale => typeof value === 'string' && packs.has(value);
export const gameLanguages = (): GameLanguage[] => [...packs.values()].map(({ id, label, languageName, speechLang, ttsLanguageHints }) => ({ id, label, languageName, speechLang, ttsLanguageHints: [...ttsLanguageHints] }));

/** 显式模板与参数分离。替换只进行一次，参数里的花括号和任何原话均原样保留。 */
export function gameText(locale: GameLocale | undefined, source: string, ...values: unknown[]): string {
  let pack = gameLanguage(locale);
  let template: string | undefined;
  while (pack) {
    template = Object.hasOwn(pack.messages, source) ? pack.messages[source] : undefined;
    if (template !== undefined || !pack.fallback) break;
    pack = gameLanguage(pack.fallback);
  }
  return (template ?? source).replace(/\{(\d+)\}/g, (slot, index: string) => Number(index) < values.length ? String(values[Number(index)]) : slot);
}

/** 只翻译说明与标签，许可目标、工具映射和参数约束保持不变。 */
export function localizeTool(tool: ToolSpec, locale?: GameLocale): ToolSpec {
  if (!locale || locale === DEFAULT_GAME_LOCALE) return tool;
  const text = (s: string) => gameText(locale, s);
  return { ...tool, title: text(tool.title), description: text(tool.description), params: tool.params.map((p) => {
    switch (p.kind) {
      case 'seat': return { ...p, label: text(p.label), ...(p.nullLabel ? { nullLabel: text(p.nullLabel) } : {}) };
      case 'boolean': return { ...p, label: text(p.label), ...(p.trueLabel ? { trueLabel: text(p.trueLabel) } : {}), ...(p.falseLabel ? { falseLabel: text(p.falseLabel) } : {}) };
      case 'choice': return { ...p, label: text(p.label), options: p.options.map((o) => ({ ...o, label: text(o.label), ...(o.hint ? { hint: text(o.hint) } : {}) })) };
      case 'text': return { ...p, label: text(p.label), ...(p.placeholder ? { placeholder: text(p.placeholder) } : {}) };
      default: return { ...p, label: text(p.label) };
    }
  }) };
}

// 小图标的短标签独立于规则和行动名称，避免把长句挤进座位标记。
const deathShortLabels = [
  ['exile', '放逐', 'Exile', '追放'], ['poison', '毒药', 'Poison', '毒'],
  ['wolf', '狼刀', 'Wolf', '襲撃'], ['shot', '猎枪', 'Shot', '射撃'],
  ['explode', '自爆', 'Reveal', '自白'], ['guard_and_save', '同守同救', 'Clash', '護衛＋薬'],
  ['night', '夜晚', 'Night', '夜間'], ['other', '其他', 'Other', 'その他'],
] as const;
const shortMessages = (index: 1 | 2 | 3) => Object.fromEntries(deathShortLabels.map((row) => [`death.short.${row[0]}`, row[index]]));
registerGameLanguage({ id: 'zh-CN', label: '简体中文', languageName: '简体中文', speechLang: 'zh-CN', ttsLanguageHints: ['zh'], messages: { ...Object.fromEntries(allTranslations.map(([source]) => [source, source])), ...shortMessages(1) } });
registerGameLanguage({ id: 'en', label: 'English', languageName: 'English', speechLang: 'en-US', ttsLanguageHints: ['en'], fallback: 'zh-CN', messages: { ...Object.fromEntries(allTranslations.map(([source, en]) => [source, en])), ...shortMessages(2) } });
registerGameLanguage({ id: 'ja', label: '日本語', languageName: '日本語', speechLang: 'ja-JP', ttsLanguageHints: ['ja'], fallback: 'zh-CN', messages: { ...Object.fromEntries(allTranslations.map(([source, , ja]) => [source, ja])), ...shortMessages(3) } });
