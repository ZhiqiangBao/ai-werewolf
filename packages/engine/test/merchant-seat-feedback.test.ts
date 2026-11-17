import { expect, it } from 'vitest';
import { TestGame } from './harness';

it('守卫的附录与本职、幸运儿守护菜单对应，并在双守后显示下一夜禁守', () => {
  const deal = ['miracle_merchant', 'seer', 'villager', 'witch', 'guard', 'wolf_king',
    'villager', 'villager', 'villager', 'werewolf', 'werewolf', 'werewolf'];
  const game = new TestGame({ preset: 'merchant12', toolsetVersion: 2, deal, values: { 'sheriff.enabled': false } });
  game.ok(1, 'merchant_gift_guard', { targetSeat: 5 });
  expect(game.view(5).me?.appendix).toContain('第1夜禁守座位：无');
  game.ok(5, 'guard_protect', { targetSeat: 3 });
  game.untilTool('lucky_guard');
  expect(game.view(5).me?.appendix).toContain('第1夜禁守座位：3号');
  const luckyParam = game.toolsOf(5).find((tool) => tool.name === 'lucky_guard')?.params[0];
  expect(luckyParam?.kind === 'seat' && luckyParam.options).not.toContain(3);
  game.ok(5, 'lucky_guard', { targetSeat: 7 });
  expect(game.view(5).me?.appendix).toContain('第2夜禁守座位：3号、7号');
  game.toNight();
  expect(game.view(5).me?.appendix).toContain('第2夜禁守座位：3号、7号');
});

it('保留一夜后，幸运儿守护附录同时显示前夜与本夜的禁选目标', () => {
  const deal = ['miracle_merchant', 'seer', 'villager', 'witch', 'guard', 'wolf_king',
    'villager', 'villager', 'villager', 'werewolf', 'werewolf', 'werewolf'];
  const game = new TestGame({ preset: 'merchant12', toolsetVersion: 2, deal, values: { 'sheriff.enabled': false } });
  game.ok(1, 'merchant_gift_guard', { targetSeat: 5 });
  game.ok(5, 'guard_protect', { targetSeat: 3 });
  game.untilTool('lucky_skip');
  game.ok(5, 'lucky_skip');
  game.toNight();
  expect(game.view(5).me?.appendix).toContain('第2夜禁守座位：3号');
  game.ok(5, 'guard_protect', { targetSeat: 7 });
  game.untilTool('lucky_guard');
  const param = game.toolsOf(5).find((tool) => tool.name === 'lucky_guard')?.params[0];
  expect(param?.kind === 'seat' && param.options).not.toContain(3);
  expect(param?.kind === 'seat' && param.options).not.toContain(7);
  expect(game.view(5).me?.appendix).toContain('第2夜禁守座位：3号、7号');
});
