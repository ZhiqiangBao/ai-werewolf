import { expect, it } from 'vitest';
import { submit } from '@werewolf/engine';
import { candidateMessages, certaintyScenes, CERTAINTY_CANDIDATE } from '../scripts/model-certainty-evaluation';

it('公开变体各有规则可达且投影完全相同的真预言家/双狼双生局', () => {
  for (const stage of ['discovery', 'holdout'] as const) {
    const scenes = certaintyScenes(stage);
    expect(scenes).toHaveLength(4);
    expect(new Set(scenes.map((s) => s.visibleHash)).size).toBe(4);
    for (const scene of scenes) {
      expect(scene.twinVerified).toBe(true);
      expect(scene.projection.me?.role).toBe('villager');
      expect(scene.projection.me?.knownIdentities).toEqual([]);
      expect(scene.projection.events.filter((e) => e.type === 'speech' && [1, 2].includes(Number(e.payload.seat)))).toHaveLength(2);
      expect(JSON.stringify(scene.messages)).not.toContain('狼队成员：');
      const order = scene.projection.events.filter((e) => e.type === 'speech').map((e) => e.payload.seat);
      expect(order.indexOf(1) < order.indexOf(2)).toBe(scene.id.endsWith('ab'));
      expect(submit(scene.state, { seat: 8, decisionId: scene.projection.task!.decisionId, call: { tool: 'speak', args: { content: '两人都声称预言家，尚未有法官确认。' } } }).error).toBeUndefined();
    }
  }
});

it('留出措辞未用于复现，候选只增加通用判断边界并保留策略性表达', () => {
  const discovered = certaintyScenes('discovery').map((s) => JSON.stringify(s.messages));
  for (const scene of certaintyScenes('holdout')) {
    expect(discovered).not.toContain(JSON.stringify(scene.messages));
    const candidate = candidateMessages(scene.messages);
    expect(candidate.slice(1)).toEqual(scene.messages.slice(1));
    expect(candidate[0].content).toContain(CERTAINTY_CANDIDATE);
    expect(candidate[0].content!.replace(CERTAINTY_CANDIDATE + '\n\n', '')).toBe(scene.messages[0].content);
    expect(CERTAINTY_CANDIDATE).toContain('公开发言仍可按真实阵营的策略隐瞒或声称身份');
  }
});
