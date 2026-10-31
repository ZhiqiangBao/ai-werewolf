import { describe, expect, it } from 'vitest';
import { buildVideoScript, gameRecordEvents, recordedBadgeOutcome, type GameEvent, type RoomBrief } from '../src/index';
import { projectGod } from '../../engine/src/index';
import { DEAL12, TestGame } from '../../engine/test/harness';

const ev = (seq: number, type: string, text: string, payload: Record<string, unknown> = {}, audience: GameEvent['audience'] = 'public'): GameEvent => ({ seq, type, text, payload, audience, day: 1, phase: 'night' });

describe('面向观众的记录与剪辑稿', () => {
  it('思考写12时仍展示实际警徽事件的5，不能跨到后续决策或从思考推断结果', () => {
    const thought = { seat: 8, decisionId: 'badge', thinking: '决定交给12号', reply: '', live: false, at: 0 };
    const question = ev(1, 'judge', '处理警徽', { step: 'badge.duty', decisionId: 'badge' }, [8]);
    const transfer = ev(2, 'badge.transfer', '8号将警徽移交给5号。', { from: 8, to: 5 });
    expect(recordedBadgeOutcome(thought, [question, transfer])).toEqual({ text: transfer.text, automatic: false });
    expect(recordedBadgeOutcome(thought, [question])).toBeNull();
    expect(recordedBadgeOutcome(thought, [question, ev(2, 'judge', '下一轮', { decisionId: 'next' }), transfer])).toBeNull();
    expect(recordedBadgeOutcome(thought, [question, ev(2, 'action.fallback', '托管', {}, [8]), transfer])?.automatic).toBe(true);
  });
  it('技术事件与行动邀请不进入画面，发言原文中的同类词语保持原样', () => {
    const text = '他说“轮到你”没有意义，我没有被拒绝。';
    const source = [ev(1, 'game.seed', 'seed'), ev(2, 'judge', '轮到你发言'), ev(3, 'action.rejected', '被拒绝'), ev(4, 'action.fallback', '已托管'), ev(5, 'speech', text, { seat: 2, content: text }), ev(6, 'night.resolution', '结算明细'), ev(7, 'exile', '重复出局', { announced: true })];
    expect(gameRecordEvents(source).map((e) => e.seq)).toEqual([5]);
    expect(gameRecordEvents(source)[0].payload.content).toBe(text);
  });

  it('兼容旧存档合并的问话，夜间操作改为客观播报而不修改原始数据', () => {
    const source = [ev(1, 'witch.knife', '刀口3号，请调工具', { knife: 3, prompt: '请选择用药' }, [10]), ev(2, 'guard.protect', '你守护了1号。', { target: 1 }, [11]), ev(3, 'seer.result', '你查验3号。', { target: 3, result: 'wolf' }, [6]), ev(4, 'sheriff.start', '请决定是否上警。', { prompt: '请使用工具' })];
    const before = structuredClone(source);
    const shown = gameRecordEvents(source);
    expect(shown.map((e) => e.text)).toEqual(['女巫（10号）获知刀口：3号。', '守卫（11号）守护1号。', '预言家（6号）查验3号：狼人。', '警长竞选开始。']);
    expect(source).toEqual(before);
  });

  it('真实引擎事件生成带身份、夜间操作和章节的剪辑稿，剔除内部问话', () => {
    const g = new TestGame({ deal: DEAL12, values: { 'sheriff.enabled': false } });
    g.night({ kill: null, inspect: 1 });
    const p = projectGod(g.state, g.events);
    const room: RoomBrief = { roomId: g.state.id, viewer: 'host', status: 'running', paused: false, presetName: p.presetName, seats: p.seats.map((s) => ({ seat: s.seat, name: s.name, controller: 'ai' })) };
    const script = buildVideoScript(p, room);
    const entries = script.chapters.flatMap((c) => c.entries);
    expect(script.cast).toHaveLength(12);
    expect(script.timing).toBe('untimed');
    expect(script.chapters.some((c) => c.phase === 'night')).toBe(true);
    expect(entries.some((e) => e.type === 'seer.result' && e.visibility === 'private')).toBe(true);
    expect(entries.some((e) => e.type === 'judge' || e.type.startsWith('action.'))).toBe(false);
    expect(script.events.some((e) => e.type === 'night.resolution' && !e.spoken)).toBe(true);
    expect(script.cast[0].voiceKey).toBe('seat-1');
    expect(JSON.stringify(script)).not.toContain('decisionId');
    expect(() => buildVideoScript(p, { ...room, viewer: 'spectator' })).toThrow('只有上帝视角');
  });
});
