import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { checkGameLanguage, gameMessageKeys, gameLanguage } from '../packages/protocol/src/locale';
import { checkUiLanguage, uiMessageKeys } from '../apps/web/src/i18n';
import { engineCatalog } from '../packages/engine/src/index';
import { STYLES } from '../packages/llm/src/styles';

// 使用网页构建器的解析器，依赖位置由 Node 解析，不绑定某个 pnpm 版本目录。
const webRequire = createRequire(resolve('apps/web/package.json'));
const viteRequire = createRequire(webRequire.resolve('vite/package.json'));
const { parseSync } = await import(pathToFileURL(viteRequire.resolve('rolldown/utils')).href);
type Node = { type?: string; [key: string]: unknown };
const calls = new Map<string, Set<string>>([['game', new Set(gameMessageKeys())], ['ui', new Set(uiMessageKeys())]]);
const references: { domain: string; key: string; file: string }[] = [];
const literal = (n: unknown): string | undefined => n && typeof n === 'object' && (n as Node).type === 'Literal' && typeof (n as Node).value === 'string' ? (n as Node).value as string : undefined;
function walk(node: unknown, file: string): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Node;
  if (n.type === 'CallExpression' || n.type === 'NewExpression') {
    const callee = n.callee as Node | undefined;
    const args = n.arguments as unknown[] | undefined;
    const name = callee?.type === 'Identifier' ? callee.name : undefined;
    const domain = name === 't' || name === 'uiText' || name === 'text' && file.endsWith('speech-output.ts') ? 'ui' : ['gameText', 'gt', 'LocalizedError'].includes(String(name)) ? 'game' : undefined;
    const key = args && literal(args[name === 'gameText' || name === 'uiText' ? 1 : 0]);
    if (domain && key) { calls.get(domain)!.add(key); references.push({ domain, key, file }); }
  }
  for (const value of Object.values(n)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, file));
    else if (value && typeof value === 'object') walk(value, file);
  }
}
function scan(directory: string): void {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) { if (item.name !== 'locales') scan(file); }
    else if (/\.tsx?$/.test(file)) {
      const parsed = parseSync(file, readFileSync(file, 'utf8'));
      if (parsed.errors.length) throw Error(`Cannot parse ${file}`);
      walk(parsed.program, file);
    }
  }
}
for (const folder of ['apps/web/src', 'packages/protocol/src', 'packages/engine/src', 'packages/session/src', 'packages/llm/src']) scan(folder);
const catalog = engineCatalog();
const catalogText = [
  ...catalog.presets.flatMap((p) => [p.name, p.description, p.tag]),
  ...catalog.roles.flatMap((r) => [r.name, r.factionName, r.categoryName, r.summary]),
  ...catalog.options.flatMap((o) => [o.group, o.label, o.hint, ...(o.choices ?? []).map((c) => c.label)]),
  ...Object.values(STYLES).flatMap((s) => [s.name, s.text]),
].filter((value): value is string => typeof value === 'string' && value.length > 0);
catalogText.forEach((key) => calls.get('game')!.add(key));
let failures = 0;
for (const locale of ['zh-CN', 'en', 'ja']) {
  const gameKeys = [...calls.get('game')!];
  const uiKeys = [...calls.get('ui')!];
  const game = checkGameLanguage(locale, gameKeys), ui = checkUiLanguage(locale, uiKeys);
  // 本期三套基础包不能靠另一种语言补缺；扩展包可以显式继承。
  const unresolved = [...game.missing, ...(locale === 'zh-CN' ? [] : game.inherited)];
  for (const key of unresolved) {
    const ref = references.find((r) => r.domain === 'game' && r.key === key);
    console.error(`${locale} game: ${key}${ref ? ` (${ref.file})` : ''}`);
  }
  for (const key of ui.missing) console.error(`${locale} ui: ${key}`);
  failures += unresolved.length + ui.missing.length;
  console.log(`${locale}: ${gameKeys.length} game templates, ${uiKeys.length} UI templates; ${unresolved.length + ui.missing.length} missing`);
  if (!gameLanguage(locale).messages) failures++;
}
if (failures) process.exitCode = 1;
