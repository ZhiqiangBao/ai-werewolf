import { describe, expect, it } from 'vitest';
import { DEAL12, lastPublic, TestGame } from './harness';

describe('夜间结果的公布时序与参与资格', () => {
  it('先竞选时有死亡与平安夜的公开信息相同，均提示未公布，不从参与资格泄露结果', () => {
    const peace = new TestGame({ deal: DEAL12 }), death = new TestGame({ deal: DEAL12 });
    peace.night({ kill: null }); death.night({ kill: 9 });
    expect(peace.spectator().events).toEqual(death.spectator().events);
    for (const g of [peace, death]) {
      expect(lastPublic(g, 'sheriff.start')?.text).toContain('尚未公布');
      expect(lastPublic(g, 'dawn')).toBeUndefined();
      expect(g.view(9).task?.tools.some((t) => t.name === 'sheriff_signup')).toBe(true);
      expect(g.view(9).ruleCard).toContain('参与资格，不表示该玩家已经确认存活');
      g.noElection();
    }
    expect(lastPublic(peace, 'dawn')?.payload.deaths).toEqual([]);
    expect(lastPublic(death, 'dawn')?.payload.deaths).toEqual([9]);
  });
  it('显式先公布再竞选时，不再告知已经过期的“尚未公布”状态', () => {
    const g = new TestGame({ deal: DEAL12, values: { 'sheriff.timing': 'after_last_words' } });
    g.night({ kill: 9 }); g.untilTool('sheriff_signup');
    expect(lastPublic(g, 'dawn')!.seq).toBeLessThan(lastPublic(g, 'sheriff.start')!.seq);
    expect(lastPublic(g, 'sheriff.start')!.text).not.toContain('尚未公布');
  });
  it('非上警白天在普通发言之前明确通报死亡或平安夜', () => {
    for (const kill of [null, 9]) {
      const g = new TestGame({ deal: DEAL12, values: { 'sheriff.enabled': false } });
      g.night({ kill }); g.until((x) => x.pending?.step.kind === 'discussion');
      expect(lastPublic(g, 'dawn')!.seq).toBeLessThan(lastPublic(g, 'speech.order')!.seq);
      expect(lastPublic(g, 'dawn')?.text).toBe(kill === null ? '昨夜平安，无人出局。' : '昨夜出局：9号。');
    }
  });
});
