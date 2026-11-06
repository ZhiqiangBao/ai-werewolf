import { getRole } from '../../packages/engine/src/index';
import type { Script } from './project';
import { videoLocale, videoRole, videoText } from './video-locale';

/** All roles in this match, using complete public rules or the actual role module summary. */
export function allRoleRules(script: Script, locale = videoLocale(script.locale)) {
  const lines = (script.ruleCard ?? '').split('\n');
  const find = (label: string) => lines.flatMap((line) => {
    for (const separator of ['：', ': ']) if (line.startsWith(`· ${label}${separator}`)) return [line.slice(`· ${label}${separator}`.length)];
    return [];
  }).join('\n');
  const present = [...new Set(script.cast.map((c) => c.role).filter((role) => role !== 'unknown'))];
  const order = [...new Set(['werewolf', 'seer', 'witch', 'guard', 'hunter', 'villager', ...present])].filter((id) => present.includes(id));
  const cards = order.map((id) => {
    const role = getRole(id), count = script.cast.filter((c) => c.role === id).length;
    const sourceName = script.cast.find((c) => c.role === id)?.roleName ?? role.name;
    const actual = find(sourceName) || find(role.name) || (id === 'werewolf' ? find('普通狼人') || find('Ordinary Werewolves') || find('通常人狼') : '');
    const title = script.perspective === 'player' ? videoRole(locale, id, sourceName)
      : new Intl.Locale(locale).language === 'en' ? `${videoRole(locale, id, sourceName)} · ${count} ${count === 1 ? 'player' : 'players'}`
        : videoText(locale, '{0} · {1}人', videoRole(locale, id, sourceName), count);
    return { title, text: actual || videoText(locale, '默认身份简介（zh-CN）：') + role.summary, role: id };
  });
  const badge = find('警徽') || find('Badge');
  if (badge) cards.push({ title: videoText(locale, '警徽与警长'), text: badge, role: 'sheriff' });
  return cards;
}
