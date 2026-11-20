import { getRole } from '../../packages/engine/src/index';
import { gameText } from '../../packages/protocol/src/index';
import type { Script } from './project';
import { videoUiLocale, videoRole, videoText } from './video-locale';

function sharedWolfTeamRules(lines: string[], matchLocale: string | undefined): string {
  // The public rules for Wolf King games group the wolves' night actions in one block.
  const introductions = [
    '· 狼队成员互知队友座位，共同参与狼队夜间行动。',
    '· 狼队：开局不提供队友名单；当夜参与狼队行动的玩家会看到彼此座位和投刀选择。',
  ].map((line) => gameText(matchLocale, line));
  const start = lines.findIndex((line) => introductions.includes(line));
  if (start === -1) return '';

  const tieRules = [
    '· 得票最多的玩家成为刀口；并列时向参与狼队成员公布选择并重投一次，仍并列取座位号较小者。',
    '· 得票最多的玩家成为刀口；并列时取座位号较小者。',
  ].map((line) => gameText(matchLocale, line));
  const end = lines.findIndex((line, index) => index > start && tieRules.includes(line));
  if (end === -1) return '';

  const section = lines.slice(start, end + 1);
  if (section.some((line) => !line.startsWith('· '))) return '';
  return section.map((line) => line.slice('· '.length)).join('\n');
}

/** All roles in this match, using complete public rules or the actual role module summary. */
export function allRoleRules(script: Script, locale = videoUiLocale(script.uiLocale)) {
  const lines = (script.ruleCard ?? '').split(/\r?\n/);
  const find = (label: string) => lines.flatMap((line) => {
    for (const separator of ['：', ': ']) if (line.startsWith(`· ${label}${separator}`)) return [line.slice(`· ${label}${separator}`.length)];
    return [];
  }).join('\n');
  const present = [...new Set((script.perspective === 'player' ? script.publicRoles ?? [] : script.cast.map((c) => c.role)).filter((role) => role !== 'unknown'))];
  const order = [...new Set(['werewolf', 'seer', 'witch', 'guard', 'hunter', 'villager', ...present])].filter((id) => present.includes(id));
  const wolfTeam = present.includes('wolf_king') ? sharedWolfTeamRules(lines, script.locale) : '';
  const cards = order.map((id) => {
    const role = getRole(id), count = script.cast.filter((c) => c.role === id).length;
    const sourceName = script.cast.find((c) => c.role === id)?.roleName ?? videoRole(locale, id, role.name);
    const actual = (id === 'werewolf' ? wolfTeam : '') || find(sourceName) || find(videoRole(locale, id, role.name)) || find(role.name)
      || (id === 'werewolf' ? find('普通狼人') || find('Ordinary Werewolves') || find('通常の人狼') || find('通常人狼') : '');
    const title = script.perspective === 'player' ? videoRole(locale, id, sourceName)
      : new Intl.Locale(locale).language === 'en' ? `${videoRole(locale, id, sourceName)} · ${count} ${count === 1 ? 'player' : 'players'}`
        : videoText(locale, '{0} · {1}人', videoRole(locale, id, sourceName), count);
    return { title, text: actual || videoText(locale, '默认身份简介（zh-CN）：') + role.summary, role: id };
  });
  const badge = find('警徽') || find('Badge');
  if (badge) cards.push({ title: videoText(locale, '警徽与警长'), text: badge, role: 'sheriff' });
  return cards;
}
