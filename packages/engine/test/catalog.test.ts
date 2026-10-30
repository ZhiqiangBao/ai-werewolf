import { describe, expect, it } from 'vitest';
import { seatTools } from '../src/catalog';
import { DEAL12, TestGame } from './harness';

describe('座位工具目录', () => {
  it('基础工具和身份工具整局固定，参数不随阶段变化', () => {
    const g = new TestGame({ deal: DEAL12 });
    const names = (seat: number) => seatTools(g.state, seat).map((t) => t.name);
    expect(names(1)).toEqual([
      'speak',
      'vote',
      'sheriff_signup',
      'sheriff_withdraw',
      'sheriff_vote',
      'set_speak_direction',
      'badge_dispose',
      'wolf_discuss',
      'wolf_kill',
      'wolf_explode',
      'wolf_explode_decision',
    ]);
    expect(names(5)).toContain('seer_inspect');
    expect(names(5)).not.toContain('wolf_kill');
    expect(names(9)).not.toContain('seer_inspect');

    const speak = seatTools(g.state, 1).find((t) => t.name === 'speak');
    const withdraw = seatTools(g.state, 1).find((t) => t.name === 'sheriff_withdraw');
    expect(speak?.description).not.toMatch(/\d+\s*字/);
    expect(speak?.params[0]).toMatchObject({ kind: 'text', name: 'content' });
    expect(speak?.params[0]).not.toHaveProperty('maxLength');
    expect(withdraw?.params[0]).not.toHaveProperty('maxLength');
    const discuss = seatTools(g.state, 1).find((t) => t.name === 'wolf_discuss');
    expect(discuss?.description).not.toMatch(/\d+\s*字/);
    expect(discuss?.params[0]).not.toHaveProperty('maxLength');

    const witch = seatTools(g.state, 6).find((t) => t.name === 'witch_act');
    expect(witch?.params.map((p) => p.name)).toEqual(['save', 'poisonTarget']);
    const before = JSON.stringify(seatTools(g.state, 6));
    g.until((x) => x.pending?.step.type === 'night:witch');
    expect(JSON.stringify(seatTools(g.state, 6))).toBe(before);
  });
});
