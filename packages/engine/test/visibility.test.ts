import { describe, expect, it } from 'vitest';
import { DEAL12, DEAL9, TestGame, lastPublic } from './harness';

const noSheriff = { 'sheriff.enabled': false };
const secretTypes = /^(wolf\.|witch\.|guard\.|seer\.)/;

describe('信息隔离', () => {
  it('结构化知情记录只向本人分发，阵营查验不含具体神职', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: null, inspect: 8 });
    expect(g.view(5).me?.knownIdentities).toEqual([{ seat: 8, kind: 'alignment', alignment: 'good', source: 'inspection' }]);
    expect(g.view(1).me?.knownIdentities).toEqual([2, 3, 4].map((seat) => ({ seat, kind: 'alignment', alignment: 'wolf', source: 'teammate' })));
    expect(g.view(9).me?.knownIdentities).toEqual([]);
    expect(g.spectator().me).toBeUndefined();
    expect(JSON.stringify(g.view(5).me?.knownIdentities)).not.toMatch(/guard|守卫|witch|女巫/);
  });

  it('关闭狼人互认时不发送队友身份记录', () => {
    const g = new TestGame({ deal: DEAL12, values: { ...noSheriff, 'wolf.knowTeammates': false } });
    expect(g.view(1).me?.knownIdentities).toEqual([]);
    expect(g.view(1).me?.teammates).toBeUndefined();
  });
  it('预言家看不到刀口、女巫和守卫的行动（VIS-01）', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ guard: 10, kill: 9, inspect: 1, poison: 11 });
    const v = g.view(5);
    const leaked = v.events.filter((e) => /^(wolf\.|witch\.|guard\.)/.test(e.type));
    expect(leaked).toEqual([]);
    expect(v.events.some((e) => e.type === 'seer.result' && e.text === '查验结果：1号是狼人。')).toBe(true);
    expect(v.me?.appendix).toContain('1号=狼人');
    expect(JSON.stringify(v)).not.toContain('刀 9');
  });

  it('平民看不到查验结果和任何夜间私密事件（VIS-02）', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: 9, inspect: 1 });
    const v = g.view(10);
    expect(v.events.filter((e) => secretTypes.test(e.type))).toEqual([]);
    expect(v.me?.teammates).toBeUndefined();
  });

  it('狼人能看到队友；出局的狼人收不到之后的狼队密谈（VIS-03）', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    expect(g.view(1).me?.teammates).toEqual([2, 3, 4]);
    g.night({ kill: null });
    g.toVote();
    g.vote({ 5: 1, 6: 1, 7: 1 });
    expect(lastPublic(g, 'exile')?.text).toBe('1号被投票放逐。');
    g.toNight();
    const before = g.events.length;
    g.night({ kill: 9 });
    const night2 = g.events.slice(before).filter((e) => e.type === 'wolf.chat');
    expect(night2.length).toBeGreaterThan(0);
    expect(night2.every((e) => Array.isArray(e.audience) && !e.audience.includes(1))).toBe(true);
    const seen = g.view(1).events.filter((e) => e.type === 'wolf.chat' && e.day === 2);
    expect(seen).toEqual([]);
  });

  it('女巫只在解药未用时得知刀口（VIS-05 / VIS-11），可以毒刀口（VIS-12）', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.until((x) => x.hasTool('witch_act'), (_s, tools) =>
      tools.some((t) => t.name === 'wolf_kill') ? { tool: 'wolf_kill', args: { target: 9 } } : undefined,
    );
    expect(g.view(6).events.some((e) => e.type === 'witch.knife' && e.text.startsWith('狼人今晚选择刀 9号。'))).toBe(true);
    g.ok(6, 'witch_act', { save: true, poisonTarget: null });
    g.toNight();

    const before = g.events.length;
    g.until((x) => x.hasTool('witch_act'), (_s, tools) =>
      tools.some((t) => t.name === 'wolf_kill') ? { tool: 'wolf_kill', args: { target: 10 } } : undefined,
    );
    const v = g.view(6);
    const tonight = g.events.slice(before).filter((e) => e.audience !== 'public' && (e.audience as number[]).includes(6));
    expect(tonight.some((e) => e.type === 'witch.knife')).toBe(false);
    expect(JSON.stringify(v.task)).not.toContain('10号');
    expect(v.task?.tools[0].params.some((p) => p.name === 'save')).toBe(false);
    expect(v.task?.prompt).not.toContain('没有落刀');

    g.ok(6, 'witch_act', { poisonTarget: 10 });
    g.night({});
    const dawn = lastPublic(g, 'dawn')!;
    expect(dawn.text).toBe('昨夜出局：10号。');
    expect(dawn.text).not.toContain('毒');
    expect(g.state.deaths.find((d) => d.seat === 10)?.causes).toEqual(['wolf', 'poison']);
  });

  it('旁观者在终局前看不到未公开身份，终局后看到全部身份和复盘（VIS-08）', () => {
    const g = new TestGame({ deal: DEAL9, values: noSheriff });
    g.removeSeats(2, 3);
    g.night({ kill: 9 });
    const mid = g.spectator();
    expect(mid.me).toBeUndefined();
    expect(mid.seats.every((s) => s.revealedRole === undefined)).toBe(true);
    expect(mid.events.every((e) => e.audience === 'public')).toBe(true);
    g.toVote();
    g.vote({ 4: 1, 5: 1, 6: 1, 7: 1 });
    g.until((x) => !!x.state.result);
    expect(g.state.result?.winner).toBe('good');
    const end = g.spectator();
    expect(end.status).toBe('ended');
    expect(end.seats.every((s) => !!s.revealedRole)).toBe(true);
    expect(end.events.some((e) => e.type === 'review')).toBe(true);
  });

  it('座位投影的序号和决策编号推不出隐藏事件的数量', () => {
    const g = new TestGame({ deal: DEAL12, values: noSheriff });
    g.night({ kill: 9, inspect: 1, guard: 10 });
    g.toVote();
    const v = g.view(11);
    expect(v.events.map((e) => e.seq)).toEqual(v.events.map((_, i) => i + 1));
    expect(v.version).toBe(v.events.length);
    expect(v.task?.decisionId).not.toMatch(/^d\d+$/);
  });

  it('规则卡对所有座位一致（SYS-01）', () => {
    const g = new TestGame({ deal: DEAL12 });
    const cards = new Set(Array.from({ length: 12 }, (_, i) => g.view(i + 1).ruleCard));
    expect(cards.size).toBe(1);
    expect(g.spectator().ruleCard).toBe(g.view(1).ruleCard);
  });
});
