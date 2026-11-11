import { DEFAULT_GAME_LOCALE, gameText, isGameLocale } from '@werewolf/protocol';
import type { RuleSet, RuleValue } from '@werewolf/protocol';
import { allOptions, getOption, getPreset, getRole, hasRole } from './registry';
import type { OptionDef } from './types';

function coerce(o: OptionDef, v: unknown): RuleValue | undefined {
  switch (o.type) {
    case 'boolean':
      return v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined;
    case 'number': {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'choice':
      return o.choices?.find((c) => String(c.value) === String(v))?.value;
  }
}

export function defaultValues(): Record<string, RuleValue> {
  const values: Record<string, RuleValue> = {};
  for (const o of allOptions()) values[o.key] = o.default;
  return values;
}

export function deriveNightOrder(roles: string[], awakenedNightVersion: RuleSet['awakenedNightVersion'] = 1): string[] {
  const phases = new Map<string, number>();
  for (const id of new Set(roles)) {
    if (!hasRole(id)) continue;
    const mod = getRole(id);
    for (const phase of [...(mod.nightPhase ? [mod.nightPhase] : []), ...(mod.nightPhases ?? [])]) phases.set(phase.id, phase.order);
  }
  if (awakenedNightVersion === 2 && roles.includes('awakened_wolf')) {
    phases.delete('awakened_knife');
    phases.delete('awakened_skill');
    if (!phases.has('werewolf')) phases.set('werewolf', getRole('werewolf').nightPhase!.order);
  }
  return [...phases.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

export interface BuildRulesOptions {
  locale?: string;
  toolsetVersion?: 1 | 2;
  electionVersion?: 1 | 2 | 3 | 4;
  inspectionVersion?: 1 | 2;
  deathResolutionVersion?: 1 | 2;
  hunterShotVersion?: 1 | 2;
  electionExplosionVersion?: 1 | 2;
  awakenedNightVersion?: 1 | 2;
  /** 允许改动开局页不可改的选项（测试与自定义版型用）。 */
  allowFixed?: boolean;
  /** 自定义身份列表，覆盖版型自带的身份。 */
  roles?: string[];
  name?: string;
}

export function buildRules(
  presetId: string,
  userValues: Record<string, unknown> = {},
  opts: BuildRulesOptions = {},
): RuleSet {
  const preset = getPreset(presetId);
  const locale = opts.locale ?? DEFAULT_GAME_LOCALE;
  if (!isGameLocale(locale)) throw new Error(`Unsupported game language: ${locale}`);
  const roles = opts.roles ? [...opts.roles] : [...preset.roles];
  const values: Record<string, RuleValue> = { ...defaultValues(), ...(preset.overrides ?? {}) };
  for (const [key, raw] of Object.entries(userValues)) {
    const o = getOption(key);
    if (!o || (!o.editable && !opts.allowFixed)) continue;
    const v = coerce(o, raw);
    if (v !== undefined) values[key] = v;
  }
  const awakenedNightVersion = opts.awakenedNightVersion ?? 2;
  return {
    locale,
    toolsetVersion: opts.toolsetVersion ?? 2,
    electionVersion: opts.electionVersion ?? 4,
    inspectionVersion: opts.inspectionVersion ?? 2,
    deathResolutionVersion: opts.deathResolutionVersion ?? 2,
    hunterShotVersion: opts.hunterShotVersion ?? (opts.deathResolutionVersion === 1 ? 1 : 2),
    electionExplosionVersion: opts.electionExplosionVersion ?? (opts.deathResolutionVersion === 1 ? 1 : 2),
    awakenedNightVersion,
    presetId: preset.id,
    ...(preset.version ? { presetVersion: preset.version } : {}),
    presetName: opts.name ?? gameText(locale, preset.name),
    playerCount: roles.length,
    roles,
    nightOrder: deriveNightOrder(roles, awakenedNightVersion),
    values,
  };
}

/** 版型校验。返回中文原因列表，空列表表示可以开局。 */
export function validateRules(rules: RuleSet, locale: string | undefined = rules.locale): string[] {
  const errors: string[] = [];
  const language = isGameLocale(locale) ? locale : DEFAULT_GAME_LOCALE;
  if (rules.locale !== undefined && !isGameLocale(rules.locale)) errors.push('Unsupported game language');
  if (rules.toolsetVersion !== undefined && rules.toolsetVersion !== 1 && rules.toolsetVersion !== 2) errors.push(gameText(language, '工具版本只支持 1 或 2'));
  if (rules.electionVersion !== undefined && ![1, 2, 3, 4].includes(rules.electionVersion)) errors.push(gameText(language, '竞选流程版本只支持 1、2、3 或 4'));
  if (rules.inspectionVersion !== undefined && ![1, 2].includes(rules.inspectionVersion)) errors.push(gameText(language, '查验版本只支持 1 或 2'));
  if (rules.deathResolutionVersion !== undefined && ![1, 2].includes(rules.deathResolutionVersion)) errors.push(gameText(language, '死亡结算版本只支持 1 或 2'));
  if (rules.hunterShotVersion !== undefined && ![1, 2].includes(rules.hunterShotVersion)) errors.push(gameText(language, '猎枪触发版本只支持 1 或 2'));
  if (rules.hunterShotVersion === 2 && rules.deathResolutionVersion !== 2) errors.push(gameText(language, '猎枪触发版本 2 要求出局结算版本 2'));
  if (rules.electionExplosionVersion !== undefined && ![1, 2].includes(rules.electionExplosionVersion)) errors.push(gameText(language, '警长延期公告版本只支持 1 或 2'));
  if (rules.electionExplosionVersion === 2 && rules.deathResolutionVersion !== 2) errors.push(gameText(language, '警长延期公告版本 2 要求出局结算版本 2'));
  if (rules.awakenedNightVersion !== undefined && ![1, 2].includes(rules.awakenedNightVersion)) errors.push(gameText(language, '觉醒隐狼夜间流程版本只支持 1 或 2'));
  if (rules.roles.length !== rules.playerCount) errors.push(gameText(language, '人数 {0} 与身份数量 {1} 不一致', rules.playerCount, rules.roles.length));
  if (rules.playerCount < 4 || rules.playerCount > 20) errors.push(gameText(language, '人数需要在 4 到 20 之间'));
  const counts = new Map<string, number>();
  for (const r of rules.roles) counts.set(r, (counts.get(r) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (!hasRole(id)) {
      errors.push(gameText(language, '身份「{0}」没有注册', id));
      continue;
    }
    const mod = getRole(id);
    if (n > mod.maxPerGame) errors.push(gameText(language, '{0}最多 {1} 名，当前 {2} 名', gameText(language, mod.name), mod.maxPerGame, n));
  }
  if (errors.length) return errors;
  const mods = rules.roles.map(getRole);
  const wolves = mods.filter((m) => m.faction === 'wolf').length;
  const gods = mods.filter((m) => m.category === 'god').length;
  const villagers = mods.filter((m) => m.category === 'villager').length;
  if (wolves < 1) errors.push(gameText(language, '至少需要 1 名狼人'));
  if (rules.values.winCondition === 'side') {
    if (gods < 1) errors.push(gameText(language, '屠边局至少需要 1 名神职'));
    if (villagers < 1) errors.push(gameText(language, '屠边局至少需要 1 名平民'));
  } else if (mods.length - wolves < 1) errors.push(gameText(language, '至少需要 1 名好人'));
  for (const o of allOptions()) {
    const v = rules.values[o.key];
    if (v === undefined) errors.push(gameText(language, '缺少规则选项 {0}', o.key));
    else if (o.type === 'choice' && !o.choices?.some((c) => c.value === v)) errors.push(gameText(language, '规则选项 {0} 的值 {1} 不合法', o.key, String(v)));
  }
  return errors;
}
