import type { RuleSet } from '@werewolf/protocol';
import type { InterruptDef, OptionDef, PresetDef, RoleModule, StepHandler } from './types';

const roles = new Map<string, RoleModule>();
const presets = new Map<string, PresetDef>();
const coreSteps = new Map<string, StepHandler>();
const coreOptions: OptionDef[] = [];
const coreInterrupts: InterruptDef[] = [];
let stepCache: Map<string, StepHandler> | null = null;

export function registerRole(mod: RoleModule): void {
  if (roles.has(mod.id)) throw new Error(`身份模块重复注册：${mod.id}`);
  for (const key of Object.keys(mod.steps ?? {})) {
    if (coreSteps.has(key)) throw new Error(`步骤 ${key} 与核心流程重名`);
    for (const existing of roles.values()) if (existing.steps?.[key]) throw new Error(`步骤 ${key} 与身份 ${existing.id} 重名`);
  }
  roles.set(mod.id, mod);
  stepCache = null;
}

export function registerPreset(preset: PresetDef): void {
  if (presets.has(preset.id)) throw new Error(`版型重复注册：${preset.id}`);
  presets.set(preset.id, preset);
}

export function registerCoreSteps(steps: Record<string, StepHandler>): void {
  for (const [key, handler] of Object.entries(steps)) {
    if (coreSteps.has(key)) throw new Error(`核心步骤重复注册：${key}`);
    for (const existing of roles.values()) if (existing.steps?.[key]) throw new Error(`核心步骤 ${key} 与身份 ${existing.id} 重名`);
    coreSteps.set(key, handler);
  }
  stepCache = null;
}

export function registerCoreOptions(options: OptionDef[]): void {
  coreOptions.push(...options);
}

export function registerInterrupt(def: InterruptDef): void {
  coreInterrupts.push(def);
}

export function getRole(id: string): RoleModule {
  const mod = roles.get(id);
  if (!mod) throw new Error(`未注册的身份：${id}`);
  return mod;
}

export function hasRole(id: string): boolean {
  return roles.has(id);
}

export function allRoles(): RoleModule[] {
  return [...roles.values()];
}

export function getPreset(id: string): PresetDef {
  const p = presets.get(id);
  if (!p) throw new Error(`未注册的版型：${id}`);
  return p;
}

export function allPresets(): PresetDef[] {
  return [...presets.values()];
}

export function getStep(type: string): StepHandler {
  if (!stepCache) {
    stepCache = new Map(coreSteps);
    for (const mod of roles.values()) {
      for (const [key, handler] of Object.entries(mod.steps ?? {})) stepCache.set(key, handler);
    }
  }
  const h = stepCache.get(type);
  if (!h) throw new Error(`未注册的流程步骤：${type}`);
  return h;
}

export function allOptions(): OptionDef[] {
  const list = [...coreOptions];
  for (const mod of roles.values()) list.push(...(mod.options ?? []));
  return list;
}

export function getOption(key: string): OptionDef | undefined {
  return allOptions().find((o) => o.key === key);
}

/** 本局出现的身份模块，按注册顺序。 */
export function modulesIn(rules: RuleSet): RoleModule[] {
  const ids = new Set(rules.roles);
  return [...roles.values()].filter((m) => ids.has(m.id));
}

export function interruptsIn(rules: RuleSet): InterruptDef[] {
  const list = [...coreInterrupts];
  for (const mod of modulesIn(rules)) list.push(...(mod.interrupts ?? []));
  return list;
}
