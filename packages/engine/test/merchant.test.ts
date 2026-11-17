import { describe, expect, it } from 'vitest';
import type { Seat } from '@werewolf/protocol';
import { buildRules, engineCatalog, projectGod, replay, roleData, seatTools, submit } from '../src/index';
import { lastPublic, TestGame } from './harness';

const deal = [
  'miracle_merchant', 'seer', 'villager', 'witch', 'guard', 'wolf_king',
  'villager', 'villager', 'villager', 'werewolf', 'werewolf', 'werewolf',
];

function merchantGame(values: Record<string, unknown> = {}, roles = deal) {
  return new TestGame({ preset: 'merchant12', toolsetVersion: 2, electionVersion: 4, deal: roles, values });
}

function targets(game: TestGame, seat: Seat, tool: string): Seat[] {
  const param = game.toolsOf(seat).find((spec) => spec.name === tool)?.params[0];
  if (param?.kind !== 'seat') throw new Error(`${seat}号没有可用的 ${tool} 目标`);
  return param.options;
}

interface NightActions {
  guard?: Seat;
  knife?: Seat;
  poison?: Seat;
  save?: boolean;
}

function chooseNight(plan: NightActions) {
  return (_seat: Seat, tools: ReturnType<TestGame['toolsOf']>) => {
    const has = (name: string) => tools.some((tool) => tool.name === name);
    if (plan.guard !== undefined && has('guard_protect')) return { tool: 'guard_protect', args: { targetSeat: plan.guard } };
    if (plan.knife !== undefined && has('wolf_kill')) return { tool: 'wolf_kill', args: { targetSeat: plan.knife } };
    if (plan.poison !== undefined && has('witch_poison')) return { tool: 'witch_poison', args: { targetSeat: plan.poison } };
    if (plan.save && has('witch_save')) return { tool: 'witch_save', args: {} };
  };
}

function finishNight(game: TestGame, plan: NightActions = {}) {
  game.until((g) => g.state.phase !== 'night', chooseNight(plan));
}

const noSheriff = { 'sheriff.enabled': false };

