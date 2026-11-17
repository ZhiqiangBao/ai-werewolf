import { expect, it } from 'vitest';
import { buildRules, createGame, projectSeat } from '@werewolf/engine';
import { mockDecision } from '../src/index';

it('模拟商人能选择三种赠礼与等待，并始终提交完整的显式动作', () => {
  const { state, events } = createGame({ id: 'merchant-mock', seed: 'merchant-mock', rules: buildRules('merchant12'),
    deal: ['miracle_merchant', 'guard', 'villager', 'seer', 'witch', 'villager', 'villager', 'villager', 'werewolf', 'werewolf', 'werewolf', 'wolf_king'] });
  const projection = projectSeat(state, events, 1);
  const tools = projection.task!.tools;
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const call = mockDecision({ ...projection, gameId: `merchant-mock-${i}` }, tools);
    const spec = tools.find((tool) => tool.name === call.tool)!;
    expect(spec).toBeDefined();
    if (call.tool === 'merchant_wait') expect(call.args).toEqual({});
    else {
      const target = spec.params.find((param) => param.name === 'targetSeat');
      expect(target?.kind === 'seat' && target.options).toContain(call.args.targetSeat);
      expect(Object.keys(call.args)).toEqual(['targetSeat']);
    }
    seen.add(call.tool);
  }
  expect(seen).toEqual(new Set(['merchant_gift_inspect', 'merchant_gift_poison', 'merchant_gift_guard', 'merchant_wait']));
});
