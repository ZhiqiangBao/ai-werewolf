import { describe, expect, it } from 'vitest';
import { Ctx, abilityState, findAbility, getRole, grantAbility, registerAbility, registerRole, seatTasksComplete, seatTools } from '../src/index';
import { DEAL12, TestGame } from './harness';

registerRole({ id: 'ability_test_holder', name: '测试能力持有者', faction: 'good', category: 'villager', maxPerGame: 4,
  summary: '测试能力实例', abilityCatalog: ['mirror', 'poison', 'guard', 'wolf', 'hunter', 'none', 'test_probe', 'test_death'],
  steps: { 'test_death_duty': { run(ctx, step) { ctx.ask({ step, actors: [10], tools: () => [probeTool],
    prompt: () => '代为处理职责', title: '处理职责', publicStage: '法官结算中' }); }, decide() {} } } });
const probeDefaults = { counter: { value: 0 } };
const probeTool = { name: 'test_ability_probe', title: '测试能力', description: '记录本实例行动', params: [] };
registerAbility({ id: 'test_probe', version: 1, initialState: () => probeDefaults,
  catalog: () => [probeTool], tools: () => [probeTool],
  apply(_ctx, _seat, ability) { (ability.state.counter as { value: number }).value++; },
  fallback: () => ({ tool: 'test_ability_probe', args: {} }) });
registerAbility({ id: 'test_death', version: 1, initialState: () => ({}),
  onDeath: () => [{ type: 'test_death_duty' }] });

function game(withGuard = true) {
  const deal = [...DEAL12];
  deal[8] = 'ability_test_holder';
  deal[9] = 'ability_test_holder';
  if (!withGuard) deal[7] = 'villager';
  return new TestGame({ deal, values: { 'sheriff.enabled': false } });
}
function grant(g: TestGame, seat: number, definition: string, id: string,
  options: { active?: boolean; activeFromNight?: number; activateAfterNight?: number } = {}) {
  return grantAbility(new Ctx(g.state), seat, definition, { id, active: options.active ?? true,
    activeFromNight: options.activeFromNight ?? 1, ...(options.activateAfterNight === undefined ? {} : { activateAfterNight: options.activateAfterNight }) });
}
function instance(g: TestGame, seat: number, id: string) { return findAbility(new Ctx(g.state), seat, id); }

