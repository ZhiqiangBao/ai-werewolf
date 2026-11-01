import { describe, expect, it } from 'vitest';
import { buildRules, Ctx, projectGod, replay, seatTools, submit } from '../src/index';
import { evaluateWin } from '../src/flow/win';
import { TestGame } from './harness';

const DEAL = ['werewolf', 'werewolf', 'werewolf', 'awakened_wolf', 'mirror_maiden', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];
const game = (values: Record<string, unknown> = {}, version: 1 | 2 = 1) =>
  new TestGame({ preset: 'mirror12', deal: DEAL, values: { 'sheriff.enabled': false, ...values }, toolsetVersion: version });

describe('镜隐迷踪：真实身份、查验表现和能力', () => {
  it('独立预设、夜间多阶段有确定顺序，不改旧版型', () => {
    const rules = buildRules('mirror12');
    expect(rules.roles).toEqual(DEAL);
    expect(rules.values['witch.selfSave']).toBe('never');
    expect(rules.nightOrder).toEqual(['awakened_mimic', 'guard', 'werewolf', 'awakened_knife', 'mirror_maiden', 'witch', 'awakened_skill']);
    expect(buildRules('standard12').roles.filter((r) => r === 'werewolf')).toHaveLength(4);
  });

  it('隐狼与小狼互不知晓身份，无密谈、自爆权限；阵营仍是狼', () => {
    const g = game();
    expect(g.view(4).me).toMatchObject({ role: 'awakened_wolf', faction: 'wolf' });
    expect(g.view(4).me?.teammates).toBeUndefined();
    expect(g.view(1).me?.teammates).toEqual([2, 3]);
    expect(g.view(4).events.some((e) => e.type === 'wolf.team')).toBe(false);
    expect(seatTools(g.state, 4).map((t) => t.name)).not.toContain('wolf_discuss');
    expect(seatTools(g.state, 4).map((t) => t.name)).not.toContain('wolf_explode');
    g.removeSeats(1, 2, 3);
    expect(evaluateWin(new Ctx(g.state))).toBeNull();
    g.removeSeats(4);
    expect(evaluateWin(new Ctx(g.state))?.winner).toBe('good');
  });

  it('普通阵营查验不因隐狼学习而变成狼；具体身份和阵营结果不混用', () => {
    const g = new TestGame({ preset: 'mirror12', deal: DEAL.map((r) => r === 'mirror_maiden' ? 'seer' : r), values: { 'sheriff.enabled': false } });
    g.ok(4, 'awakened_mimic', { targetSeat: 9 });
    g.untilTool('seer_inspect'); g.ok(5, 'seer_inspect', { target: 4 });
    expect(g.view(5).me?.knownIdentities).toContainEqual({ seat: 4, kind: 'alignment', alignment: 'good', source: 'inspection' });
    expect(g.view(4).me?.faction).toBe('wolf');
    expect(g.view(5).events.find((e) => e.type === 'seer.result')?.payload).not.toHaveProperty('role');
  });

  it('未模仿时可查到隐狼；结果只给查验者，禁止自验和复验', () => {
    const g = game();
    g.ok(4, 'awakened_wait');
    g.untilTool('mirror_inspect');
    expect(g.act(5, 'mirror_inspect', { targetSeat: 5 })?.code).toBe('TARGET_SELF_FORBIDDEN');
    g.ok(5, 'mirror_inspect', { targetSeat: 4 });
    expect(g.view(5).me?.knownIdentities).toContainEqual({ seat: 4, kind: 'role', role: 'awakened_wolf', roleName: '觉醒隐狼', source: 'inspection' });
    expect(g.view(9).events.some((e) => e.type === 'mirror.result')).toBe(false);
    expect(g.spectator().events.some((e) => e.type === 'mirror.result')).toBe(false);
    g.night(); g.toNight(); g.ok(4, 'awakened_wait');
    g.untilTool('mirror_inspect');
    expect(g.act(5, 'mirror_inspect', { targetSeat: 4 })?.code).toBe('MIRROR_REPEAT');
  });

  for (const [target, role] of [[1, 'werewolf'], [5, 'mirror_maiden'], [6, 'witch'], [7, 'hunter'], [8, 'guard'], [9, 'villager']] as const) {
    it(`模仿 ${role} 立即改变查验表现，保持真实底牌、阵营和固定工具目录`, () => {
      const g = game();
      const tools = structuredClone(seatTools(g.state, 4));
      expect(g.state.day).toBe(1);
      expect(g.view(4).task?.tools.map((t) => t.name)).toEqual(['awakened_mimic', 'awakened_wait']);
      g.ok(4, 'awakened_mimic', { targetSeat: target });
      expect(g.state.players[3].role).toBe('awakened_wolf');
      expect(g.state.players[3].data.awakened.learned).toMatchObject({ role, active: false, activeFromNight: 2 });
      expect(g.view(4).events.find((e) => e.type === 'awakened.mimic')).toMatchObject({ audience: [4], payload: { target, role, activeFromNight: 2 } });
      expect(g.view(target).events.some((e) => e.type === 'awakened.mimic')).toBe(false);
      expect(g.spectator().events.some((e) => e.type === 'awakened.mimic')).toBe(false);
      g.untilTool('mirror_inspect'); g.ok(5, 'mirror_inspect', { targetSeat: 4 });
      expect(g.view(5).me?.knownIdentities?.at(-1)).toMatchObject({ role });
      expect(projectGod(g.state, g.events).god.roles[3].role).toBe('awakened_wolf');
      expect(g.view(4).me?.faction).toBe('wolf');
      expect(seatTools(g.state, 4)).toEqual(tools);
      g.night();
      expect(g.state.players[3].data.awakened.learned.active).toBe(true);
      expect(g.view(4).events.find((e) => e.type === 'awakened.activated')).toMatchObject({ audience: [4], payload: { activeFromNight: 2 } });
      expect(g.view(target).events.some((e) => e.type === 'awakened.activated')).toBe(false);
      expect(g.spectator().events.some((e) => e.type === 'awakened.activated')).toBe(false);
      g.toNight();
      expect(g.pending?.step.type).not.toBe('night:awakened_mimic');
      expect(seatTools(g.state, 4)).toEqual(tools);
    });
  }

  it('可以延后模仿，不能自学、学死人或重复学习；学习夜不能主动用技能', () => {
    const g = game();
    expect(g.act(4, 'awakened_mimic', { targetSeat: 4 })).toBeDefined();
    g.removeSeats(12);
    expect(g.act(4, 'awakened_mimic', { targetSeat: 12 })).toBeDefined();
    g.ok(4, 'awakened_wait'); g.night(); g.toNight();
    g.ok(4, 'awakened_mimic', { targetSeat: 6 });
    expect(g.state.players[3].data.awakened.learned.activeFromNight).toBe(3);
    expect(g.act(4, 'awakened_poison', { targetSeat: 9 })).toBeDefined();
    g.night(); g.toNight();
    expect(g.act(4, 'awakened_mimic', { targetSeat: 7 })).toBeDefined();
  });

  it('魔镜的旧查验记录是当时的结果，不随隐狼后来模仿而改写', () => {
    const g = game(); g.ok(4, 'awakened_wait');
    g.untilTool('mirror_inspect'); g.ok(5, 'mirror_inspect', { targetSeat: 4 });
    const before = structuredClone(g.view(5).me?.knownIdentities);
    g.night(); g.toNight(); g.ok(4, 'awakened_mimic', { targetSeat: 9 });
    expect(g.view(5).me?.knownIdentities).toEqual(before);
  });

  it('模仿女巫只获得独立的一瓶毒药；源女巫已用药也不影响资源', () => {
    const g = game(); g.ok(4, 'awakened_mimic', { targetSeat: 6 });
    g.night({ poison: 9 });
    expect(g.state.players[3].data.awakened.learned.skill).toEqual({ kind: 'poison', available: true });
    g.toNight(); g.until((x) => x.pending?.step.type === 'night:awakened_skill');
    expect(g.toolsOf(4).map((t) => t.name)).toEqual(['awakened_poison', 'awakened_skip_skill']);
    expect(g.act(4, 'awakened_poison', { targetSeat: 4 })).toBeDefined();
    g.ok(4, 'awakened_poison', { targetSeat: 10 });
    expect(g.state.players[9].alive).toBe(false);
    expect(g.state.players[3].data.awakened.learned.skill.available).toBe(false);
    g.toNight(); g.night();
    expect(g.state.players[3].data.awakened.learned.skill.available).toBe(false);
    expect(g.events.filter((e) => e.type === 'awakened.skill' && e.payload.tool === 'awakened_poison')).toHaveLength(1);
  });

  it('复制魔镜从下一夜独立查验；不能重复，也不会读取源魔镜的历史', () => {
    const g = game(); g.ok(4, 'awakened_mimic', { targetSeat: 5 });
    g.untilTool('mirror_inspect'); g.ok(5, 'mirror_inspect', { targetSeat: 9 }); g.night(); g.toNight();
    g.until((x) => x.pending?.step.type === 'night:awakened_skill');
    g.ok(4, 'mirror_inspect', { targetSeat: 9 });
    expect(g.view(4).me?.knownIdentities).toContainEqual({ seat: 9, kind: 'role', role: 'villager', roleName: '平民', source: 'inspection' });
    g.toNight(); g.until((x) => x.pending?.step.type === 'night:awakened_skill');
    expect(g.act(4, 'mirror_inspect', { targetSeat: 9 })).toBeDefined();
  });
});