describe('十二人奇迹商人', () => {
  it('注册标准阵容、版本和本职夜序', () => {
    const preset = engineCatalog().presets.find((item) => item.id === 'merchant12');
    expect(preset).toMatchObject({ playerCount: 12, version: 1, tag: '进阶' });
    const rules = buildRules('merchant12');
    expect([...rules.roles].sort()).toEqual([...deal].sort());
    expect(rules.nightOrder).toEqual(['miracle_merchant', 'guard', 'werewolf', 'seer', 'witch']);
    expect(rules).toMatchObject({
      toolsetVersion: 2, electionVersion: 4, inspectionVersion: 2, deathResolutionVersion: 2, hunterShotVersion: 2,
      values: { winCondition: 'side', 'sheriff.enabled': true, 'sheriff.timing': 'before_announcement', 'witch.selfSave': 'never',
        'witch.bothPotionsSameNight': false, 'resolve.guardAndSaveKills': true },
    });
  });

  it('等待保留交易，平民留存到后夜，用尽后持续保有原有阵营和固定工具', () => {
    const game = merchantGame(noSheriff);
    const catalog = seatTools(game.state, 3);
    expect(catalog.filter((tool) => tool.name.startsWith('lucky_')).map((tool) => tool.name))
      .toEqual(['lucky_inspect', 'lucky_skip', 'lucky_poison', 'lucky_guard']);
    expect(game.act(1, 'merchant_wait', { targetSeat: 3 })?.code).toBe('INVALID_ARGUMENT');
    game.ok(1, 'merchant_wait');
    expect(roleData(game.state.players[0], 'miracle_merchant').gift).toBeNull();
    game.toNight();
    const decisionId = game.pending!.id;
    game.ok(1, 'merchant_gift_inspect', { targetSeat: 3 });
    expect(submit(game.state, { seat: 1, decisionId, call: { tool: 'merchant_gift_inspect', args: { targetSeat: 3 } } }).error?.code)
      .toBe('STALE_DECISION');
    game.untilTool('lucky_inspect');
    expect(game.state.day).toBe(2);
    expect(seatTools(game.state, 3)).toEqual(catalog);
    expect(game.view(3).task?.tools.map((tool) => tool.name)).toEqual(['lucky_inspect', 'lucky_skip']);
    game.ok(3, 'lucky_skip');
    game.untilTool('lucky_inspect');
    expect(game.state.day).toBe(3);
    game.ok(3, 'lucky_inspect', { targetSeat: 6 });
    expect(game.view(3).me).toMatchObject({ role: 'villager', faction: 'good',
      knownIdentities: [{ seat: 6, kind: 'alignment', alignment: 'wolf', source: 'inspection' }] });
    expect(game.state.players[2].abilities).toEqual([expect.objectContaining({
      definition: 'lucky_seer', state: { used: { night: 3, target: 6, result: 'wolf' } },
    })]);
    expect(seatTools(game.state, 3)).toEqual(catalog);
    game.toNight();
    finishNight(game);
    expect(game.events.filter((event) => event.type === 'merchant.gift')).toHaveLength(1);
    expect(game.events.filter((event) => event.type === 'judge' && event.payload.step === 'ability.act')).toHaveLength(2);
  });

  it('幸运儿在确认出局前可行动，留存的技能此后不再询问', () => {
    const game = merchantGame(noSheriff);
    game.ok(1, 'merchant_gift_poison', { targetSeat: 3 });
    game.until((g) => g.hasTool('lucky_poison'), chooseNight({ knife: 3 }));
    expect(game.alive()).toContain(3);
    game.ok(3, 'lucky_skip');
    expect(game.state.deaths.find((death) => death.seat === 3)?.causes).toEqual(['wolf']);
    game.toNight();
    finishNight(game);
    expect(game.events.filter((event) => event.type === 'judge' && event.payload.step === 'ability.act')).toHaveLength(1);
  });

  it('先警选后报死，刀死与反噬的商人回执和公开事件一致', () => {
    const backfireDeal = [...deal];
    [backfireDeal[2], backfireDeal[9]] = [backfireDeal[9], backfireDeal[2]];
    const knife = merchantGame();
    const backfire = merchantGame({}, backfireDeal);
    for (const game of [knife, backfire]) {
      game.ok(1, 'merchant_gift_inspect', { targetSeat: 3 });
      finishNight(game, game === knife ? { knife: 1 } : {});
      expect(game.pending?.step.type).toBe('sheriff.signup');
      expect(game.alive()).toContain(1);
      expect(lastPublic(game, 'dawn')).toBeUndefined();
      for (const seat of game.waiting()) game.ok(seat, [8, 9].includes(seat) ? 'sheriff_signup' : 'sheriff_stay_off');
      game.untilTool('sheriff_vote');
      expect(game.waiting()).toContain(1);
      game.ok(1, 'sheriff_vote', { candidateSeat: 8 });
      game.until((g) => !!lastPublic(g, 'dawn'));
      expect(game.alive()).not.toContain(1);
      expect(game.view(1).task?.tools.map((tool) => tool.name)).toEqual(['speak']);
    }
    const receipt = (game: TestGame) => game.view(1).events.find((event) => event.type === 'merchant.gift');
    expect(receipt(knife)).toEqual(receipt(backfire));
    expect(receipt(knife)).toMatchObject({ audience: [1], payload: { target: 3, skill: 'seer' } });
    // 决策编号由私有议程生成，公开内容不承载夜间死因。
    const publicFacts = (game: TestGame) => game.spectator().events.map(({ payload: { decisionId: _decision, ...payload }, ...event }) => ({ ...event, payload }));
    expect(publicFacts(knife)).toEqual(publicFacts(backfire));
    expect(lastPublic(knife, 'dawn')?.payload).toEqual(lastPublic(backfire, 'dawn')?.payload);
    const gift = knife.view(3).events.find((event) => event.type === 'merchant.gift.received');
    expect(gift).toMatchObject({ audience: [3], payload: { skill: 'seer', activeFromNight: 1 } });
    expect(gift?.text).not.toContain('1号');
    expect(gift).not.toHaveProperty('round');
    expect(backfire.view(3).events.some((event) => event.type === 'merchant.gift.received')).toBe(false);
    expect(backfire.state.players[2].abilities).toBeUndefined();
    expect(projectGod(knife.state, knife.events).events.find((event) => event.type === 'night.resolution')?.payload.deaths)
      .toEqual([{ seat: 1, causes: ['wolf'] }]);
    expect(projectGod(backfire.state, backfire.events).events.find((event) => event.type === 'night.resolution')?.payload.deaths)
      .toEqual([{ seat: 1, causes: ['merchant_backfire'] }]);
  });

  it.each([{ target: 6, guard: 1 }, { target: 10, save: true }])('赠给狼人 $target 后，守护或解药只处理狼刀', ({ target, ...protection }) => {
    const game = merchantGame(noSheriff);
    game.ok(1, 'merchant_gift_guard', { targetSeat: target });
    finishNight(game, { knife: 1, ...protection });
    expect(game.state.deaths.map(({ seat, causes }) => ({ seat, causes }))).toEqual([{ seat: 1, causes: ['merchant_backfire'] }]);
    expect(game.state.players[target - 1].abilities).toBeUndefined();
    expect(game.view(target).events.some((event) => event.type.startsWith('merchant.gift'))).toBe(false);
    expect(game.events.find((event) => event.type === 'night.resolution')?.payload.rows).toContainEqual(expect.objectContaining({
      target: 1, kind: 'wolf', blocked: true, blockers: [protection.save ? 'antidote' : 'guard'],
    }));
    expect(roleData(game.state.players[3], 'witch').antidote).toBe(!protection.save);
  });

  it.each([3, null])('获赐查验仅排除同夜实际验过的目标（本职 %s）', (first) => {
    const game = merchantGame();
    game.ok(1, 'merchant_gift_inspect', { targetSeat: 2 });
    game.untilTool('seer_inspect');
    if (first === null) game.ok(2, 'seer_skip');
    else game.ok(2, 'seer_inspect', { targetSeat: first });
    game.untilTool('lucky_inspect');
    const legal = targets(game, 2, 'lucky_inspect');
    expect(legal).not.toContain(2);
    expect(legal.includes(3)).toBe(first === null);
    if (first !== null) expect(game.act(2, 'lucky_inspect', { targetSeat: first })?.code).toBe('INVALID_ARGUMENT');
    game.ok(2, 'lucky_inspect', { targetSeat: first === null ? 3 : 6 });
    expect(roleData(game.state.players[1], 'seer').checks).toHaveLength(first === null ? 0 : 1);
    expect(game.view(2).me?.knownIdentities).toHaveLength(first === null ? 1 : 2);
    expect(game.view(3).events.some((event) => event.type === 'lucky.inspect')).toBe(false);
    expect(game.view(2).events.find((event) => event.type === 'lucky.inspect')?.round).toEqual({
      roundKind: 'lucky', roundId: 'night-1-lucky-2', actionKind: 'skill', actorSeatId: 2, targetSeatId: first === null ? 3 : 6,
    });
  });

  it.each(['poison', 'save', 'skip'])('女巫本职 %s 与获赐毒药独立结算', (native) => {
    const game = merchantGame(noSheriff);
    game.ok(1, 'merchant_gift_poison', { targetSeat: 4 });
    game.until((g) => g.state.night?.knife !== undefined && g.waiting().includes(4), chooseNight({ knife: 3 }));
    game.ok(4, `witch_${native}`, native === 'poison' ? { targetSeat: 3 } : {});
    expect(targets(game, 4, 'lucky_poison').includes(3)).toBe(native !== 'poison');
    if (native === 'poison') expect(game.act(4, 'lucky_poison', { targetSeat: 3 })?.code).toBe('INVALID_ARGUMENT');
    game.ok(4, 'lucky_poison', { targetSeat: 7 });
    expect(roleData(game.state.players[3], 'witch')).toEqual({ antidote: native !== 'save', poison: native !== 'poison' });
    expect(game.state.deaths.find((death) => death.seat === 7)?.causes).toEqual(['poison']);
    expect(game.state.deaths.some((death) => death.seat === 3)).toBe(native !== 'save');
  });

  it.each([3, null])('守卫的跨夜禁守只含两种技能实际守过的座位（本职 %s）', (native) => {
    const game = merchantGame(noSheriff);
    game.ok(1, 'merchant_gift_guard', { targetSeat: 5 });
    if (native === null) game.ok(5, 'guard_skip');
    else game.ok(5, 'guard_protect', { targetSeat: native });
    game.untilTool('lucky_guard');
    expect(targets(game, 5, 'lucky_guard').includes(3)).toBe(native === null);
    if (native !== null) expect(game.act(5, 'lucky_guard', { targetSeat: native })?.code).toBe('INVALID_ARGUMENT');
    game.ok(5, 'lucky_guard', { targetSeat: 7 });
    game.toNight();
    const legal = targets(game, 5, 'guard_protect');
    expect(game.state.day).toBe(2);
    expect(legal.includes(3)).toBe(native === null);
    expect(legal).not.toContain(7);
    expect(game.act(5, 'guard_protect', { targetSeat: 7 })?.code).toBe('INVALID_ARGUMENT');
    game.ok(5, 'guard_skip');
    game.toNight();
    expect(targets(game, 5, 'guard_protect')).toEqual(game.alive());
  });

  it.each([{ guard: 3, save: false }, { guard: 3, save: true }, { guard: undefined, save: true }])
  ('不同席可同守，幸运儿的盾参与守救结算（守卫 $guard，解药 $save）', ({ guard, save }) => {
    const game = merchantGame(noSheriff);
    game.ok(1, 'merchant_gift_guard', { targetSeat: 7 });
    game.until((g) => g.hasTool('lucky_guard'), chooseNight({ guard, knife: 3, save }));
    expect(targets(game, 7, 'lucky_guard')).toEqual(game.alive());
    expect(game.view(7).events.some((event) => event.type === 'guard.protect')).toBe(false);
    game.ok(7, 'lucky_guard', { targetSeat: 3 });
    expect(game.state.deaths.find((death) => death.seat === 3)?.causes).toEqual(save ? ['guard_and_save'] : undefined);
    expect(game.view(5).events.some((event) => event.type === 'lucky.guard')).toBe(false);
  });
});

