import { describe, expect, it } from 'vitest';
import { ownLine, eventToMessage } from '../src/agent';
import { mockAdapter, type Adapter } from '@werewolf/llm';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';
import type { GodProjection } from '@werewolf/protocol';

describe('语言与行动回执', () => {
  it.each([
    ['zh-CN', '已提交查验 3号。', '已提交使用解药。'],
    ['en', 'Submitted an inspection of Player 3.', 'Submitted the choice to use the antidote.'],
    ['ja', '3番の占いを送信しました。', '解毒薬を使う選択を送信しました。'],
  ])('%s 的回执说明提交而不声称结算结果', (locale, inspect, save) => {
    expect(ownLine('seer_inspect', { targetSeat: 3 }, locale)).toBe(inspect);
    expect(ownLine('witch_save', {}, locale)).toBe(save);
    expect(ownLine('witch_act', { save: true, poisonTarget: null }, locale)).toBe(save);
  });
  it.each([
    ['guard_protect', { targetSeat: 3 }, 'Submitted protection of Player 3.'],
    ['witch_poison', { targetSeat: 3 }, 'Submitted poison for Player 3.'],
    ['wolf_kill', { targetSeat: 3 }, 'Submitted an attack on Player 3.'],
    ['vote', { targetSeat: 3 }, 'Submitted an exile vote for Player 3.'],
    ['sheriff_vote', { candidateSeat: 3 }, 'Submitted a sheriff vote for Player 3.'],
    ['hunter_shoot', { targetSeat: 3 }, 'Submitted a shot at Player 3.'],
    ['badge_transfer', { recipientSeat: 3 }, 'Submitted transfer of the badge to Player 3.'],
  ])('行动 %s 的目标回执不改工具参数', (tool, args, expected) => {
    const original = structuredClone(args);
    expect(ownLine(tool, args, 'en')).toBe(expected);
    expect(args).toEqual(original);
  });
  it('玩家原话和旧记录不会因房间语言被替换', () => {
    const content = '原话 {0} English 日本語';
    expect(ownLine('speak', { content }, 'en')).toBe(content);
    const event = { seq: 1, day: 1, phase: 'day' as const, type: 'speech', audience: 'public' as const, text: '历史原文', payload: { seat: 2, kind: 'discussion', content } };
    expect(eventToMessage(event, 1, [], { locale: 'en', nextSeat: null, nextStep: null }, false)?.content).toContain(content);
    expect(event.text).toBe('历史原文');
  });
  it.each([
    ['timeout', 'Deadline exceeded', 'timeout'],
    ['network', '超过只是上游返回的文本', 'request_failed'],
  ] as const)('托管原因依据 %s 分类，不匹配错误原文', async (failureKind, error, reason) => {
    let failed = false;
    const adapter: Adapter = { async decide(req) {
      if (!failed && req.toolChoice !== 'auto') {
        failed = true;
        return { ok: false, fatal: true, failureKind, error, toolCallIds: [], latencyMs: 0 };
      }
      return mockAdapter.decide(req);
    } };
    const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
    try {
      const { roomId, hostToken } = manager.createRoom({ locale: 'en' });
      manager.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
      manager.start(roomId, hostToken);
      await manager.whenIdle(roomId);
      const projection = manager.view(roomId, hostToken).projection as GodProjection;
      expect(projection.events.find((e) => e.type === 'action.fallback')?.payload.reason).toBe(reason);
    } finally { manager.dispose(); }
  });
});
