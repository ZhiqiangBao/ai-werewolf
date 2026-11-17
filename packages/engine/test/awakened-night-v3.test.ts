import { describe, expect, it } from 'vitest';
import { buildMessages } from '../../llm/src/prompt';
import { buildVideoScript, gameRecordEvents } from '@werewolf/protocol';
import type { GameEvent, RoomBrief } from '@werewolf/protocol';
import { projectGod, projectSeat } from '../src/index';
import { syncThread, type SeatThread } from '../../session/src/agent';
import { completeHosting } from '../../../scripts/video/hosting';
import type { Entry, Script } from '../../../scripts/video/project';
import { TestGame } from './harness';

const deal = ['werewolf', 'werewolf', 'werewolf', 'awakened_wolf', 'mirror_maiden', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];
const noSheriff = { 'sheriff.enabled': false };
const room: RoomBrief = { roomId: 'synthetic-awakened', status: 'running', paused: false, viewer: 'host', presetName: '镜隐迷踪', seats: [] };

function scriptOf(game: TestGame): Script {
  return buildVideoScript(projectGod(game.state, game.events), room) as unknown as Script;
}

function leaveNight(game: TestGame): void {
  const day = game.state.day;
  game.until((current) => current.state.phase !== 'night' || current.state.day !== day);
}

