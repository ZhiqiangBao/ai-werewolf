import { expect, it } from 'vitest';
import { buildRuleCard, buildRules } from '@werewolf/engine';
import { replay } from '../../../scripts/video/replay';
import { completeHosting } from '../../../scripts/video/hosting';
import { allRoleRules } from '../../../scripts/video/rule-cards';
import type { Fact, Script } from '../../../scripts/video/project';
import { buildHostedVideoScript } from '../../../apps/web/src/video';
import { projectGod } from '../../engine/src';
import { TestGame } from '../../engine/test/harness';
import type { GameEvent, RoomBrief } from '@werewolf/protocol';
import { buildVideoScript, videoChaptersFromEvents } from '@werewolf/protocol';

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

it('网页导出的上帝剪辑稿按旧房间事实主持，重新导入可还原配音前的章节', () => {
  const game = new TestGame({ preset: 'mirror12', deal: ['awakened_wolf', 'werewolf', 'werewolf', 'werewolf', 'mirror_maiden', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'] });
  const events: GameEvent[] = [
    { seq: 1, day: 6, phase: 'night', type: 'phase', audience: 'public', text: '天黑。', payload: {} },
    { seq: 2, day: 6, phase: 'night', type: 'mirror.result', audience: [1], text: '魔镜结果。', payload: { target: 12 } },
    { seq: 3, day: 6, phase: 'night', type: 'awakened.knife', audience: [1], text: '刀人。', payload: { target: 2 } },
    { seq: 4, day: 6, phase: 'day', type: 'speech', audience: 'public', text: '记录', payload: { seat: 2, content: '这是玩家原话。' } },
    { seq: 5, day: 6, phase: 'day', type: 'action.fallback', audience: [1], text: '', payload: {} },
    { seq: 6, day: 6, phase: 'day', type: 'speech.order', audience: 'public', text: '从2号开始。', payload: { direction: 'clockwise', order: [2, 3] } },
    { seq: 7, day: 6, phase: 'day', type: 'exile', audience: 'public', text: '已合并播报。', payload: { seat: 2, announced: true } },
  ];
  const room: RoomBrief = { roomId: 'fixture', status: 'ended', paused: false, viewer: 'host', presetName: '', seats: [] };
  const projection = projectGod(game.state, events);
  const script = JSON.parse(JSON.stringify(buildHostedVideoScript(projection, room))) as ReturnType<typeof buildHostedVideoScript>;
  const lines = script.chapters.flatMap((chapter) => chapter.entries);
  expect(lines.filter((entry) => entry.type === 'hosting.choice').map((entry) => [entry.voiceKey, entry.text])).toEqual([
    ['seat-1', '我使用模仿魔镜，目标是12号。'], ['seat-1', '我今晚刀2号。'],
  ]);
  expect(lines.some((entry) => entry.text === '觉醒隐狼请睁眼。')).toBe(true);
  expect(lines.some((entry) => entry.text === '狼人请闭眼。')).toBe(true);
  expect(lines.find((entry) => entry.type === 'speech')?.text).toBe('这是玩家原话。');
  expect(script.hosting).toEqual({ version: 1, fallbackSeqs: [6] });
  expect(script.events.find((event) => event.sourceSeq === 6)?.data.systemFallback).toBeUndefined();
  const restored = videoChaptersFromEvents(script.events, script.locale, new Set(script.hosting.fallbackSeqs));
  expect(restored).toEqual(buildVideoScript(projection, room).chapters);
  expect(restored.flatMap((chapter) => chapter.entries).find((entry) => entry.type === 'speech.order')?.data.systemFallback).toBe(true);
  expect(restored.flatMap((chapter) => chapter.entries).some((entry) => entry.type === 'exile')).toBe(false);
});
