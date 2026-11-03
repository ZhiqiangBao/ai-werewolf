import { describe, expect, it } from 'vitest';
import { buildRuleCard, buildRules } from '../src/index';
import { DEAL9, TestGame } from './harness';

// 9 人固定发牌：1–3 狼人，4 预言家，5 女巫，6 猎人，7–9 平民。
const noSheriff = { 'sheriff.enabled': false };

describe('胜负判定', () => {
  it('最后神职猎人被刀，立即判狼人胜利，不询问开枪', () => {
    const g = new TestGame({ deal: DEAL9, values: noSheriff });
    g.removeSeats(2, 3, 4, 5);
    g.night({ kill: 6 });
    expect(g.state.result?.winner).toBe('wolf');
    expect(g.hasTool('hunter_shoot')).toBe(false);
    expect(g.events.some((e) => e.type === 'hunter.shot')).toBe(false);
    expect(g.alive()).toContain(1);
  });

  it('最后神职猎人被放逐，立即判狼人胜利，不询问开枪', () => {
    const g = new TestGame({ deal: DEAL9, values: noSheriff });
    g.removeSeats(2, 3, 4, 5);
    g.night();
    g.toVote();
    g.vote({ 1: 6, 6: 1, 7: 6, 8: 6, 9: 6 });
    expect(g.state.result?.winner).toBe('wolf');
    expect(g.hasTool('hunter_shoot')).toBe(false);
    expect(g.events.some((e) => e.type === 'hunter.shot')).toBe(false);
  });

  it('胜负未分时猎人仍能开枪带走最后一名狼人，好人胜利', () => {
    const g = new TestGame({ deal: DEAL9, values: noSheriff });
    g.removeSeats(2, 3, 5);
    g.night({ kill: 6 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    g.ok(6, 'hunter_shoot', { target: 1 });
    expect(g.state.result?.winner).toBe('good');
  });

  it('镜隐局最后神职被刀时隐狼存活，普通狼不被猎枪带走', () => {
    const deal = ['werewolf', 'awakened_wolf', 'werewolf', 'mirror_maiden', 'witch', 'hunter', 'guard', 'villager', 'werewolf', 'villager', 'villager', 'villager'];
    const g = new TestGame({ preset: 'mirror12', deal, values: noSheriff });
    g.removeSeats(1, 3, 4, 5, 7, 8, 10, 12);
    g.night({ kill: 6 });
    expect(g.state.result?.winner).toBe('wolf');
    expect(g.alive()).toEqual([2, 9, 11]);
    expect(g.hasTool('hunter_shoot')).toBe(false);
    expect(g.events.some((e) => e.type === 'hunter.shot')).toBe(false);
  });

  it.each(['explicit', 'missing'] as const)('旧版死亡结算（%s）保留先开枪、后判胜负', (version) => {
    const g = new TestGame({ deal: DEAL9, values: noSheriff, deathResolutionVersion: 1 });
    if (version === 'missing') {
      delete g.state.rules.deathResolutionVersion;
      g.state = JSON.parse(JSON.stringify(g.state));
    }
    g.removeSeats(2, 3, 4, 5);
    g.night({ kill: 6 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    g.ok(6, 'hunter_shoot', { target: 1 });
    expect(g.state.result?.winner).toBe('good');
  });

  it('规则卡按死亡结算版本描述对应顺序，缺省版本沿用旧规则', () => {
    const rules = buildRules('classic9');
    expect(rules.deathResolutionVersion).toBe(2);
    expect(buildRuleCard(rules)).toContain('胜负已分立即结束');
    rules.deathResolutionVersion = 1;
    expect(buildRuleCard(rules)).toContain('先处理同批次出局技能及其引发的死亡连锁');
    delete rules.deathResolutionVersion;
    expect(buildRuleCard(rules)).toContain('先处理同批次出局技能及其引发的死亡连锁');
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