describe('通用能力实例的引擎调度', () => {
  it('可注册新能力；相同实例 ID 分属不同座位，初始化和行动状态不共享', () => {
    const g = game();
    grant(g, 9, 'test_probe', 'shared-id'); grant(g, 10, 'test_probe', 'shared-id');
    expect(seatTools(g.state, 9).some(t => t.name === 'test_ability_probe')).toBe(true);
    g.untilTool('test_ability_probe');
    g.ok(9, 'test_ability_probe');
    expect(instance(g, 9, 'shared-id').state.counter).toEqual({ value: 1 });
    expect(instance(g, 10, 'shared-id').state.counter).toEqual({ value: 0 });
    expect(probeDefaults.counter.value).toBe(0);
    g.ok(10, 'test_ability_probe');
    expect(instance(g, 10, 'shared-id').state.counter).toEqual({ value: 1 });
  });

  it('同席两个毒药和另一席延迟启用毒药共享定义但库存独立', () => {
    const g = game();
    grant(g, 9, 'poison', 'first'); grant(g, 9, 'poison', 'second');
    grant(g, 10, 'poison', 'later', { active: false, activeFromNight: 2, activateAfterNight: 1 });
    const catalog = seatTools(g.state, 9).map(t => t.name);
    expect(catalog).toContain('awakened_poison');
    g.untilTool('awakened_poison');
    expect(g.pending?.step).toMatchObject({ abilitySeat: 9, abilityId: 'first' });
    g.ok(9, 'awakened_poison', { targetSeat: 11 });
    expect(abilityState(instance(g, 9, 'first'), 'poison').available).toBe(false);
    expect(abilityState(instance(g, 9, 'second'), 'poison').available).toBe(true);
    expect(instance(g, 10, 'later').active).toBe(false);
    expect(g.pending?.step).toMatchObject({ abilitySeat: 9, abilityId: 'second' });
    g.ok(9, 'awakened_skip_skill');
    expect(abilityState(instance(g, 9, 'second'), 'poison').available).toBe(true);
    expect(instance(g, 10, 'later').active).toBe(true);
    expect(g.state.players[10].alive).toBe(false);
    g.toNight();
    g.untilTool('awakened_poison');
    expect(g.pending?.step).toMatchObject({ abilitySeat: 9, abilityId: 'second' });
    g.ok(9, 'awakened_poison', { targetSeat: 12 });
    expect(g.pending?.step).toMatchObject({ abilitySeat: 10, abilityId: 'later' });
    expect(abilityState(instance(g, 10, 'later'), 'poison').available).toBe(true);
    g.ok(10, 'awakened_skip_skill');
    expect(abilityState(instance(g, 10, 'later'), 'poison').available).toBe(true);
  });

  it('魔镜同席多实例和不同持有者各自限制复验，并把查验结果汇总到自身知识', () => {
    const g = game();
    grant(g, 9, 'mirror', 'm1'); grant(g, 9, 'mirror', 'm2'); grant(g, 10, 'mirror', 'm3');
    g.untilTool('mirror_inspect');
    expect(g.pending?.step).toMatchObject({ abilitySeat: 9, abilityId: 'm1' });
    g.ok(9, 'mirror_inspect', { targetSeat: 1 });
    expect(g.pending?.step).toMatchObject({ abilitySeat: 9, abilityId: 'm2' });
    g.ok(9, 'mirror_inspect', { targetSeat: 1 });
    g.ok(10, 'mirror_inspect', { targetSeat: 2 });
    expect(abilityState(instance(g, 9, 'm1'), 'mirror').checks.map(c => c.target)).toEqual([1]);
    expect(abilityState(instance(g, 9, 'm2'), 'mirror').checks.map(c => c.target)).toEqual([1]);
    expect(abilityState(instance(g, 10, 'm3'), 'mirror').checks.map(c => c.target)).toEqual([2]);
    expect(g.view(9).me?.knownIdentities?.filter(k => k.kind === 'role').map(k => k.seat)).toEqual([1, 1]);
    expect(g.view(10).me?.knownIdentities?.filter(k => k.kind === 'role').map(k => k.seat)).toEqual([2]);
    expect(g.view(9).me?.appendix).toContain('1号');
    expect(g.view(10).me?.appendix).toContain('2号');
    expect(g.view(10).events.filter(e => e.type === 'mirror.result')).toHaveLength(1);
    expect(g.spectator().events.some(e => e.type === 'mirror.result')).toBe(false);
    g.toNight(); g.untilTool('mirror_inspect');
    expect(g.act(9, 'mirror_inspect', { targetSeat: 1 })?.code).toBe('MIRROR_REPEAT');
    g.ok(9, 'mirror_inspect', { targetSeat: 2 });
    expect(g.act(9, 'mirror_inspect', { targetSeat: 1 })?.code).toBe('MIRROR_REPEAT');
    g.ok(9, 'mirror_inspect', { targetSeat: 3 });
    g.ok(10, 'mirror_inspect', { targetSeat: 1 });
  });

  it('通用持有者可以使用独立狼爪，消耗后不影响其他实例', () => {
    const g = game();
    grant(g, 9, 'wolf', 'w1'); grant(g, 10, 'wolf', 'w2');
    g.untilTool('awakened_claw');
    g.ok(9, 'awakened_claw', { targetSeat: 11 });
    expect(abilityState(instance(g, 9, 'w1'), 'wolf').claw).toBe(false);
    expect(abilityState(instance(g, 10, 'w2'), 'wolf').claw).toBe(true);
    g.ok(10, 'awakened_skip_skill');
    expect(g.state.players[10].alive).toBe(false);
  });

  it('标准守卫与复制守卫各有独立禁守对象', () => {
    const g = game();
    grant(g, 9, 'guard', 'g1');
    g.untilTool('guard_protect'); g.ok(8, 'guard_protect', { target: 12 });
    g.untilTool('awakened_guard'); g.ok(9, 'awakened_guard', { targetSeat: 12 });
    g.toNight(); g.untilTool('guard_protect');
    expect(g.act(8, 'guard_protect', { target: 12 })?.code).toBe('GUARD_REPEAT');
    g.ok(8, 'guard_protect', { target: 11 });
    g.untilTool('awakened_guard');
    expect(g.act(9, 'awakened_guard', { targetSeat: 12 })).toBeDefined();
    g.ok(9, 'awakened_guard', { targetSeat: 11 });
  });

  it('能力在学习夜结束后启用，学习夜被刀的持有者仍执行猎人职责', () => {
    const g = game();
    grant(g, 9, 'hunter', 'late-hunter', { active: false, activeFromNight: 2, activateAfterNight: 1 });
    g.night({ kill: 9, inspect: 1 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    expect(instance(g, 9, 'late-hunter').active).toBe(true);
    g.ok(9, 'hunter_shoot', { target: 11 });
    expect(g.events.some(e => e.type === 'hunter.shot' && e.payload.shooter === 9)).toBe(true);
  });

  it('被毒出局时复制猎人能力不得开枪', () => {
    const g = game();
    grant(g, 9, 'hunter', 'poisoned-hunter');
    g.night({ kill: null, poison: 9, inspect: 1 });
    expect(g.state.players[8].alive).toBe(false);
    expect(g.state.deaths.find(d => d.seat === 9)?.causes).toContain('poison');
    expect(g.hasTool('hunter_shoot')).toBe(false);
    expect(abilityState(instance(g, 9, 'poisoned-hunter'), 'hunter').spent).toBe(false);
  });

  it('能力死亡职责由其他座位办理时，仍归属于出局持有者', () => {
    const deal = [...DEAL12]; deal[8] = 'ability_test_holder'; deal[9] = 'ability_test_holder';
    const g = new TestGame({ deal, values: { 'sheriff.enabled': false, 'lastWords.firstNight': false } });
    grant(g, 9, 'test_death', 'duty');
    g.night({ kill: 9, inspect: 1 });
    expect(g.pending?.step).toMatchObject({ type: 'test_death_duty', dutySeat: 9, abilitySeat: 9, abilityId: 'duty' });
    expect(g.pending?.actors).toEqual([10]);
    expect(seatTasksComplete(g.state, 9)).toBe(false);
    const notHooked = structuredClone(g.state);
    notHooked.deaths.find(d => d.seat === 9)!.hooked = false;
    expect(seatTasksComplete(notHooked, 9)).toBe(false);
    g.ok(10, 'test_ability_probe');
    expect(seatTasksComplete(g.state, 9)).toBe(true);
  });

  it('没有原守卫时复制守护仍执行同守同救；每实例空守单独清除连守限制', () => {
    const g = game(false);
    grant(g, 9, 'guard', 'g1'); grant(g, 10, 'guard', 'g2');
    g.until(x => x.hasTool('awakened_guard'), (_seat, tools) => {
      if (tools.some(t => t.name === 'wolf_kill')) return { tool: 'wolf_kill', args: { target: 11 } };
      if (tools.some(t => t.name === 'witch_act')) return { tool: 'witch_act', args: { save: true, poisonTarget: null } };
      return undefined;
    });
    g.ok(9, 'awakened_guard', { targetSeat: 12 });
    g.ok(10, 'awakened_guard', { targetSeat: 11 });
    expect(g.state.players[10].alive).toBe(false);
    expect(g.state.deaths.find(d => d.seat === 11)?.causes).toContain('guard_and_save');
    expect(abilityState(instance(g, 9, 'g1'), 'guard').last).toBe(12);
    expect(abilityState(instance(g, 10, 'g2'), 'guard').last).toBe(11);
    g.toNight(); g.untilTool('awakened_guard');
    expect(g.act(9, 'awakened_guard', { targetSeat: 12 })).toBeDefined();
    g.ok(9, 'awakened_skip_skill');
    expect(abilityState(instance(g, 9, 'g1'), 'guard').last).toBeNull();
    expect(abilityState(instance(g, 10, 'g2'), 'guard').last).toBe(11);
    g.ok(10, 'awakened_skip_skill');
    g.toNight(); g.untilTool('awakened_guard');
    g.ok(9, 'awakened_guard', { targetSeat: 12 });
  });

  it('同一出局者持有两个猎人能力时两次死亡职责均可独立执行', () => {
    const g = game();
    grant(g, 9, 'hunter', 'h1'); grant(g, 9, 'hunter', 'h2');
    g.night({ kill: 9, inspect: 1 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    g.ok(9, 'hunter_shoot', { target: 11 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    g.ok(9, 'hunter_shoot', { target: 12 });
    expect(g.events.filter(e => e.type === 'hunter.shot' && e.payload.shooter === 9)).toHaveLength(2);
    expect(abilityState(instance(g, 9, 'h1'), 'hunter').spent).toBe(true);
    expect(abilityState(instance(g, 9, 'h2'), 'hunter').spent).toBe(true);
    expect(g.state.players[10].alive).toBe(false);
    expect(g.state.players[11].alive).toBe(false);
  });

  it.each(['good', 'wolf'] as const)('第一枪已产生 %s 胜利时取消排队的第二个复制猎枪职责', (winner) => {
    const g = game();
    grant(g, 9, 'hunter', 'h1'); grant(g, 9, 'hunter', 'h2');
    if (winner === 'good') g.removeSeats(2, 3, 4);
    else g.removeSeats(10, 12);
    g.night({ kill: 9, inspect: 1 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    g.ok(9, 'hunter_shoot', { target: winner === 'good' ? 1 : 11 });
    expect(g.state.result?.winner).toBe(winner);
    expect(g.pending).toBeNull();
    expect(g.events.filter(e => e.type === 'hunter.shot')).toHaveLength(1);
    expect(g.state.players[4].alive).toBe(true);
    expect(g.act(9, 'hunter_shoot', { target: 5 })?.code).toBe('GAME_ENDED');
  });

  it('复制猎人的持有者死亡已导致平民全灭时不生成猎枪职责', () => {
    const g = game();
    grant(g, 9, 'hunter', 'h1');
    g.removeSeats(10, 11, 12);
    g.night({ kill: 9, inspect: 1 });
    expect(g.state.result?.winner).toBe('wolf');
    expect(g.hasTool('hunter_shoot')).toBe(false);
    expect(g.events.some(e => e.type === 'hunter.shot')).toBe(false);
    expect(abilityState(instance(g, 9, 'h1'), 'hunter').spent).toBe(false);
  });
});

describe('双觉醒隐狼的原夜间阶段', () => {
  it('两个复制者在同一晚分别行动，不冲突且毒药独立', () => {
    const mod = getRole('awakened_wolf'), previous = mod.maxPerGame;
    mod.maxPerGame = 2;
    try {
      const deal = ['werewolf', 'werewolf', 'awakened_wolf', 'awakened_wolf', 'mirror_maiden', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];
      const g = new TestGame({ preset: 'mirror12', deal, values: { 'sheriff.enabled': false } });
      expect(g.hasTool('awakened_mimic')).toBe(true);
      g.ok(3, 'awakened_mimic', { targetSeat: 6 });
      g.ok(4, 'awakened_mimic', { targetSeat: 6 });
      g.night(); g.toNight();
      g.untilTool('awakened_poison');
      expect(g.waiting()).toEqual([3]);
      g.ok(3, 'awakened_poison', { targetSeat: 9 });
      expect(g.waiting()).toEqual([4]);
      expect(abilityState(instance(g, 3, 'mimic:3'), 'poison').available).toBe(false);
      expect(abilityState(instance(g, 4, 'mimic:4'), 'poison').available).toBe(true);
      g.ok(4, 'awakened_skip_skill');
    } finally { mod.maxPerGame = previous; }
  });
});
