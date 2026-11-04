import { expect, it } from 'vitest';
import { buildRuleCard, buildRules } from '@werewolf/engine';
import { replay } from '../../../scripts/video/replay';
import { completeHosting } from '../../../scripts/video/hosting';
import { allRoleRules } from '../../../scripts/video/rule-cards';
import type { Fact, Script } from '../../../scripts/video/project';

it('对局视频按事件顺序复盘并生成对应规则卡和主持词', () => {
  const vote: Fact = { sourceSeq: 9, type: 'vote.result', data: { kind: 'exile', rows: [{ target: 4, weight: 3 }], outcome: 'exile', seat: 4, conclusion: '4号被投票放逐。' }, phase: 'day', day: 1, audience: 'public', spoken: true, text: '' };
  const script: Script = { roomId: 'fixture', perspective: 'god', presetName: '', status: 'ended',
    cast: ['werewolf', 'seer', 'witch', 'hunter'].map((role, i) => ({ seat: i + 1, role, name: String(i + 1), roleName: role, factionName: '', voiceKey: `seat-${i + 1}` })),
    events: [vote], chapters: [{ day: 1, phase: 'day', title: '第一天', entries: [{ sourceSeq: 9, type: 'vote.result', speaker: '法官', voiceKey: 'judge', text: '4号出局。', visibility: 'public', data: vote.data }] }], result: null,
    ruleCard: buildRuleCard(buildRules('classic9')) };
  const hosted = completeHosting(script, { ...script, chapters: [] });
  const [invitation, result] = hosted.chapters[0].entries;
  expect(invitation.text).not.toContain('4号');
  expect(replay(hosted, invitation.data.replayThrough).alive.has(4)).toBe(true);
  expect(replay(hosted, result.sourceSeq).alive.has(4)).toBe(false);
  expect(hosted.events).toEqual(script.events);
  expect(allRoleRules(script).find((card) => card.role === 'witch')?.text).toContain('有一瓶解药和一瓶毒药');
});