describe('觉醒隐狼夜间版本 3', () => {
  it('只有版本 3 使用 night:awakened，版本 1 和 2 保持原阶段', () => {
    const current = new TestGame({ preset: 'mirror12', deal, values: noSheriff });
    expect(current.state.rules.awakenedNightVersion).toBe(3);
    expect(current.state.rules.nightOrder).toEqual(['awakened', 'guard', 'werewolf', 'mirror_maiden', 'witch']);
    expect(current.pending?.step.type).toBe('night:awakened');

    const version2 = new TestGame({ preset: 'mirror12', deal, awakenedNightVersion: 2, values: noSheriff });
    expect(version2.state.rules.nightOrder).toEqual(['awakened_mimic', 'guard', 'werewolf', 'mirror_maiden', 'witch']);
    expect(version2.pending?.step.type).toBe('night:awakened_mimic');

    const version1 = new TestGame({ preset: 'mirror12', deal, awakenedNightVersion: 1, values: noSheriff });
    expect(version1.state.rules.nightOrder).toEqual(['awakened_mimic', 'guard', 'werewolf', 'awakened_knife', 'mirror_maiden', 'witch', 'awakened_skill']);
    expect(version1.pending?.step.type).toBe('night:awakened_mimic');
  });

  it('同一局只在自己的轮次学习，继承后先用技能再出刀，身份通知不占轮次', () => {
    const game = new TestGame({ preset: 'mirror12', deal, values: noSheriff });
    const stored: GameEvent = {
      seq: 0, day: 0, phase: 'setup', type: 'awakened.identity', audience: [4],
      text: '你是觉醒隐狼，真实阵营始终为狼人。你与其他狼人互不知晓身份，不参与他们的密谈，也不能自爆。', payload: {},
    };
    expect(game.events.some((event) => event.type === 'awakened.identity')).toBe(false);
    expect(game.publicTexts().filter((text) => text.includes('天黑请闭眼'))).toEqual(['第1夜，天黑请闭眼。']);
    expect(gameRecordEvents([stored, ...game.events]).some((event) => event.type === 'awakened.identity')).toBe(false);
    const seat = projectSeat(game.state, [stored, ...game.events], 4);
    const [system, user] = buildMessages(seat, '直接');
    expect(system.content).toContain('【你的身份】');
    expect(system.content).toContain('你始终属于狼人阵营');
    expect(user.content).not.toContain('你是觉醒隐狼');
    const thread: SeatThread = { seat: 4, seen: 0, messages: [] };
    syncThread(thread, [stored, ...game.events], system);
    expect(thread.messages.some((message) => message.content?.includes('你是觉醒隐狼'))).toBe(false);

    game.ok(4, 'awakened_mimic', { targetSeat: 6 });
    expect(game.events.findLast((event) => event.type === 'awakened.mimic')).toMatchObject({
      audience: [4],
      payload: { target: 6, role: 'witch', activeFromNight: 2 },
      round: { roundKind: 'awakened', roundId: 'night-1-awakened', actionKind: 'mimic', actorSeatId: 4, targetSeatId: 6 },
    });
    expect(game.hasTool('awakened_poison')).toBe(false);
    game.night();
    expect(game.events.filter((event) => event.day === 1 && (event.type === 'awakened.skill' || event.type === 'awakened.skip'))).toEqual([]);
    expect(game.view(4).events.findLast((event) => event.type === 'awakened.activated')).toMatchObject({ audience: [4], payload: { activeFromNight: 2 } });
    expect(game.view(4).events.findLast((event) => event.type === 'awakened.activated')).not.toHaveProperty('round');
    game.removeSeats(1, 2, 3);
    game.toNight();
    game.untilTool('awakened_poison');
    expect(game.pending?.step.type).toBe('night:awakened');
    game.ok(4, 'awakened_poison', { targetSeat: 9 });
    game.untilTool('awakened_kill');
    expect(game.pending?.step).toMatchObject({ type: 'night:werewolf', awakenedKnife: true });
    game.ok(4, 'awakened_kill', { targetSeat: 10 });
    expect(game.events.findLast((event) => event.type === 'awakened.skill')).toMatchObject({
      payload: { tool: 'awakened_poison', target: 9 },
      round: { roundKind: 'awakened', actionKind: 'skill', targetSeatId: 9 },
    });
    expect(game.events.findLast((event) => event.type === 'awakened.knife')).toMatchObject({
      payload: { target: 10 },
      round: { roundKind: 'wolf', actionKind: 'kill', targetSeatId: 10 },
    });
    expect(game.events.filter((event) => event.round && event.type === 'awakened.identity')).toEqual([]);

    const script = buildVideoScript(projectGod(game.state, [stored, ...game.events]), room) as unknown as Script;
    const hosted = completeHosting(script, script);
    const spoken = hosted.chapters.flatMap((chapter) => chapter.entries);
    expect(script.events.some((event) => event.type === 'awakened.identity')).toBe(false);
    expect(spoken.some((entry) => ['awakened.identity', 'awakened.inherit', 'awakened.activated'].includes(entry.type) || entry.text.includes('你是觉醒隐狼'))).toBe(false);
    const night1 = spoken.filter((entry) => entry.sourceSeq <= game.events.findLast((event) => event.day === 1 && event.type === 'phase' && event.phase === 'day')!.seq);
    expect(night1.filter((entry) => entry.text.includes('狼人请睁眼'))).toHaveLength(1);
    expect(night1.filter((entry) => entry.text === '狼人请闭眼。')).toHaveLength(1);
    expect(night1.some((entry) => entry.text === '狼人请睁眼，请提交今晚的攻击目标。')).toBe(false);
    const poisonSeq = game.events.findLast((event) => event.type === 'awakened.skill')!.seq;
    const knifeSeq = game.events.findLast((event) => event.type === 'awakened.knife')!.seq;
    expect(spoken.filter((entry) => entry.sourceSeq === poisonSeq).map((entry) => entry.text)).toEqual(['觉醒隐狼请睁眼。', '觉醒隐狼请提交本夜行动。', '我使用模仿毒药，目标是9号。', '觉醒隐狼请闭眼。']);
    expect(spoken.filter((entry) => entry.sourceSeq === knifeSeq).map((entry) => entry.text)).toEqual(['狼人请睁眼，请提交今晚的攻击目标。', '我今晚刀10号。', '狼人请闭眼。']);

    const legacy = new TestGame({ preset: 'mirror12', deal, awakenedNightVersion: 2, values: noSheriff });
    expect(legacy.events.some((event) => event.type === 'awakened.identity')).toBe(false);
    legacy.ok(4, 'awakened_mimic', { targetSeat: 6 });
    expect(legacy.events.findLast((event) => event.type === 'awakened.mimic')).not.toHaveProperty('round');
  });

  it('其余狼阵营存活时不出继承刀；出局后在狼人轮次提交，且不产生 wolf.kill.result', () => {
    const game = new TestGame({ preset: 'mirror12', deal, values: noSheriff });
    game.ok(4, 'awakened_wait');
    expect(game.events.findLast((event) => event.type === 'awakened.wait')?.round).toMatchObject({ actionKind: 'wait', targetSeatId: null, roundId: 'night-1-awakened' });
    game.untilTool('wolf_kill');
    expect(game.view(4).events.some((event) => event.type === 'wolf.chat' || event.type === 'wolf.kill.result')).toBe(false);
    game.night();
    expect(game.events.some((event) => event.type === 'awakened.knife')).toBe(false);
    game.removeSeats(1, 2, 3);
    game.toNight();
    game.untilTool('awakened_kill');
    expect(game.pending?.step).toMatchObject({ type: 'night:werewolf', awakenedKnife: true });
    expect(game.toolsOf(4).map((tool) => tool.name)).toEqual(['awakened_kill', 'awakened_empty_kill']);
    game.ok(4, 'awakened_empty_kill');
    expect(game.events.findLast((event) => event.type === 'awakened.knife')).toMatchObject({
      payload: { target: null },
      round: { roundKind: 'wolf', roundId: 'night-2-wolf', actionKind: 'kill', actorSeatId: 4, targetSeatId: null },
    });
    expect(game.events.filter((event) => event.day === 2 && event.type === 'wolf.kill.result')).toEqual([]);

    const hosted = completeHosting(scriptOf(game), scriptOf(game));
    const seq = game.events.findLast((event) => event.type === 'awakened.knife')!.seq;
    const lines = hosted.chapters.flatMap((chapter) => chapter.entries).filter((entry) => entry.sourceSeq === seq);
    expect(lines.map((entry) => entry.text)).toEqual(['狼人请睁眼，请提交今晚的攻击目标。', '我今晚空刀。', '狼人请闭眼。']);
    expect(lines[1]).toMatchObject({ type: 'hosting.choice', speaker: '觉醒隐狼', seat: 4, voiceKey: 'seat-4' });

    const version2 = new TestGame({ preset: 'mirror12', deal, awakenedNightVersion: 2, values: noSheriff });
    version2.ok(4, 'awakened_wait');
    version2.night();
    version2.removeSeats(1, 2, 3);
    version2.toNight();
    version2.untilTool('awakened_kill');
    expect(version2.pending?.step.type).toBe('night:awakened_knife');
    version2.ok(4, 'awakened_kill', { targetSeat: 10 });
    expect(version2.events.findLast((event) => event.type === 'awakened.knife')).toMatchObject({ payload: { target: 10 } });
    expect(version2.events.findLast((event) => event.type === 'awakened.knife')).not.toHaveProperty('round');
  });

  it('禁止空刀时记录系统选择的实际目标，托管结果不伪装成玩家发言', () => {
    const game = new TestGame({ preset: 'mirror12', deal, values: { ...noSheriff, 'wolf.allowEmpty': false } });
    game.ok(4, 'awakened_mimic', { targetSeat: 1 });
    expect(game.events.some((event) => event.day === 1 && event.type === 'awakened.skill')).toBe(false);
    leaveNight(game);
    game.removeSeats(1, 2, 3);
    game.toNight();
    game.untilTool('awakened_claw');
    expect(game.pending?.step.type).toBe('night:awakened');
    game.ok(4, 'awakened_claw', { targetSeat: 9 });
    expect(game.events.findLast((event) => event.type === 'awakened.skill')).toMatchObject({
      type: 'awakened.skill',
      payload: { tool: 'awakened_claw', target: 9 },
      round: { roundKind: 'awakened', actionKind: 'skill', actorSeatId: 4, targetSeatId: 9 },
    });
    game.untilTool('awakened_kill');
    expect(game.toolsOf(4).map((tool) => tool.name)).toEqual(['awakened_kill']);
    game.auto(4);
    const knife = game.events.findLast((event) => event.type === 'awakened.knife');
    expect(knife?.payload.target).toEqual(expect.any(Number));
    expect(knife?.round).toMatchObject({ roundKind: 'wolf', actionKind: 'kill', targetSeatId: knife?.payload.target });
    game.untilTool('witch_act');
    expect(game.view(6).events.findLast((event) => event.type === 'witch.targets')).toMatchObject({
      audience: [6],
      payload: { targets: [9, knife?.payload.target].filter((seat): seat is number => typeof seat === 'number').sort((a, b) => a - b) },
    });
    expect(game.events.filter((event) => event.day === 2 && event.type === 'wolf.kill.result')).toEqual([]);

    const hosted = completeHosting(scriptOf(game), scriptOf(game));
    const lines = hosted.chapters.flatMap((chapter) => chapter.entries).filter((entry) => entry.sourceSeq === knife?.seq);
    expect(lines.map((entry) => entry.text)).toEqual([
      '狼人请睁眼，请提交今晚的攻击目标。',
      `系统托管，4号的攻击目标记为${knife?.payload.target}号。`,
      '狼人请闭眼。',
    ]);
    expect(lines[1]).toMatchObject({ type: 'hosting.judge', voiceKey: 'judge', data: { actionSummary: true } });
    expect(lines[1]).not.toHaveProperty('seat');
    expect(lines.some((entry) => entry.text.includes('我今晚'))).toBe(false);
  });

  it('模仿魔镜保留原事件，并投影为觉醒轮次技能', () => {
    const game = new TestGame({ preset: 'mirror12', deal, toolsetVersion: 2, values: noSheriff });
    game.ok(4, 'awakened_mimic', { targetSeat: 5 });
    leaveNight(game);
    game.toNight();
    game.until((current) => current.waiting().includes(4) && current.hasTool('mirror_inspect'));
    expect(game.pending?.step.type).toBe('night:awakened');
    game.ok(4, 'mirror_inspect', { targetSeat: 6 });
    const result = game.view(4).events.findLast((event) => event.type === 'mirror.result');
    expect(result).toMatchObject({
      type: 'mirror.result',
      payload: { target: 6, role: 'witch', roleName: '女巫' },
      round: { roundKind: 'awakened', actionKind: 'skill', actorSeatId: 4, targetSeatId: 6 },
    });
    game.untilTool('mirror_skip');
    game.ok(5, 'mirror_skip');
    expect(game.view(5).events.findLast((event) => event.type === 'mirror.skip')).not.toHaveProperty('round');
  });
});

