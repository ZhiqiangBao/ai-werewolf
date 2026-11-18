import { expect, it } from 'vitest';
import { buildRuleCard, buildRules } from '@werewolf/engine';
import { replay } from '../../../scripts/video/replay';
import { completeHosting } from '../../../scripts/video/hosting';
import { allRoleRules } from '../../../scripts/video/rule-cards';
import { buildClips, type Fact, type Script } from '../../../scripts/video/project';
import { assertPlayerSources } from '../../../scripts/video/integrity';
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
    { seq: 8, day: 7, phase: 'night', type: 'guard.skip', audience: [8], text: '守卫选择空守。', payload: {} },
  ];
  const room: RoomBrief = { roomId: 'fixture', status: 'ended', paused: false, viewer: 'host', presetName: '', seats: [] };
  const projection = projectGod(game.state, events);
  const hosted = buildHostedVideoScript(projection, room);
  const script = JSON.parse(JSON.stringify(hosted)) as typeof hosted;
  expect(script.chapters).toStrictEqual(hosted.chapters);
  const lines = script.chapters.flatMap((chapter) => chapter.entries);
  expect(lines.filter((entry) => entry.type === 'hosting.choice').map((entry) => [entry.voiceKey, entry.text])).toEqual([
    ['seat-1', '我使用模仿魔镜，目标是12号。'], ['seat-1', '我今晚刀2号。'], ['seat-8', '今晚空守。'],
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

it('上帝配音稿按真实选择分配席位声线，每轮女巫不用药只说一次', () => {
  const game = new TestGame({ preset: 'merchant12' });
  const event = (seq: number, day: number, type: string, audience: GameEvent['audience'], payload: GameEvent['payload'] = {}, phase: GameEvent['phase'] = 'night'): GameEvent =>
    ({ seq, day, phase, type, audience, payload, text: type });
  const events = [
    event(1, 1, 'merchant.wait', [4]),
    event(2, 1, 'witch.knife', [9], { knife: 9 }),
    event(3, 1, 'witch.no_save', [9], { target: 9 }),
    event(4, 1, 'witch.no_poison', [9]),
    event(5, 2, 'merchant.gift', [4], { target: 11, skill: 'guard' }),
    event(6, 2, 'merchant.gift.received', [11], { skill: 'guard' }),
    event(7, 2, 'lucky.skip', [11], { skill: 'guard' }),
    event(8, 2, 'witch.no_save', [9]),
    event(9, 2, 'witch.poison', [9], { target: 3 }),
    event(10, 3, 'lucky.guard', [11], { target: 11 }),
    event(11, 3, 'action.fallback', [9]),
    event(12, 3, 'witch.no_save', [9]),
    event(13, 3, 'witch.no_poison', [9]),
    event(14, 3, 'witch.save', [9], { target: 6 }),
    event(15, 3, 'witch.no_poison', [9]),
    event(16, 3, 'hunter.decline', [7], {}, 'day'),
    event(17, 3, 'hunter.decline', 'public', { seat: 7 }, 'day'),
    event(18, 3, 'judge', [11], { step: 'badge.duty' }, 'day'),
    event(19, 3, 'badge.tear', 'public', { from: 11 }, 'day'),
    event(20, 3, 'badge.tear', 'public', { from: 2 }, 'day'),
    event(21, 3, 'action.fallback', [6], {}, 'day'),
    event(22, 3, 'vote.result', 'public', { ballots: [{ voter: 6, target: null }, { voter: 8, target: 3 }], rows: [] }, 'day'),
  ];
  const room: RoomBrief = { roomId: 'choices', status: 'ended', paused: false, viewer: 'host', presetName: '', seats: [] };
  const projection = projectGod(game.state, events);
  const source = buildVideoScript(projection, room);
  const script = buildHostedVideoScript(projection, room);
  const clips = buildClips(script);
  const choices = clips.filter((clip) => clip.type === 'hosting.choice');

  expect(choices.map((clip) => [clip.sourceSeq, clip.voiceKey, clip.text])).toEqual([
    [1, 'seat-4', '今晚先等等，保留交易机会。'],
    [4, 'seat-9', '今晚不用药。'],
    [5, 'seat-4', '我把守护送给11号。'],
    [7, 'seat-11', '我先留着守护。'],
    [9, 'seat-9', '我用毒药毒3号。'],
    [10, 'seat-11', '我守护11号。'],
    [14, 'seat-9', '我用解药救6号。'],
    [16, 'seat-7', '我放弃开枪。'],
    [19, 'seat-11', '我撕掉警徽。'],
    [22, 'seat-8', '我投3号。'],
  ]);
  expect(clips.filter((clip) => clip.voiceKey === 'judge' && ['witch.no_save', 'witch.no_poison', 'witch.save', 'witch.poison'].includes(clip.type)).map((clip) => clip.text))
    .toEqual(['女巫请闭眼。', '女巫请闭眼。', '系统托管。女巫请闭眼。', '女巫请闭眼。']);
  expect(script.events).toEqual(source.events);
  expect(() => assertPlayerSources(source, script, clips)).not.toThrow();
  expect(() => assertPlayerSources(source, script, [{ ...choices[0], seat: 9, voiceKey: 'seat-9' }])).toThrow(/wrong actor/);
  const altered = { ...source, chapters: source.chapters.map((chapter) => ({
    ...chapter, entries: chapter.entries.map((entry) => entry.type === 'merchant.gift' ? { ...entry, data: { ...entry.data, target: 8 } } : entry),
  })) };
  expect(completeHosting(altered, altered).chapters.flatMap((chapter) => chapter.entries)
    .find((entry) => entry.sourceSeq === 5 && entry.type === 'hosting.choice')?.text).toBe('我把守护送给11号。');
});
