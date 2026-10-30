import { describe, expect, it } from 'vitest';
import { DEAL9, TestGame } from './harness';

// 9 人固定发牌：1–3 狼人，4 预言家，5 女巫，6 猎人，7–9 平民。
const noSheriff = { 'sheriff.enabled': false };

describe('胜负判定', () => {
  it('最后一名猎人开枪带走最后一名狼人：好人胜利（RES-05 / RES-08）', () => {
    const g = new TestGame({ deal: DEAL9, values: noSheriff });
    g.removeSeats(2, 3, 4, 5);
    g.night({ kill: 6 });
    g.ok(6, 'hunter_shoot', { target: 1 });
    g.until((x) => !!x.state.result);
    expect(g.state.result?.winner).toBe('good');
  });

  it('最后一名猎人开枪带走平民：神职全灭，狼人胜利（RES-06）', () => {
    const g = new TestGame({ deal: DEAL9, values: noSheriff });
    g.removeSeats(2, 3, 4, 5);
    g.night({ kill: 6 });
    g.ok(6, 'hunter_shoot', { target: 7 });
    g.until((x) => !!x.state.result);
    expect(g.state.result?.winner).toBe('wolf');
  });

  it('平民全部出局：屠边狼人胜利，胜负已分后不再发表遗言', () => {
    const g = new TestGame({ deal: DEAL9, values: noSheriff });
    g.removeSeats(7, 8);
    g.night({ kill: 9 });
    expect(g.state.result?.winner).toBe('wolf');
    expect(g.publicTexts()).toContain('胜负已分。');
    expect(g.events.some((e) => e.type === 'speech' && e.payload.kind === 'lastwords')).toBe(false);
  });

  it('屠城规则下平民全灭游戏继续', () => {
    const g = new TestGame({ deal: DEAL9, values: { ...noSheriff, winCondition: 'city' } });
    g.removeSeats(7, 8);
    g.night({ kill: 9 });
    g.auto(9);
    expect(g.state.result).toBeNull();
  });

  it('达到天数上限流局', () => {
    const g = new TestGame({ deal: DEAL9, values: { ...noSheriff, 'limits.maxDays': 2 } });
    g.until((x) => !!x.state.result, (_s, tools) =>
      tools.some((t) => t.name === 'wolf_kill') ? { tool: 'wolf_kill', args: { target: null } } : undefined,
    );
    expect(g.state.result?.winner).toBe('draw');
    expect(g.state.day).toBe(2);
  });
});
