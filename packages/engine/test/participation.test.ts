import { describe, expect, it } from 'vitest';
import { abandonGame, seatTasksComplete } from '../src/index';
import { DEAL9, TestGame } from './harness';

describe('座位任务完成判定', () => {
  it('存活席位即使已经提交本轮行动也继续参与', () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false } });
    const seat = g.waiting()[0];
    g.auto(seat);
    expect(g.state.players[seat - 1].alive).toBe(true);
    expect(seatTasksComplete(g.state, seat)).toBe(false);
  });

  it('未处理出局职责不能停止；旧档不依赖额外完成标记', () => {
    const g = new TestGame({ deal: DEAL9 });
    const state = structuredClone(g.state);
    state.players[8].alive = false;
    state.deaths.push({ seat: 9, day: 1, via: 'night', causes: ['wolf'], batch: 1, lastWords: true, hooked: false });
    expect(seatTasksComplete(state, 9)).toBe(false);
    expect(seatTasksComplete(JSON.parse(JSON.stringify(state)), 9)).toBe(false);
  });

  it('同批另一名猎人仍有职责时，没有遗言和其他职责的死者立即结清', () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false, 'lastWords.firstNight': false } });
    g.night({ kill: 6, poison: 7, inspect: 1 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    expect(seatTasksComplete(g.state, 6)).toBe(false);
    expect(seatTasksComplete(g.state, 7)).toBe(true);
  });

  it('终局仍同步存活席，已出局席视为任务结清', () => {
    const g = new TestGame({ deal: DEAL9 });
    expect(seatTasksComplete(g.state, 1)).toBe(false);
    g.state.players[8].alive = false;
    const ended = abandonGame(g.state).state;
    expect(ended.result?.winner).toBe('draw');
    expect(seatTasksComplete(ended, 1)).toBe(false);
    expect(seatTasksComplete(ended, 9)).toBe(true);
  });

  it('同批猎人职责、开枪连锁、警徽与遗言按每席各自结清', () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false } });
    g.state.sheriff = 6;
    g.night({ kill: 6, poison: 7, inspect: 1 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    expect(g.state.deaths.map(d => d.seat)).toEqual(expect.arrayContaining([6, 7]));
    expect(seatTasksComplete(g.state, 6)).toBe(false);
    // 7 的遗言尚未生成，仍在等待同批猎人的职责结束。
    expect(seatTasksComplete(g.state, 7)).toBe(false);
    g.ok(6, 'hunter_shoot', { target: 8 });
    expect(g.state.deaths.some(d => d.seat === 8 && d.causes.includes('shot'))).toBe(true);
    expect(g.hasTool('badge_dispose')).toBe(true);
    expect(seatTasksComplete(g.state, 6)).toBe(false);
    g.ok(6, 'badge_dispose', { target: 5 });
    expect(g.pending?.step).toMatchObject({ type: 'speech', kind: 'lastwords', seat: 6 });
    expect(seatTasksComplete(g.state, 6)).toBe(false);
    expect(seatTasksComplete(g.state, 7)).toBe(false);
    g.ok(6, 'speak', { content: '猎人遗言' });
    expect(g.pending?.step).toMatchObject({ type: 'speech', kind: 'lastwords', seat: 7 });
    expect(seatTasksComplete(g.state, 6)).toBe(true);
    expect(seatTasksComplete(g.state, 7)).toBe(false);
    g.ok(7, 'speak', { content: '第二名遗言' });
    expect(seatTasksComplete(g.state, 7)).toBe(true);
  });
});
