import { describe, expect, it } from 'vitest';
import { TestGame } from './harness';

const deal = [
  'werewolf', 'werewolf', 'werewolf', 'awakened_wolf', 'mirror_maiden', 'witch',
  'hunter', 'guard', 'villager', 'villager', 'villager', 'villager',
];

function inheritedKnife(options: { guard?: number; anchor?: 'random_dead' | 'knife_first' } = {}): TestGame {
  const game = new TestGame({ preset: 'mirror12', deal, awakenedNightVersion: 1, values: { 'sheriff.enabled': false, ...(options.anchor ? { 'speech.anchor': options.anchor } : {}) } });
  game.ok(4, 'awakened_mimic', { targetSeat: 1 });
  game.night();
  game.removeSeats(1, 2, 3);
  game.toNight();
  if (options.guard !== undefined) game.ok(8, 'guard_protect', { target: options.guard });
  game.untilTool('awakened_kill');
  return game;
}

describe('觉醒隐狼爪击与女巫解药', () => {
  it('继承狼刀不选择目标时，女巫不能救随后独立选择的爪击目标', () => {
    const game = inheritedKnife();
    game.ok(4, 'awakened_empty_kill');
    game.untilTool('witch_act');
    expect(game.view(6).events.filter((event) => event.type === 'witch.knife').at(-1)?.text).toContain('没有落刀');
    expect(game.toolsOf(6).find((tool) => tool.name === 'witch_act')?.params.some((param) => param.name === 'save')).toBe(false);
    game.ok(6, 'witch_act', { poisonTarget: null });
    game.untilTool('awakened_claw');
    game.ok(4, 'awakened_claw', { targetSeat: 9 });
    expect(game.state.players[8].alive).toBe(false);
  });

  it.each([
    { claw: 9, clawTargetAlive: false },
    { claw: 10, clawTargetAlive: true },
  ])('解药救狼刀目标时，爪击目标为 $claw 号，其存活为 $clawTargetAlive', ({ claw, clawTargetAlive }) => {
    const game = inheritedKnife();
    game.ok(4, 'awakened_kill', { targetSeat: 10 });
    game.untilTool('witch_act');
    expect(game.view(6).events.filter((event) => event.type === 'witch.knife').at(-1)?.text).toContain('10号');
    game.ok(6, 'witch_act', { save: true, poisonTarget: null });
    game.untilTool('awakened_claw');
    game.ok(4, 'awakened_claw', { targetSeat: claw });
    expect(game.state.players[9].alive).toBe(true);
    expect(game.state.players[claw - 1].alive).toBe(clawTargetAlive);
  });

  it('按狼刀确定发言依据时，狼刀目标未出局则使用出局玩家中较小的座位号', () => {
    const game = inheritedKnife({ guard: 10, anchor: 'knife_first' });
    game.ok(4, 'awakened_kill', { targetSeat: 10 });
    game.untilTool('witch_act');
    game.ok(6, 'witch_act', { save: false, poisonTarget: 11 });
    game.untilTool('awakened_claw');
    game.ok(4, 'awakened_claw', { targetSeat: 9 });
    expect(game.state.players[9].alive).toBe(true);
    expect(game.state.players[8].alive).toBe(false);
    expect(game.state.players[10].alive).toBe(false);
    expect(game.state.dayState.anchor).toBe(9);
  });
});
