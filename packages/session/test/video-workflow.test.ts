import { describe, expect, it } from 'vitest';
import { replay } from '../../../scripts/video/replay';
import { assDocument, captionsFromWords, sourceCaptionWords } from '../../../scripts/video/timeline';
import { subtitleLayout } from '../../../scripts/video/geometry';
import { speakerIdentity } from '../../../scripts/video/speaker';
import { clipVoiceProfile, splitSpeech, spokenText, type Script, type Fact } from '../../../scripts/video/project';
import type { AudioMeta } from '../../../scripts/video/qwen';
import { draftNarration } from '../../../scripts/video/narration';
import { completeHosting } from '../../../scripts/video/hosting';
import { allRoleRules } from '../../../scripts/video/rule-cards';
import { buildRuleCard, buildRules } from '@werewolf/engine';

const fact = (seq: number, type: string, data: Record<string, unknown>, phase = 'day'): Fact => ({ sourceSeq: seq, type, data, phase, day: 1, audience: 'public', spoken: true, text: '' });
const source = (events: Fact[]): Script => ({ roomId: 'fixture', perspective: 'god', presetName: '', status: 'ended',
  cast: [1, 2, 3, 4].map((seat) => ({ seat, name: String(seat), role: 'villager', roleName: '平民', factionName: '好人阵营', voiceKey: `seat-${seat}` })), events, chapters: [], result: null });

describe('offline match replay', () => {
  it('includes every role in the match and keeps the full potion rules for scrolling', () => {
    const script = source([]);
    script.cast = ['werewolf', 'seer', 'witch', 'guard', 'hunter', 'villager'].map((role, i) => ({ seat: i + 1, role, name: String(i + 1), roleName: role, factionName: '', voiceKey: `seat-${i + 1}` }));
    script.ruleCard = buildRuleCard(buildRules('standard12'));
    const cards = allRoleRules(script);
    expect(cards.map((c) => c.role)).toEqual(['werewolf', 'seer', 'witch', 'guard', 'hunter', 'villager', 'sheriff']);
    expect(cards.find((c) => c.role === 'witch')?.text).toContain('两瓶药都用完后女巫夜里不再行动');
    expect(cards.find((c) => c.role === 'villager')?.text).toContain('没有夜间技能');
    expect(cards.some((c) => c.role === 'idiot')).toBe(false);
  });
  it('restores voting instructions before the recorded result without exposing that result early', () => {
    const script = source([fact(9, 'vote.result', { kind: 'exile', rows: [{ target: 4, weight: 3 }], outcome: 'exile', seat: 4, conclusion: '4号被投票放逐。' })]);
    script.chapters = [{ day: 1, phase: 'day', title: '第一天', entries: [{ sourceSeq: 9, type: 'vote.result', speaker: '法官', voiceKey: 'judge', text: '4号出局。', visibility: 'public', data: script.events[0].data }] }];
    const original = structuredClone(script.events);
    const hosted = completeHosting(script, { ...script, chapters: [] });
    const [invitation, result] = hosted.chapters[0].entries;
    expect(invitation.data.presentationKey).toBe('vote-open');
    expect(invitation.text).not.toContain('4号');
    expect(replay(hosted, invitation.data.replayThrough).alive.has(4)).toBe(true);
    expect(replay(hosted, result.sourceSeq).alive.has(4)).toBe(false);
    expect(result.voiceKey).toBe('judge');
    expect(result.text).toContain('4号3票');
    expect(hosted.events).toEqual(original);
  });
  it('asks the sheriff and voices the recorded choice without repeating the order', () => {
    const script = source([fact(1, 'vote.result', { kind: 'sheriff', outcome: 'elected', seat: 1 }), fact(2, 'speech.order', { direction: 'counterclockwise', order: [4, 3, 2, 1] })]);
    script.chapters = [{ day: 1, phase: 'day', title: '第一天', entries: [{ sourceSeq: 2, type: 'speech.order', speaker: '法官', voiceKey: 'judge', text: '发言顺序。', visibility: 'public', data: script.events[1].data }] }];
    const entries = completeHosting(script, script).chapters[0].entries;
    expect(entries.map((e) => e.voiceKey)).toEqual(['judge', 'seat-1']);
    expect(entries[1].data.presentationOnly).toBe(true);
    expect(entries[1].text).toContain('逆时针');
    expect(entries[1].text).toContain('从4号开始');
  });
  it('does not reveal deaths or a future badge transfer before the event', () => {
    const script = source([fact(1, 'vote.result', { kind: 'sheriff', outcome: 'elected', seat: 1 }), fact(2, 'night.resolution', { deaths: [{ seat: 2, causes: ['wolf'] }] }, 'night'), fact(3, 'badge.transfer', { from: 1, to: 3 })]);
    expect([...replay(script, 1).alive]).toEqual([1, 2, 3, 4]);
    expect(replay(script, 1).sheriff).toBe(1);
    expect([...replay(script, 2).alive]).toEqual([1, 3, 4]);
    expect(replay(script, 2).sheriff).toBe(1);
    expect(replay(script, 3).sheriff).toBe(3);
  });
  it('closes election flags on the announced result and marks exile once', () => {
    const script = source([fact(1, 'sheriff.start', {}), fact(2, 'sheriff.signup', { candidates: [1, 3] }), fact(3, 'sheriff.withdraw', { seat: 3 }), fact(4, 'vote.result', { kind: 'sheriff', outcome: 'elected', seat: 1 }), fact(5, 'vote.result', { kind: 'exile', outcome: 'exile', seat: 4 }), fact(6, 'exile', { seat: 4 })]);
    expect(replay(script, 3).election).toBe(true);
    expect([...replay(script, 3).withdrawn]).toEqual([3]);
    expect(replay(script, 4).election).toBe(false);
    expect([...replay(script, 6).alive]).toEqual([1, 2, 3]);
  });
  it('applies hunter shots to the target and keeps a revealed idiot alive', () => {
    const script = source([fact(1, 'hunter.shot', { shooter: 1, target: 2 }), fact(2, 'explode', { seat: 3 }), fact(3, 'vote.result', { kind: 'exile', outcome: 'revealed', seat: 4 }), fact(4, 'idiot.flip', { seat: 4 })]);
    expect([...replay(script, 4).alive]).toEqual([1, 4]);
  });
  it('drafts commentary from preceding facts and leaves player quotes alone', () => {
    const script = source([fact(1, 'dawn', { deaths: [] }), fact(2, 'night.resolution', { rows: [{ target: 2, blocked: true, blockers: ['guard'] }], deaths: [] }, 'night'), fact(3, 'dawn', { deaths: [] })]);
    script.chapters = [{ day: 1, phase: 'day', title: '第一天', entries: [
      { sourceSeq: 1, type: 'dawn', speaker: '法官', voiceKey: 'judge', text: '平安夜。', visibility: 'public', data: {} },
      { sourceSeq: 3, type: 'dawn', speaker: '法官', voiceKey: 'judge', text: '平安夜。', visibility: 'public', data: {} },
      { sourceSeq: 4, type: 'speech', speaker: '1号', voiceKey: 'seat-1', seat: 1, text: '玩家原话。', visibility: 'public', data: {} },
    ] }];
    const draft = draftNarration(script);
    expect(draft.edits[1]).toBeUndefined();
    expect(draft.edits[3].after?.[0].text).toContain('守中2号');
    expect(draft.edits[4]).toBeUndefined();
  });
});

