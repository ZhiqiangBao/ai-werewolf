import { describe, expect, it } from 'vitest';
import { exposeAction, gameRecordEvents, simulationTools } from '@werewolf/protocol';
import { buildRules, createGame, replay, roleData, seatTools, submit, validateRules } from '../src/index';
import { TestGame } from './harness';

const deal = ['werewolf', 'werewolf', 'werewolf', 'awakened_wolf', 'mirror_maiden', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];

function clawNight(toolsetVersion: 1 | 2 = 1, values: Record<string, unknown> = {}): TestGame {
  const game = new TestGame({ deal, preset: 'mirror12', toolsetVersion, values: { 'sheriff.enabled': false, ...values } });
  game.ok(4, 'awakened_mimic', { targetSeat: 1 });
  game.until((g) => g.state.phase === 'day');
  expect(game.events.some((event) => event.type === 'awakened.skill')).toBe(false);
  game.removeSeats(1, 2, 3);
  game.toNight();
  expect(game.waiting()).toEqual([4]);
  expect(game.hasTool('awakened_claw')).toBe(true);
  return game;
}

function attacks(game: TestGame, claw: number | null, knife: number | null, guard: number | null = null): void {
  if (claw === null) game.ok(4, 'awakened_skip_skill');
  else game.ok(4, 'awakened_claw', { targetSeat: claw });
  expect(game.pending?.step.type).toBe('night:guard');
  if (guard === null) game.auto(8);
  else game.ok(8, 'guard_protect', { target: guard });
  expect(game.pending?.step.type).toBe('night:awakened_knife');
  if (knife === null) game.ok(4, 'awakened_empty_kill');
  else game.ok(4, 'awakened_kill', { targetSeat: knife });
  game.until((g) => g.pending?.step.type === 'night:witch');
}

function shownTargets(game: TestGame) {
  return game.view(6).events.findLast((event) => event.type === 'witch.targets');
}