describe('觉醒隐狼与普通狼刀的上帝视频台词', () => {
  it('按轮次生成主持句和座位行动句，托管行动使用独立摘要', () => {
    const entry = (sourceSeq: number, type: string, data: Record<string, unknown>, audience: number[] | 'public' = [4]) => ({
      sourceSeq, type, speaker: '法官', voiceKey: 'judge', text: '事实', visibility: 'private', data,
      day: 1, phase: 'night', audience, spoken: true,
    });
    const script = {
      roomId: 'fixture', perspective: 'god', presetName: '', status: 'ended', locale: 'zh-CN', result: null, ruleCard: '',
      cast: [
        { seat: 4, role: 'awakened_wolf', name: '4', roleName: '觉醒隐狼', factionName: '狼人', voiceKey: 'seat-4' },
        { seat: 5, role: 'werewolf', name: '5', roleName: '狼人', factionName: '狼人', voiceKey: 'seat-5' },
      ],
      events: [
        entry(1, 'awakened.mimic', { target: 5, round: { roundKind: 'awakened' } }),
        entry(2, 'awakened.skip', { round: { roundKind: 'awakened' }, systemFallback: true }),
        entry(3, 'wolf.kill.result', { picks: [[5, 10], [4, null]], knife: 10, fallbackSeats: [4] }, [4, 5]),
      ],
      chapters: [{ day: 1, phase: 'night', title: '第1夜', entries: [] as Entry[] }],
    } satisfies Script;
    script.chapters[0].entries = script.events.map(({ day: _day, phase: _phase, audience: _audience, spoken: _spoken, ...item }) => item);
    const hosted = completeHosting(script, script);
    const texts = (seq: number) => hosted.chapters[0].entries.filter((item) => item.sourceSeq === seq).map((item) => item.text);
    expect(texts(1)).toEqual(['觉醒隐狼请睁眼。', '觉醒隐狼请提交本夜行动。', '我模仿5号。', '觉醒隐狼请闭眼。']);
    expect(hosted.chapters[0].entries.find((item) => item.text === '我模仿5号。')).toMatchObject({ speaker: '觉醒隐狼', seat: 4, voiceKey: 'seat-4' });
    expect(texts(2)).toEqual(['觉醒隐狼请睁眼。', '觉醒隐狼请提交本夜行动。', '系统托管，4号本夜不发动技能。', '觉醒隐狼请闭眼。']);
    expect(hosted.chapters[0].entries.find((item) => item.text.startsWith('系统托管'))).not.toHaveProperty('seat');
    expect(texts(3)).toEqual(['狼人请睁眼，请提交今晚的攻击目标。', '我今晚刀10号。', '系统托管，4号今晚空刀。', '狼人请闭眼。']);
    const wolfLine = hosted.chapters[0].entries.find((item) => item.text === '我今晚刀10号。');
    expect(wolfLine).toMatchObject({ speaker: '5号狼人', seat: 5, voiceKey: 'seat-5' });
    expect(hosted.chapters[0].entries.some((item) => item.seat === 4 && item.text.includes('我今晚'))).toBe(false);
  });

  it('狼队密谈和落刀共用一次睁眼、一次闭眼', () => {
    const entry = (sourceSeq: number, type: string, data: Record<string, unknown>, audience: number[] | 'public') => ({
      sourceSeq, type, speaker: '法官', voiceKey: 'judge', text: '事实', visibility: 'private' as const, data, day: 1, phase: 'night', audience, spoken: true,
    });
    const chat = entry(1, 'wolf.chat', { seat: 5, content: '商量一下' }, [5]);
    const result = entry(2, 'wolf.kill.result', { picks: [[5, 10]], knife: 10 }, [5]);
    const script = {
      roomId: 'fixture', perspective: 'god', presetName: '', status: 'ended', locale: 'zh-CN', result: null, ruleCard: '',
      cast: [{ seat: 5, role: 'werewolf', name: '5', roleName: '狼人', factionName: '狼人', voiceKey: 'seat-5' }],
      events: [chat, result],
      chapters: [{ day: 1, phase: 'night', title: '第1夜', entries: [chat, result].map(({ day: _day, phase: _phase, audience: _audience, spoken: _spoken, ...item }) => item) }],
    } satisfies Script;
    const lines = completeHosting(script, script).chapters[0].entries.map((item) => item.text);
    expect(lines.filter((text) => text.includes('狼人请睁眼'))).toEqual(['狼人请睁眼，确认同伴。请商量今晚的击杀目标。']);
    expect(lines.filter((text) => text === '狼人请闭眼。')).toEqual(['狼人请闭眼。']);
    expect(lines).toContain('我今晚刀10号。');
  });
});
