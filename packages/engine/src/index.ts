import type { PresetInfo, RoleInfo, RuleOptionInfo } from '@werewolf/protocol';
import { registerBuiltins } from './builtin';
import { allOptions, allPresets, allRoles } from './registry';
import { categoryName, factionName } from './text';

registerBuiltins();

export { Ctx } from './context';
export { createGame, submit, replay, waitingSeats, RulesError } from './game';
export type { CreateGameOptions, SubmitInput, EngineResult, ActionRecord } from './game';
export { projectSeat, projectSpectator, projectGod, buildAppendix } from './projection';
export { buildRuleCard } from './rulecard';
export { buildRules, validateRules, defaultValues, deriveNightOrder } from './rules';
export {
  registerRole,
  registerPreset,
  getRole,
  getPreset,
  allRoles,
  allPresets,
  allOptions,
  modulesIn,
} from './registry';
export { DEFAULT_PRESET } from './presets';
export { seatParam, textParam, speakTool, explodeTool, err } from './tools';
export type * from './types';

export function engineCatalog(): { presets: PresetInfo[]; roles: RoleInfo[]; options: RuleOptionInfo[] } {
  const owner = new Map<string, string>();
  for (const r of allRoles()) for (const o of r.options ?? []) owner.set(o.key, r.id);
  return {
    presets: allPresets().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      playerCount: p.roles.length,
      roles: p.roles,
      overrides: p.overrides ?? {},
      ...(p.tag ? { tag: p.tag } : {}),
    })),
    roles: allRoles().map((r) => ({
      id: r.id,
      name: r.name,
      faction: r.faction,
      factionName: factionName(r.faction),
      category: r.category,
      categoryName: categoryName(r.category),
      maxPerGame: r.maxPerGame,
      summary: r.summary,
    })),
    options: allOptions().map((o) => (owner.has(o.key) ? { ...o, owner: owner.get(o.key) } : o)),
  };
}
