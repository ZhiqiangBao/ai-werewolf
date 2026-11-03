import { expect, it } from 'vitest';
import { submit } from '@werewolf/engine';
import { thinkingParameters } from '@werewolf/protocol';
import { ablateSourceBoundary, qualityCases } from '../scripts/model-quality-evaluation';

it('固定局面保留实际说话顺序，并按座位隔离查验和队友信息', () => {
  const [seer, villager, wolf] = qualityCases();
  expect(seer.projection.me?.knownIdentities).toContainEqual({ seat: 1, kind: 'alignment', alignment: 'wolf', source: 'inspection' });
  expect(seer.projection.events.some((e) => e.payload.seat === 1 && String(e.payload.content).includes('法官最新通知'))).toBe(true);
  expect(villager.projection.me?.knownIdentities).toEqual([]);
  expect(villager.projection.events.filter((e) => e.type === 'speech').map((e) => e.payload.seat)).toEqual([9, 1, 2, 3, 4, 5, 6, 7]);
  expect(JSON.stringify(villager.messages)).not.toContain('查验结果：1号是狼人');
  expect(JSON.stringify(villager.messages)).not.toContain('狼队成员：');
  expect(wolf.projection.me?.teammates).toEqual([2, 3]);
  expect(qualityCases().map((c) => c.hash)).toEqual([seer.hash, villager.hash, wolf.hash]);
});

it('提示对照只删除指定来源段，思考对照只改变支持参数', () => {
  for (const c of qualityCases()) {
    const before = JSON.stringify(c.messages);
    const ablated = ablateSourceBoundary(c.messages);
    expect(ablated.slice(1)).toEqual(c.messages.slice(1));
    expect(ablated[0].content).not.toContain('【消息来源与可信边界】');
    expect(c.messages[0].content).toContain('【消息来源与可信边界】');
    expect(c.messages[0].content?.replace(/【消息来源与可信边界】\n[\s\S]*?(?=【输出要求】)/, '')).toBe(ablated[0].content);
    expect(JSON.stringify(c.messages)).toBe(before);
  }
  const url = 'https://token-plan.maas.qianwenaiapi.com/v1';
  expect(['off', 'low', 'medium', 'high'].map((mode) => thinkingParameters(url, 'deepseek-v4-flash-0731', mode as 'off' | 'low' | 'medium' | 'high'))).toEqual([
    { enable_thinking: false }, { enable_thinking: true, reasoning_effort: 'low' },
    { enable_thinking: true, reasoning_effort: 'high' }, { enable_thinking: true, reasoning_effort: 'max' },
  ]);
});

it('评分使用引擎接受的动作；刀队友虽合法但单独记录，不虚称策略失败', () => {
  const [seer, , wolf] = qualityCases();
  expect(submit(seer.state, { seat: 4, decisionId: seer.projection.task!.decisionId, call: { tool: 'speak', args: { content: '1号是我的查杀。' } } }).error).toBeUndefined();
  expect(submit(seer.state, { seat: 4, decisionId: seer.projection.task!.decisionId, call: { tool: 'vote', args: { target: 1 } } }).error).toBeDefined();
  expect(submit(wolf.state, { seat: 1, decisionId: wolf.projection.task!.decisionId, call: { tool: 'wolf_kill', args: { target: 2 } } }).error).toBeUndefined();
});
