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

export function deriveNightOrder(roles: string[]): string[] {
  const phases = new Map<string, number>();
  for (const id of new Set(roles)) {
    if (!hasRole(id)) continue;
    const mod = getRole(id);
    for (const phase of [...(mod.nightPhase ? [mod.nightPhase] : []), ...(mod.nightPhases ?? [])]) phases.set(phase.id, phase.order);
  }
  return [...phases.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

export interface BuildRulesOptions {
  toolsetVersion?: 1 | 2;
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
  const roles = opts.roles ? [...opts.roles] : [...preset.roles];
  const values: Record<string, RuleValue> = { ...defaultValues(), ...(preset.overrides ?? {}) };
  for (const [key, raw] of Object.entries(userValues)) {
    const o = getOption(key);
    if (!o || (!o.editable && !opts.allowFixed)) continue;
    const v = coerce(o, raw);
    if (v !== undefined) values[key] = v;
  }
  return {
    toolsetVersion: opts.toolsetVersion ?? 2,
    presetId: preset.id,
    ...(preset.version ? { presetVersion: preset.version } : {}),
    presetName: opts.name ?? preset.name,
    playerCount: roles.length,
    roles,
    nightOrder: deriveNightOrder(roles),
    values,
  };
}

/** 版型校验。返回中文原因列表，空列表表示可以开局。 */
export function validateRules(rules: RuleSet): string[] {
  const errors: string[] = [];
  if (rules.toolsetVersion !== undefined && rules.toolsetVersion !== 1 && rules.toolsetVersion !== 2) errors.push('工具版本只支持 1 或 2');
  if (rules.roles.length !== rules.playerCount) errors.push(`人数 ${rules.playerCount} 与身份数量 ${rules.roles.length} 不一致`);
  if (rules.playerCount < 4 || rules.playerCount > 20) errors.push('人数需要在 4 到 20 之间');
  const counts = new Map<string, number>();
  for (const r of rules.roles) counts.set(r, (counts.get(r) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (!hasRole(id)) {
      errors.push(`身份「${id}」没有注册`);
      continue;
    }
    const mod = getRole(id);
    if (n > mod.maxPerGame) errors.push(`${mod.name}最多 ${mod.maxPerGame} 名，当前 ${n} 名`);
  }
  if (errors.length) return errors;
  const mods = rules.roles.map(getRole);
  const wolves = mods.filter((m) => m.faction === 'wolf').length;
  const gods = mods.filter((m) => m.category === 'god').length;
  const villagers = mods.filter((m) => m.category === 'villager').length;
  if (wolves < 1) errors.push('至少需要 1 名狼人');
  if (rules.values.winCondition === 'side') {
    if (gods < 1) errors.push('屠边局至少需要 1 名神职');
    if (villagers < 1) errors.push('屠边局至少需要 1 名平民');
  } else if (mods.length - wolves < 1) errors.push('至少需要 1 名好人');
  for (const o of allOptions()) {
    const v = rules.values[o.key];
    if (v === undefined) errors.push(`缺少规则选项 ${o.key}`);
    else if (o.type === 'choice' && !o.choices?.some((c) => c.value === v)) errors.push(`规则选项 ${o.key} 的值 ${String(v)} 不合法`);
  }
  return errors;
}
