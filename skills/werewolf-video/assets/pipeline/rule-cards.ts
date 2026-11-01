import { getRole } from '../../packages/engine/src/index';
import type { Script } from './project';

/** All roles in this match, using complete public rules or the actual role module summary. */
export function allRoleRules(script: Script) {
  const lines = (script.ruleCard ?? '').split('\n');
  const find = (label: string) => lines.filter((l) => l.startsWith(`· ${label}：`)).map((l) => l.replace(`· ${label}：`, '')).join('\n');
  const present = [...new Set(script.cast.map((c) => c.role))];
  const order = [...new Set(['werewolf', 'seer', 'witch', 'guard', 'hunter', 'villager', ...present])].filter((id) => present.includes(id));
  const cards = order.map((id) => {
    const role = getRole(id), count = script.cast.filter((c) => c.role === id).length;
    return { title: `${role.name} · ${count}人`, text: find(role.name) || role.summary, role: id };
  });
  const badge = find('警徽');
  if (badge) cards.push({ title: '警徽与警长', text: badge, role: 'sheriff' });
  return cards;
}
