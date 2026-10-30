import { describe, expect, it } from 'vitest';
import { DEAL12, TestGame, lastPublic } from './harness';

// 固定发牌：1–4 狼人，5 预言家，6 女巫，7 猎人，8 守卫，9–12 平民。关闭警长以便直接进入天亮结算。
const noSheriff = { 'sheriff.enabled': false };
const game = () => new TestGame({ deal: DEAL12, values: noSheriff });

describe('第 11.3 节夜间结算表（RES-01）', () => {
  it('N1 空刀、不用毒：平安夜', () => {
    const g = game();
    g.night({ kill: null });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜平安，无人出局。');
  });

  it('N2 空刀、毒 B：B 出局', () => {
    const g = game();
    g.night({ kill: null, poison: 9 });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜出局：9号。');
  });

  it('N3 刀 A 未守未救：A 出局，A 为猎人可以开枪', () => {
    const g = game();
    g.night({ kill: 7 });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜出局：7号。');
    expect(g.hasTool('hunter_shoot')).toBe(true);
  });

  it('N4 守住刀口：平安夜', () => {
    const g = game();
    g.night({ guard: 9, kill: 9 });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜平安，无人出局。');
  });

  it('N5 救下刀口：平安夜', () => {
    const g = game();
    g.night({ kill: 9, save: true });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜平安，无人出局。');
  });

  it('N6 同守同救：刀口出局，猎人能开枪，解药被消耗（RES-02）', () => {
    const g = game();
    g.night({ guard: 7, kill: 7, save: true });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜出局：7号。');
    expect(g.hasTool('hunter_shoot')).toBe(true);
    expect(g.state.players[5].data.antidote).toBe(false);
  });

  it('N7 刀 A（猎人）毒 B：两人出局，猎人可开枪但不能选 B', () => {
    const g = game();
    g.night({ kill: 7, poison: 9 });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜出局：7号、9号。');
    const spec = g.toolsOf(7).find((t) => t.name === 'hunter_shoot');
    expect(spec).toBeDefined();
    const target = spec!.params[0];
    expect(target.kind === 'seat' && target.options.includes(9)).toBe(false);
    expect(g.act(7, 'hunter_shoot', { target: 9 })?.code).toBe('TARGET_DEAD');
  });

  it('N8 守住刀口、毒 B：只有 B 出局', () => {
    const g = game();
    g.night({ guard: 9, kill: 9, poison: 10 });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜出局：10号。');
  });

  it('N9 毒刀口（未守）：出局且死因含毒，猎人不能开枪（RES-03）', () => {
    const g = game();
    g.night({ kill: 7, poison: 7 });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜出局：7号。');
    expect(g.hasTool('hunter_shoot')).toBe(false);
    expect(g.state.deaths.find((d) => d.seat === 7)?.causes).toContain('poison');
  });

  it('N10 毒刀口（已守）：刀被守住，毒仍生效，猎人不能开枪', () => {
    const g = game();
    g.night({ guard: 7, kill: 7, poison: 7 });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜出局：7号。');
    expect(g.hasTool('hunter_shoot')).toBe(false);
    expect(g.state.deaths.find((d) => d.seat === 7)?.causes).toEqual(['poison']);
  });

  it('既救又毒在提交时拒绝，且不消耗药', () => {
    const g = game();
    g.until((x) => x.hasTool('witch_act'), (seat, tools) =>
      tools.some((t) => t.name === 'wolf_kill') ? { tool: 'wolf_kill', args: { target: 9 } } : undefined,
    );
    expect(g.act(6, 'witch_act', { save: true, poisonTarget: 10 })?.code).toBe('SAME_NIGHT_BOTH_POTIONS');
    expect(g.state.players[5].data).toMatchObject({ antidote: true, poison: true });
  });

  it('女巫默认不能自救；改为仅首夜可自救后，首夜可以救自己（SYS-02）', () => {
    const never = game();
    never.until((x) => x.hasTool('witch_act'), (_s, tools) =>
      tools.some((t) => t.name === 'wolf_kill') ? { tool: 'wolf_kill', args: { target: 6 } } : undefined,
    );
    expect(never.toolsOf(6)[0].params.some((p) => p.name === 'save')).toBe(false);
    expect(never.act(6, 'witch_act', { save: true })?.code).toBe('CANNOT_SELF_SAVE');

    const first = new TestGame({ deal: DEAL12, values: { ...noSheriff, 'witch.selfSave': 'first_night' } });
    first.night({ kill: 6, save: true });
    expect(lastPublic(first, 'dawn')?.text).toBe('昨夜平安，无人出局。');
    expect(first.view(1).ruleCard).toContain('仅第 1 夜可以自救');
    expect(never.view(1).ruleCard).toContain('不能自救');
  });
});

describe('守卫（RES-04）', () => {
  it('不能连续两晚守同一人；被拒绝的守护不更新禁守；空守后可以再守', () => {
    const g = game();
    g.night({ guard: 9, kill: null });
    g.toNight();
    // 第 2 夜
    expect(g.act(8, 'guard_protect', { target: 9 })?.code).toBe('GUARD_REPEAT');
    g.ok(8, 'guard_protect', { target: null });
    g.night({ kill: null });
    g.toNight();
    // 第 3 夜：上一夜空守，可以守 9
    expect(g.act(8, 'guard_protect', { target: 9 })).toBeUndefined();
  });

  it('可以守护自己', () => {
    const g = game();
    expect(g.act(8, 'guard_protect', { target: 8 })).toBeUndefined();
  });
});

describe('狼人落刀合并', () => {
  it('4 狼 2-2 时公开各自选择并重投一次；仍不过半则空刀', () => {
    const g = game();
    g.until((x) => x.hasTool('wolf_kill'));
    g.ok(1, 'wolf_kill', { target: 9 });
    g.ok(2, 'wolf_kill', { target: 9 });
    g.ok(3, 'wolf_kill', { target: 10 });
    g.ok(4, 'wolf_kill', { target: 10 });
    expect(g.hasTool('wolf_kill')).toBe(true);
    const split = g.events.find((e) => e.type === 'wolf.kill.split');
    expect(split?.audience).toEqual([1, 2, 3, 4]);
    g.ok(1, 'wolf_kill', { target: 9 });
    g.ok(2, 'wolf_kill', { target: 9 });
    g.ok(3, 'wolf_kill', { target: 9 });
    g.ok(4, 'wolf_kill', { target: 10 });
    g.night({});
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜出局：9号。');
  });

  it('只投一轮的规则下 2-2 直接空刀', () => {
    const g = new TestGame({ deal: DEAL12, values: { ...noSheriff, 'wolf.killRounds': 1 } });
    g.until((x) => x.hasTool('wolf_kill'));
    g.ok(1, 'wolf_kill', { target: 9 });
    g.ok(2, 'wolf_kill', { target: 9 });
    g.ok(3, 'wolf_kill', { target: 10 });
    g.ok(4, 'wolf_kill', { target: 10 });
    g.night({});
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜平安，无人出局。');
  });

  it('可以自刀', () => {
    const g = game();
    g.night({ kill: 2 });
    expect(lastPublic(g, 'dawn')?.text).toBe('昨夜出局：2号。');
  });
});
