import { registerCore } from './flow';
import { BUILTIN_PRESETS } from './presets';
import { registerPreset, registerRole } from './registry';
import { guard } from './roles/guard';
import { hunter } from './roles/hunter';
import { idiot } from './roles/idiot';
import { seer } from './roles/seer';
import { villager } from './roles/villager';
import { werewolf } from './roles/werewolf';
import { witch } from './roles/witch';

export const BUILTIN_ROLES = [werewolf, villager, seer, witch, hunter, guard, idiot];

let registered = false;

export function registerBuiltins(): void {
  if (registered) return;
  registered = true;
  registerCore();
  for (const role of BUILTIN_ROLES) registerRole(role);
  for (const preset of BUILTIN_PRESETS) registerPreset(preset);
}