describe('新版觉醒隐狼夜间流程', () => {
  it('纯觉醒隐狼版保留普通狼人落刀顺次，使用合法目标托管，不加入密谈', () => {
    const game = new TestGame({ deal: ['awakened_wolf', 'witch', 'villager', 'villager'],
      values: { 'sheriff.enabled': false, 'wolf.allowEmpty': false, 'wolf.allowTeammateTarget': false } });
    expect(game.state.rules.nightOrder).toEqual(['awakened_mimic', 'werewolf', 'witch']);
    game.ok(1, 'awakened_wait');
    expect(game.toolsOf(1)).toEqual([expect.objectContaining({ name: 'awakened_kill', params: [expect.objectContaining({ options: [2, 3, 4] })] })]);
    expect(game.act(1, 'awakened_kill', { targetSeat: 1 })).toBeDefined();
    game.auto(1);
    expect(game.state.night?.knife).toBe(2);
    expect(game.view(1).events.findLast((event) => event.type === 'action.fallback')?.payload.call).toEqual({ tool: 'awakened_kill', args: { targetSeat: 2 } });
    expect(game.view(1).events.some((event) => event.type === 'wolf.chat' || event.type === 'wolf.team')).toBe(false);
    expect(game.view(2).events.findLast((event) => event.type === 'witch.knife')?.payload.knife).toBe(2);
    expect(game.toolsOf(2).flatMap((tool) => tool.params).some((param) => param.name === 'saveTarget')).toBe(false);
    expect(replay(game.options, game.actions)).toEqual({ state: game.state, events: game.events });
  });

  it.each([1, 2] as const)('普通狼人超时按版本处理禁空刀配置（版本 %s）', (awakenedNightVersion) => {
    const game = new TestGame({ deal: ['werewolf', 'witch', 'villager', 'villager'], awakenedNightVersion,
      values: { 'sheriff.enabled': false, 'wolf.allowEmpty': false, 'wolf.allowTeammateTarget': false } });
    game.auto(1);
    expect(game.state.night?.knife).toBe(awakenedNightVersion === 2 ? 2 : null);
    expect(replay(game.options, game.actions)).toEqual({ state: game.state, events: game.events });
  });

  it('旧版缺省字段与显式旧版仍保留旧顺序，并在原询问精确续接', () => {
    const old = buildRules('mirror12', {}, { roles: deal, toolsetVersion: 1, awakenedNightVersion: 1 });
    expect(validateRules({ ...old, awakenedNightVersion: 3 as 2 })).toContain('觉醒隐狼夜间流程版本只支持 1 或 2');
    const missingVersion = { ...old };
    delete missingVersion.awakenedNightVersion;
    for (const rules of [old, missingVersion]) {
      const options = { id: 'awakened-night-legacy', rules, seed: 'legacy', deal };
      const started = createGame(options);
      const input = { seat: 4, decisionId: started.state.pending!.id, call: { tool: 'awakened_mimic', args: { targetSeat: 5 } } };
      const result = submit(JSON.parse(JSON.stringify(started.state)), input);
      expect(result.state.rules.nightOrder).toEqual(old.nightOrder);
      expect(replay(options, [input])).toEqual({ state: result.state, events: [...started.events, ...result.events] });
    }
  });

  it.each([9, 10])('两名受袭者时只救所选的 %s 号，受众中只有女巫能看到名单', (saveTarget) => {
    const game = clawNight();
    attacks(game, 10, 9);
    expect(shownTargets(game)).toMatchObject({ audience: [6], payload: { targets: [9, 10], step: 'night:witch', decisionId: game.pending?.id } });
    expect(game.view(6).task).toMatchObject({ decisionId: game.pending?.id, submitted: false });
    expect(shownTargets(game)?.payload).not.toHaveProperty('knife');
    expect(game.view(9).events.some((event) => event.type === 'witch.targets')).toBe(false);
    expect(game.spectator().events.some((event) => event.type === 'witch.targets')).toBe(false);
    const display = gameRecordEvents(game.view(6).events).findLast((event) => event.type === 'witch.targets');
    expect(display?.text).toBe('女巫（6号）获知本夜受到狼人攻击的玩家：9号、10号。');
    expect(game.act(6, 'witch_act', { save: true, poisonTarget: null })?.code).toBe('INVALID_ARGUMENT');
    expect(game.act(6, 'witch_act', { saveTarget: 11, poisonTarget: null })?.code).toBe('INVALID_ARGUMENT');
    expect(game.act(6, 'witch_act', { saveTarget, poisonTarget: 12 })?.code).toBe('SAME_NIGHT_BOTH_POTIONS');
    const input = { seat: 6, decisionId: game.pending!.id, call: { tool: 'witch_act', args: { saveTarget, poisonTarget: null } } };
    const restored = submit(JSON.parse(JSON.stringify(game.state)), input);
    expect(restored).toEqual(submit(game.state, input));
    game.ok(6, input.call.tool, input.call.args);
    expect(game.alive().filter((seat) => seat === 9 || seat === 10)).toEqual([saveTarget]);
    expect(game.view(6).events.findLast((event) => event.type === 'witch.save')?.payload.target).toBe(saveTarget);
  });

  it.each([
    { claw: 9, knife: null, target: 9 },
    { claw: null, knife: 10, target: 10 },
    { claw: 9, knife: 9, target: 9 },
  ])('爪击 $claw / 普通攻击 $knife 只列一个受袭座位，解药抵挡该座所有狼类攻击', ({ claw, knife, target }) => {
    const game = clawNight(2);
    attacks(game, claw, knife);
    expect(shownTargets(game)?.payload.targets).toEqual([target]);
    const menu = game.toolsOf(6);
    expect(menu.find((tool) => tool.name === 'witch_save')?.params).toMatchObject([{ name: 'targetSeat', options: [target] }]);
    expect(exposeAction({ tool: 'witch_act', args: { saveTarget: target, poisonTarget: null } }, menu)).toEqual({ tool: 'witch_save', args: { targetSeat: target } });
    game.ok(6, 'witch_save', { targetSeat: target });
    expect(game.alive()).toContain(target);
    expect(roleData(game.state.players[5], 'witch').antidote).toBe(false);
    game.toNight();
    game.until((g) => g.pending?.step.type === 'night:witch');
    expect(game.view(6).events.filter((event) => event.type === 'witch.targets' && event.day === game.state.day)).toEqual([]);
  });

  it('双药版本的两个显式目标经过动作映射后各消耗一瓶', () => {
    const game = clawNight(2, { 'witch.bothPotionsSameNight': true });
    attacks(game, 9, 10);
    const menu = game.toolsOf(6);
    expect(simulationTools(menu).find((tool) => tool.name === 'witch_act')?.params.map((param) => param.name)).toEqual(['saveTarget', 'poisonTarget']);
    expect(seatTools(game.state, 6).find((tool) => tool.name === 'witch_save_and_poison')?.params.map((param) => param.name)).toEqual(['saveTargetSeat', 'targetSeat']);
    game.ok(6, 'witch_save_and_poison', { saveTargetSeat: 9, targetSeat: 11 });
    expect(game.alive()).toContain(9);
    expect(game.state.deaths.filter((record) => record.day === 2).map(({ seat, causes }) => [seat, causes])).toEqual([[10, ['wolf']], [11, ['poison']]]);
    expect(roleData(game.state.players[5], 'witch')).toMatchObject({ antidote: false, poison: false });
  });

  it.each(['never', 'first_night', 'always'])('自救配置 %s 只影响可救候选，不隐去私密的被袭事实', (selfSave) => {
    const game = clawNight(1, { 'witch.selfSave': selfSave });
    attacks(game, 6, 9);
    expect(shownTargets(game)?.payload.targets).toEqual([6, 9]);
    expect(game.toolsOf(6)[0].params.find((param) => param.name === 'saveTarget')).toMatchObject({ options: selfSave === 'always' ? [6, 9] : [9] });
    if (selfSave !== 'always') expect(game.act(6, 'witch_act', { saveTarget: 6, poisonTarget: null })?.code).toBe('CANNOT_SELF_SAVE');
    else game.ok(6, 'witch_act', { saveTarget: 6, poisonTarget: null });
  });

  it('仅首夜可自救时，新版女巫在第 1 夜能选择救自己', () => {
    const game = new TestGame({ deal, preset: 'mirror12', values: { 'sheriff.enabled': false, 'witch.selfSave': 'first_night' } });
    game.night({ kill: 6, save: true });
    expect(shownTargets(game)?.payload.targets).toEqual([6]);
    expect(game.view(6).events.findLast((event) => event.type === 'witch.save')?.payload.target).toBe(6);
    expect(game.alive()).toContain(6);
    expect(roleData(game.state.players[5], 'witch').antidote).toBe(false);
  });

  it('同守同救照常结算，且 knife_first 仍取普通攻击目标', () => {
    const game = clawNight(1, { 'speech.anchor': 'knife_first' });
    attacks(game, 9, 10, 9);
    game.ok(6, 'witch_act', { saveTarget: 9, poisonTarget: null });
    expect(game.state.deaths.filter((record) => record.day === 2).map(({ seat, causes }) => [seat, causes])).toEqual([[9, ['guard_and_save']], [10, ['wolf']]]);
    expect(game.state.dayState.anchor).toBe(10);
  });
});