describe('镜隐迷踪：夜间结算、刀权和死亡职责', () => {
  it('增强守护同时挡狼刀和毒药，连守被拒绝，空守后可再守', () => {
    const g = game(); g.ok(4, 'awakened_mimic', { targetSeat: 8 }); g.night(); g.toNight();
    g.untilTool('wolf_kill');
    for (const s of g.waiting()) g.ok(s, 'wolf_kill', { target: 9 });
    g.untilTool('witch_act'); g.ok(6, 'witch_act', { save: false, poisonTarget: 9 });
    g.until((x) => x.pending?.step.type === 'night:awakened_skill'); g.ok(4, 'awakened_guard', { targetSeat: 9 });
    expect(g.state.players[8].alive).toBe(true);
    g.toNight(); g.until((x) => x.pending?.step.type === 'night:awakened_skill');
    expect(g.act(4, 'awakened_guard', { targetSeat: 9 })).toBeDefined();
    g.ok(4, 'awakened_skip_skill'); g.toNight(); g.until((x) => x.pending?.step.type === 'night:awakened_skill');
    expect(g.toolsOf(4)[0].params[0]).toMatchObject({ options: expect.arrayContaining([9]) });
  });

  it('增强守护与解药同用仍奶穿狼刀；普通守卫不挡复制毒药', () => {
    const g = game(); g.ok(4, 'awakened_mimic', { targetSeat: 8 }); g.night(); g.toNight();
    g.untilTool('wolf_kill'); for (const s of g.waiting()) g.ok(s, 'wolf_kill', { target: 9 });
    g.untilTool('witch_act'); g.ok(6, 'witch_act', { save: true, poisonTarget: null });
    g.until((x) => x.pending?.step.type === 'night:awakened_skill'); g.ok(4, 'awakened_guard', { targetSeat: 9 });
    expect(g.state.deaths.find((d) => d.seat === 9)?.causes).toEqual(['guard_and_save']);
    const p = game(); p.ok(4, 'awakened_mimic', { targetSeat: 6 }); p.night(); p.toNight();
    p.ok(8, 'guard_protect', { target: 9 });
    p.until((x) => x.pending?.step.type === 'night:awakened_skill'); p.ok(4, 'awakened_poison', { targetSeat: 9 });
    expect(p.state.deaths.find((d) => d.seat === 9)?.causes).toEqual(['poison']);
  });

  it('其余狼在白天全灭后，下一夜继承刀权，不生成狼队资料', () => {
    const g = game(); g.ok(4, 'awakened_mimic', { targetSeat: 9 }); g.night();
    g.removeSeats(1, 2, 3); g.toNight();
    expect(g.pending?.step.type).toBe('night:guard');
    expect(g.view(4).events.find((e) => e.type === 'awakened.inherit')).toMatchObject({ phase: 'night', day: 2, audience: [4], payload: { night: 2 } });
    expect(g.view(9).events.some((e) => e.type === 'awakened.inherit')).toBe(false);
    expect(g.spectator().events.some((e) => e.type === 'awakened.inherit')).toBe(false);
    g.untilTool('awakened_kill');
    expect(g.pending?.step.type).toBe('night:awakened_knife');
    expect(g.view(4).task?.tools.map((t) => t.name)).toEqual(['awakened_kill', 'awakened_empty_kill']);
    g.ok(4, 'awakened_kill', { targetSeat: 10 }); g.night();
    expect(g.state.players[9].alive).toBe(false);
    expect(g.view(4).me?.teammates).toBeUndefined();
    expect(g.view(4).events.some((e) => e.type === 'wolf.team' || e.type === 'wolf.chat')).toBe(false);
    expect(g.state.players[3].role).toBe('awakened_wolf');
  });

  it('最后小狼夜间死亡，不在同一夜补刀；第二夜才继承', () => {
    const g = game(); g.ok(4, 'awakened_wait'); g.removeSeats(1, 2);
    g.night({ poison: 3 });
    expect(g.events.some((e) => e.type === 'awakened.inherit')).toBe(false);
    g.toNight();
    expect(g.events.filter((e) => e.type === 'awakened.inherit')).toHaveLength(1);
    expect(g.state.players[3].data.awakened.knifeFromNight).toBe(2);
  });

  it('复制狼人的额外刀需刀权和启用条件，只能消耗一次，可被守护挡住', () => {
    const g = game(); g.ok(4, 'awakened_mimic', { targetSeat: 1 }); g.night(); g.toNight();
    g.night(); expect(g.events.some((e) => e.payload.tool === 'awakened_claw')).toBe(false);
    g.removeSeats(1, 2, 3); g.toNight();
    g.ok(8, 'guard_protect', { target: 9 }); g.untilTool('awakened_kill'); g.ok(4, 'awakened_kill', { targetSeat: 10 });
    g.until((x) => x.pending?.step.type === 'night:awakened_skill'); g.ok(4, 'awakened_claw', { targetSeat: 9 });
    expect(g.state.players[8].alive).toBe(true);
    expect(g.state.players[9].alive).toBe(false);
    expect(g.state.players[3].data.awakened.learned.skill.claw).toBe(false);
    g.toNight(); g.night();
    expect(g.events.filter((e) => e.payload.tool === 'awakened_claw')).toHaveLength(1);
  });

  it('学习猎人的当夜结束才获得枪；首夜中刀可开枪且只公开猎人表现', () => {
    const g = game(); g.ok(4, 'awakened_mimic', { targetSeat: 7 }); g.night({ kill: 4 });
    expect(g.pending?.step.type).toBe('hunter.shoot');
    expect(g.pending?.actors).toEqual([4]);
    g.ok(4, 'hunter_shoot', { target: 9 });
    expect(g.spectator().seats[3].revealedRole).toBe('hunter');
    expect(g.view(4).me?.role).toBe('awakened_wolf');
    expect(projectGod(g.state, g.events).god.roles[3].role).toBe('awakened_wolf');
    expect(g.state.players[8].alive).toBe(false);
    expect(g.publicTexts().some((t) => t.includes('觉醒隐狼') && !t.includes('游戏开始'))).toBe(false);
  });

  it('复制猎人被毒不能开枪，放弃枪不翻身份；源猎人枪权独立', () => {
    const poisoned = game(); poisoned.ok(4, 'awakened_mimic', { targetSeat: 7 }); poisoned.night({ poison: 4 });
    expect(poisoned.pending?.step.type).not.toBe('hunter.shoot');
    const g = game(); g.ok(4, 'awakened_mimic', { targetSeat: 7 }); g.night({ kill: 4 });
    g.ok(4, 'hunter_shoot', { target: null });
    expect(g.spectator().seats[3].revealedRole).toBeUndefined();
    g.toNight(); g.night({ kill: 7 });
    expect(g.pending?.step.type).toBe('hunter.shoot');
    expect(g.pending?.actors).toEqual([7]);
  });

  it('显式工具拒绝额外参数、错误类型和过期窗口；重放保留全部事实', () => {
    const g = game({}, 2);
    expect(g.act(4, 'awakened_mimic', { targetSeat: '6' })).toBeDefined();
    expect(g.act(4, 'awakened_mimic', { targetSeat: 6, extra: true })).toBeDefined();
    const old = g.pending!.id;
    g.ok(4, 'awakened_mimic', { targetSeat: 6 });
    expect(submit(g.state, { seat: 4, decisionId: old, call: { tool: 'awakened_wait', args: {} } }).error?.code).toBe('STALE_DECISION');
    g.until((x) => x.state.phase !== 'night');
    const again = replay(g.options, g.actions);
    expect(again.events).toEqual(g.events);
    expect(again.state).toEqual(g.state);
  });
});
