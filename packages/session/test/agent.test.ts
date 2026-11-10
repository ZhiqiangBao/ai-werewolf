import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@werewolf/protocol';
import { eventToMessage, notToolTurnMessages } from '../src/agent';

const speech: GameEvent = {
  seq: 7,
  day: 2,
  phase: 'day',
  type: 'speech',
  audience: 'public',
  text: '2号发言。',
  payload: { seat: 2, kind: 'discussion', content: '我发言结束。' },
};

describe('seat speech context', () => {
  it('does not append a non-turn suffix after another player speaks', () => {
    const message = eventToMessage(speech, 1, [], { locale: 'zh-CN', nextSeat: null, nextStep: null }, true);
    expect(message?.content).toBe('第2天2号发言（玩家原话）：\n「我发言结束。」');
  });

  it('returns the fixed rejection text only for a rejected tool call', () => {
    expect(notToolTurnMessages({ toolCallIds: [] }, 'zh-CN')).toEqual([
      { role: 'user', content: '不是你的轮次，请勿调用工具' },
    ]);
  });
});