describe('audio-led captions and script', () => {
  it('applies reviewed delivery only to the matching judge cue and retains the fixed voice', () => {
    const judge = { voice: 'fixed-judge', label: '法官', rate: 1.08, instruction: '默认主持' };
    const player = { ...judge, voice: 'fixed-player' };
    const voices = { model: 'fixture', profiles: { judge, 'seat-1': player }, judgeCues: { 'seer-open': { rate: 1.14, instruction: '整句自然连读' } } };
    const data = { presentationOnly: true, presentationKey: 'seer-open' };
    expect(clipVoiceProfile(voices, { voiceKey: 'judge', data })).toMatchObject({ voice: 'fixed-judge', rate: 1.14, instruction: '整句自然连读' });
    expect(clipVoiceProfile(voices, { voiceKey: 'judge', data: { ...data, presentationKey: 'guard-open' } })).toBe(judge);
    expect(clipVoiceProfile(voices, { voiceKey: 'judge', data: { ...data, presentationOnly: false } })).toBe(judge);
    expect(clipVoiceProfile(voices, { voiceKey: 'seat-1', data })).toBe(player);
    expect(judge.rate).toBe(1.08);
  });
  it('rejects invalid judge cue speed before a synthesis request', () => {
    const voices = { model: 'fixture', profiles: { judge: { voice: 'judge', label: '', rate: 1, instruction: '' } }, judgeCues: { 'seer-open': { rate: 0 } } };
    expect(() => clipVoiceProfile(voices, { voiceKey: 'judge', data: { presentationOnly: true, presentationKey: 'seer-open' } })).toThrow('Invalid judge cue rate');
  });
  it('centers day and night captions inside the text region, clear of the speaker portrait', () => {
    const document = assDocument([{ text: '十一号，平民。', start: .25, end: 2, phase: 'day' }, { text: '请睁眼。', start: 3, end: 4, phase: 'night' }]);
    const { caption, divider, panel } = subtitleLayout;
    expect(caption.x).toBeGreaterThan(divider.x);
    expect(Math.abs(caption.centerY - (panel.y + panel.height / 2))).toBeLessThanOrEqual(1);
    expect(document).toContain(`{\\an5\\pos(${caption.centerX},${caption.centerY})}十一号，平民。`);
    expect(document).toContain('0:00:00.25,0:00:02.00,Day');
    expect(document).toContain('0:00:03.00,0:00:04.00,Night');
  });
  it('uses the cast identity even when a player claims another role, and retains action provenance', () => {
    const script = source([]);
    script.cast[0].role = 'werewolf'; script.cast[0].roleName = '狼人';
    const clip = { seat: 1, voiceKey: 'seat-1', type: 'speech', data: {}, text: '我是预言家。' };
    expect(speakerIdentity(script, clip)).toMatchObject({ kind: 'player', seat: 1, title: '1号 · 狼人' });
    expect(speakerIdentity(script, { ...clip, type: 'hosting.choice' }).marker).toBe('行动转述');
    expect(speakerIdentity(script, { ...clip, data: { systemFallback: true } }).marker).toBe('系统托管');
  });
  it('gives the judge and commentator separate identities without inventing player seats', () => {
    const clip = { voiceKey: 'judge', type: 'hosting.judge', data: {} };
    expect(speakerIdentity(source([]), clip)).toMatchObject({ kind: 'judge', title: '法官' });
    expect(speakerIdentity(source([]), { ...clip, voiceKey: 'commentator' })).toMatchObject({ kind: 'commentator', title: '上帝解说' });
    expect(speakerIdentity(source([]), clip)).not.toHaveProperty('seat');
    expect(() => speakerIdentity(source([]), { ...clip, seat: 99 })).toThrow('Missing speaker seat');
  });
  it('keeps symbolic player wording and merges actual spoken timestamps for mathematical symbols', () => {
    const meta = { text: '四号≥八号。', sentences: [{ index: 0, text: '', words: [
      { text: '四号', begin_time: 0, end_time: 200 },
      { text: '大', begin_time: 200, end_time: 300 }, { text: '于', begin_time: 300, end_time: 400 },
      { text: '等', begin_time: 400, end_time: 500 }, { text: '于', begin_time: 500, end_time: 600 },
      { text: '八号。', begin_time: 600, end_time: 800 },
    ] }] } as AudioMeta;
    const words = sourceCaptionWords(meta);
    expect(words.map((w) => w.text).join('')).toBe(meta.text);
    expect(words[1]).toMatchObject({ text: '≥', begin_time: 200, end_time: 600 });
  });
  it('uses submitted spelling for homophones while preserving every provider word time', () => {
    const meta = { text: '请睁眼。', sentences: [{ index: 0, text: '请睁眼。', words: [
      { text: '请', begin_time: 100, end_time: 300 }, { text: '争', begin_time: 300, end_time: 600 }, { text: '眼。', begin_time: 600, end_time: 900 },
    ] }] } as AudioMeta;
    const words = sourceCaptionWords(meta);
    expect(words.map((w) => [w.begin_time, w.end_time])).toEqual([[100, 300], [300, 600], [600, 900]]);
    expect(words.map((w) => w.text).join('')).toBe('请睁眼。');
    expect(captionsFromWords(meta, 1).map((c) => c.text).join('')).toBe('请睁眼。');
    expect(meta.sentences[0].words[1].text).toBe('争');
  });
  it('refuses to invent timing when provider labels omit a spoken character', () => {
    const meta = { text: '请睁眼。', sentences: [{ index: 0, text: '', words: [{ text: '请眼。', begin_time: 100, end_time: 900 }] }] } as AudioMeta;
    expect(() => sourceCaptionWords(meta)).toThrow('realignment is required');
  });
  it('preserves complete original speech when splitting a long paragraph', () => {
    const text = ('十号发言。警徽流和票型都应该一起看，不能只看表态。').repeat(20);
    const parts = splitSpeech(text, 100);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join('')).toBe(text);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
  });
  it('normalizes seat numbers, vote weights and arrows without changing the facts', () => {
    expect(spokenText('12号 1.5票，2号→10号。')).toBe('十二号 一点五票，二号投给十号。');
  });
  it('uses provider times across sentences rather than guessed reading durations', () => {
    const meta = { text: '前句。后句。', sentences: [
      { index: 0, text: '前句。', words: [{ text: '前', begin_time: 300, end_time: 500 }, { text: '句。', begin_time: 500, end_time: 1000 }] },
      { index: 1, text: '后句。', words: [{ text: '后', begin_time: 2200, end_time: 2500 }, { text: '句。', begin_time: 2500, end_time: 2800 }] },
    ] } as AudioMeta;
    const cues = captionsFromWords(meta, 3);
    expect(cues).toEqual([{ text: '前句。', start: .24, end: 1.12 }, { text: '后句。', start: 2.14, end: 2.92 }]);
  });
  it('refuses fabricated subtitle timing when a voice returns no timestamps', () => {
    expect(() => captionsFromWords({ sentences: [], text: '无时间戳' } as unknown as AudioMeta, 10)).toThrow(/timestamps/);
  });
});