describe('狼王', () => {
  it('复用狼队私有密谈与合刀，独狼时可直接落刀或空刀', () => {
    const game = merchantGame(noSheriff);
    game.until((g) => g.pending?.step.type === 'wolf.discuss' && g.waiting()[0] === 6);
    game.ok(6, 'wolf_discuss', { content: '看3号' });
    const chat = game.events.find((event) => event.type === 'wolf.chat');
    expect(chat?.audience).toEqual([6, 10, 11, 12]);
    expect(game.view(6).me?.teammates).toEqual([10, 11, 12]);
    game.untilTool('wolf_kill');
    game.ok(6, 'wolf_kill', { targetSeat: 3 });
    expect(game.view(10).events.some((event) => event.type === 'wolf.kill.result')).toBe(false);
    for (const seat of game.waiting()) game.ok(seat, 'wolf_empty_kill');
    expect(game.state.night?.knife).toBe(3);
    expect(game.events.find((event) => event.type === 'wolf.kill.result')).toMatchObject({
      audience: [6, 10, 11, 12], payload: { picks: [[6, 3], [10, null], [11, null], [12, null]], knife: 3 },
    });
    const solo = merchantGame(noSheriff, ['wolf_king', 'miracle_merchant', 'villager', 'villager']);
    solo.untilTool('wolf_kill');
    expect(solo.waiting()).toEqual([1]);
    expect(solo.events.some((event) => event.type === 'wolf.chat')).toBe(false);
    solo.ok(1, 'wolf_empty_kill');
    expect(solo.events.find((event) => event.type === 'wolf.kill.result')?.payload.knife).toBeNull();
    solo.toNight();
    solo.untilTool('wolf_kill');
    solo.ok(1, 'wolf_kill', { targetSeat: 3 });
    expect(solo.state.deaths.find((death) => death.seat === 3)?.causes).toEqual(['wolf']);
  });

  it('警长报名不开放自爆，竞选发言可自爆亮狼王牌并先公告夜间出局', () => {
    const game = merchantGame();
    game.ok(1, 'merchant_gift_inspect', { targetSeat: 10 });
    finishNight(game);
    expect(game.view(6).interrupts).toEqual([]);
    expect(game.act(6, 'wolf_explode')?.code).toBe('TOOL_NOT_LEGAL');
    for (const seat of game.waiting()) game.ok(seat, [8, 9].includes(seat) ? 'sheriff_signup' : 'sheriff_stay_off');
    game.until((g) => !!g.pending?.speechWindow);
    expect(game.view(6).interrupts.map((tool) => tool.name)).toContain('wolf_explode');
    game.ok(6, 'wolf_explode');
    expect(lastPublic(game, 'explode')?.payload).toMatchObject({ seat: 6, role: 'wolf_king' });
    expect(game.spectator().seats[5]).toMatchObject({ alive: false, revealedRole: 'wolf_king' });
    expect(game.view(3).seats[5].revealedRole).toBe('wolf_king');
    expect(lastPublic(game, 'dawn')).toBeDefined();
    expect(game.state.election.postponed).toBe(true);
    expect(game.events.some((event) => event.type === 'judge' && event.payload.step === 'wolf_king.shoot')).toBe(false);
  });

  it.each([
    { guardAndSave: false, declineReveals: false },
    { guardAndSave: true, declineReveals: false },
    { guardAndSave: false, declineReveals: true },
  ])('狼刀或守救可询问开枪，放弃按本局选项处理（$guardAndSave, $declineReveals）', ({ guardAndSave, declineReveals }) => {
    const game = merchantGame({ ...noSheriff, 'hunter.declineReveals': declineReveals });
    finishNight(game, { knife: 6, ...(guardAndSave ? { guard: 6, save: true } : {}) });
    expect(game.state.deaths.find((death) => death.seat === 6)?.causes).toEqual([guardAndSave ? 'guard_and_save' : 'wolf']);
    expect(game.view(6).task?.tools.map((tool) => tool.name)).toEqual(['wolf_king_shoot', 'wolf_king_hold_fire']);
    expect(game.view(3).task).toBeNull();
    expect(game.spectator().seats[5].revealedRole).toBeUndefined();
    game.ok(6, 'wolf_king_hold_fire');
    expect(game.view(6).events).toContainEqual(expect.objectContaining({ type: 'wolf_king.decline', audience: [6] }));
    expect(!!lastPublic(game, 'wolf_king.decline')).toBe(declineReveals);
    expect(game.spectator().seats[5].revealedRole).toBe(declineReveals ? 'wolf_king' : undefined);
  });

  it.each([
    { lucky: false, knife: undefined }, { lucky: true, knife: undefined },
    { lucky: false, knife: 6 }, { lucky: true, knife: 6 },
  ])('含毒禁枪（幸运儿 $lucky，狼刀 $knife）', ({ lucky, knife }) => {
    const game = merchantGame(noSheriff);
    if (lucky) {
      game.ok(1, 'merchant_gift_poison', { targetSeat: 3 });
      game.until((g) => g.hasTool('lucky_poison'), chooseNight({ knife }));
      game.ok(3, 'lucky_poison', { targetSeat: 6 });
    } else finishNight(game, { knife, poison: 6 });
    expect(game.state.deaths.find((death) => death.seat === 6)?.causes).toEqual(knife ? ['wolf', 'poison'] : ['poison']);
    expect(game.hasTool('wolf_king_shoot')).toBe(false);
  });

  it.each([false, true])('放逐同一席位，私下询问和放弃开枪均不改变旁观或其他好人的视角（警徽 %s）', (sheriff) => {
    const swapped = [...deal];
    [swapped[5], swapped[6]] = [swapped[6], swapped[5]];
    const king = merchantGame(sheriff ? {} : noSheriff);
    const villager = merchantGame(sheriff ? {} : noSheriff, swapped);
    for (const game of [king, villager]) {
      if (sheriff) {
        game.untilTool('sheriff_signup');
        for (const seat of game.waiting()) game.ok(seat, seat === 6 ? 'sheriff_signup' : 'sheriff_stay_off');
      }
      game.toVote();
      for (const voter of game.waiting()) game.ok(voter, 'vote', { targetSeat: 6 });
    }
    const ordinaryDuty = sheriff ? 'badge_transfer' : 'speak';
    expect(villager.view(6).task?.tools.map((tool) => tool.name)).toContain(ordinaryDuty);
    expect(king.view(6).task?.tools.map((tool) => tool.name)).toContain('wolf_king_shoot');
    expect(king.spectator()).toEqual(villager.spectator());
    expect(king.view(8)).toEqual(villager.view(8));
    king.ok(6, 'wolf_king_hold_fire');
    expect(king.view(6).task?.tools.map((tool) => tool.name)).toContain(ordinaryDuty);
    expect(king.spectator()).toEqual(villager.spectator());
    expect(king.view(8)).toEqual(villager.view(8));
  });

  it('自定义阵容的猎枪连锁继承首夜死亡批次和遗言', () => {
    const game = merchantGame(noSheriff, ['miracle_merchant', 'wolf_king', 'hunter', 'werewolf', 'villager', 'villager']);
    finishNight(game, { knife: 3 });
    expect(game.hasTool('hunter_shoot')).toBe(true);
    game.ok(3, 'hunter_shoot', { targetSeat: 2 });
    expect(game.hasTool('wolf_king_shoot')).toBe(true);
    game.ok(2, 'wolf_king_shoot', { targetSeat: 5 });
    expect(game.state.deaths.map((death) => [death.seat, death.via, death.shooterVia, death.batch, death.lastWords]))
      .toEqual([[3, 'night', undefined, 1, true], [2, 'shot', 'night', 1, true], [5, 'shot', 'night', 1, true]]);
    expect(lastPublic(game, 'hunter.shot')?.payload).toEqual({ shooter: 3, target: 2, role: 'hunter' });
    expect(lastPublic(game, 'wolf_king.shot')?.payload).toEqual({ shooter: 2, target: 5, role: 'wolf_king' });
  });

  it.each([
    { anotherWolf: false, backfire: false, winner: 'good' }, { anotherWolf: true, backfire: true, winner: 'wolf' },
    { anotherWolf: false, backfire: true, winner: 'good' },
  ])('狼王与最后神职的同批判胜先于枪击（$anotherWolf, $backfire）', ({ anotherWolf, backfire, winner }) => {
    const game = merchantGame(noSheriff, ['miracle_merchant', 'wolf_king', 'villager', anotherWolf ? 'werewolf' : 'villager']);
    if (backfire) game.ok(1, 'merchant_gift_guard', { targetSeat: 2 });
    finishNight(game, { knife: 2 });
    expect(game.state.result?.winner).toBe(winner);
    expect(game.events.some((event) => event.type === 'judge' && event.payload.step === 'wolf_king.shoot')).toBe(false);
  });

  it('最后一民获赐后中毒仍可行动，同批先判屠民胜负', () => {
    const game = merchantGame(noSheriff, ['miracle_merchant', 'wolf_king', 'villager', 'werewolf', 'witch']);
    game.ok(1, 'merchant_gift_inspect', { targetSeat: 3 });
    game.until((g) => g.hasTool('lucky_inspect'), chooseNight({ knife: 2, poison: 3 }));
    game.ok(3, 'lucky_inspect', { targetSeat: 4 });
    expect(game.state.deaths.map(({ seat, causes }) => ({ seat, causes })))
      .toEqual([{ seat: 2, causes: ['wolf'] }, { seat: 3, causes: ['poison'] }]);
    expect(game.state.result).toMatchObject({ winner: 'wolf', reason: expect.stringContaining('平民') });
    expect(game.events.some((event) => event.type === 'judge' && event.payload.step === 'wolf_king.shoot')).toBe(false);
  });

  it('双守被拒后改选并走到终局，完整输入重建全部记录，成功输入重建对局事实', () => {
    const game = merchantGame(noSheriff);
    game.ok(1, 'merchant_gift_guard', { targetSeat: 5 });
    game.ok(5, 'guard_protect', { targetSeat: 3 });
    game.untilTool('lucky_guard');
    const rejected = game.actions.length;
    expect(game.act(5, 'lucky_guard', { targetSeat: 3 })?.code).toBe('INVALID_ARGUMENT');
    game.ok(5, 'lucky_guard', { targetSeat: 7 });
    game.untilTool('vote');
    expect(game.view(6).interrupts).toEqual([]);
    for (const voter of game.waiting()) game.ok(voter, 'vote', { targetSeat: 6 });
    game.ok(6, 'wolf_king_shoot', { targetSeat: 7 });
    expect(game.state.deaths.find((death) => death.seat === 7)).toMatchObject({ via: 'shot', by: 6 });
    expect(game.view(8).seats[5].revealedRole).toBe('wolf_king');
    expect(game.spectator().stage).toBe('6号遗言中');
    expect(game.spectator().seats[5].active).toBe(true);
    expect(game.spectator().seats[6].alive).toBe(false);
    game.until((g) => !!g.state.result, (_seat, tools) => {
      if (tools.some((tool) => tool.name === 'vote')) {
        const wolf = game.state.players.find((p) => p.alive && p.role === 'werewolf')!;
        return { tool: 'vote', args: { targetSeat: wolf.seat } };
      }
    });
    expect(game.state.result?.winner).toBe('good');
    expect(replay(game.options, game.actions)).toEqual({ state: game.state, events: game.events });
    const accepted = replay(game.options, game.actions.filter((_, i) => i !== rejected));
    expect(accepted.state).toEqual({ ...game.state, seq: game.state.seq - 1 });
    expect(game.events.filter((event) => event.type === 'action.rejected')).toMatchObject([{ audience: [5] }]);
    expect(accepted.events).toEqual(game.events.filter((event) => event.type !== 'action.rejected')
      .map((event, i) => ({ ...event, seq: i + 1 })));
  });
});
