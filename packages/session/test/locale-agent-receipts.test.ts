import { describe, expect, it } from 'vitest';
import { ownLine, eventToMessage, readyToAct, syncThread, type SeatThread } from '../src/agent';
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
  it.each(['zh-CN', 'en', 'ja'])('%s 的女巫行动回执区分解药和毒药目标', (locale) => {
    const saveArgs = { targetSeat: 3 };
    const bothArgs = { saveTargetSeat: 3, targetSeat: 9 };
    const save = ownLine('witch_save', saveArgs, locale);
    const both = ownLine('witch_save_and_poison', bothArgs, locale);
    expect(save).toContain('3');
    expect(save).not.toBe(ownLine('witch_save', {}, locale));
    expect(both).toContain('3');
    expect(both).toContain('9');
    expect(ownLine('witch_act', { saveTarget: 3, poisonTarget: null }, locale)).toBe(save);
    expect(ownLine('witch_act', { saveTarget: 3, poisonTarget: 9 }, locale)).toBe(both);
    expect(saveArgs).toEqual({ targetSeat: 3 });
    expect(bothArgs).toEqual({ saveTargetSeat: 3, targetSeat: 9 });
    if (locale === 'en') expect(`${save} ${both}`).not.toMatch(/[\u4e00-\u9fff]/u);
  });
  it('女巫多目标私密消息只进入本人上下文并开启当轮行动', () => {
    const event = { seq: 1, day: 2, phase: 'night' as const, type: 'witch.targets', audience: [6],
      text: '狼人今晚的攻击目标：3号、9号。', payload: { targets: [3, 9], decisionId: 'decision', step: 'night:witch' } };
    const cue = { id: 'decision', afterSeq: 1, step: 'night:witch', kind: null, actors: [6],
      prompts: { 6: '狼人今晚的攻击目标：3号、9号。' }, tool: 'witch_act', broadcast: false };
    const hint = { nextSeat: 6, nextStep: 'night:witch', cue };
    const witch: SeatThread = { seat: 6, seen: 0, messages: [] };
    const other: SeatThread = { seat: 5, seen: 0, messages: [] };
    const system = { role: 'system' as const, content: '规则' };
    syncThread(witch, [event], system, hint);
    syncThread(other, [event], system, hint);
    expect(witch.messages).toHaveLength(2);
    expect(witch.messages[1].content).toContain('3号、9号');
    expect(readyToAct(witch, cue)).toBe(true);
    expect(other.messages).toEqual([system]);
    expect(readyToAct(other, cue)).toBe(false);
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
