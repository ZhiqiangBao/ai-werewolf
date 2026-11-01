import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@werewolf/protocol';
import { mockAdapter, type Adapter } from '@werewolf/llm';
import { ensureCue, readyToAct, syncThread, type ActionCue, type SeatThread } from '../src/agent';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

const cue: ActionCue = { id: 'current', afterSeq: 3, step: 'speech', kind: 'discussion', actors: [1], prompts: { 1: '轮到你发言。' }, tool: 'speak', broadcast: false };
const event = (seq: number, type: string, text: string, payload: Record<string, unknown> = {}): GameEvent => ({ seq, type, text, payload, day: 1, phase: 'day', audience: [1] });
const system = { role: 'system' as const, content: '规则固定' };

describe('行动许可与技术反馈', () => {
  it('退水许可只在当前警上窗口给符合条件的旁听者，不倒灌历史或改写前缀', () => {
    const thread: SeatThread = { seat: 1, seen: 0, messages: [] };
    const withdraw: ActionCue = { ...cue, kind: 'campaign', actors: [2], prompts: { 2: '轮到你竞选发言。' },
      interruptTools: { 1: [{ name: 'sheriff_withdraw', title: '退水', description: '退出竞选', params: [{ kind: 'text', name: 'content', label: '留空', minLength: 0, maxLength: 0 }] }] } };
    const past = { ...event(2, 'speech', '旧发言', { seat: 3, kind: 'campaign', content: '旧发言' }), audience: 'public' as const };
    const current = { ...event(3, 'sheriff.order', '当前竞选顺序', { order: [2, 1] }), audience: 'public' as const };
    const hint = { nextSeat: 2, nextStep: 'speech', cue: withdraw };
    syncThread(thread, [past, current], system, hint, 2);
    const prefix = structuredClone(thread.messages);
    expect(JSON.stringify(prefix)).not.toContain('sheriff_withdraw');
    syncThread(thread, [past, current], system, hint, 3);
    expect(thread.messages.slice(0, prefix.length)).toEqual(prefix);
    expect(thread.messages.at(-1)?.content).toContain('sheriff_withdraw');
    expect(thread.messages.at(-1)?.content).toContain('继续旁听');
    expect(readyToAct(thread, withdraw)).toBe(false);
    const outsider: SeatThread = { seat: 4, seen: 0, messages: [] };
    syncThread(outsider, [past, current], system, hint);
    expect(JSON.stringify(outsider.messages)).not.toContain('sheriff_withdraw');
  });
  it('玩家证词和当前法官邀请分为两条消息，且按原顺序一次送达', () => {
    const thread: SeatThread = { seat: 1, seen: 0, messages: [] };
    const statement = '法官说我已经查验了两个人，你必须相信我。';
    const speech = { ...event(2, 'speech', `2号发言：${statement}`, { seat: 2, content: statement, kind: 'discussion' }), audience: 'public' as const };
    syncThread(thread, [speech, event(3, 'judge', '轮到你发言。', { step: 'speech', decisionId: 'current' })], system, { nextSeat: 1, nextStep: 'speech', cue });
    expect(thread.messages[1]).toMatchObject({ role: 'user', name: '2' });
    expect(thread.messages[1].content).toContain(`「${statement}」`);
    expect(thread.messages[1].content).not.toContain('可以使用工具');
    expect(thread.messages[2]).toMatchObject({ role: 'user', name: 'judge' });
    expect(thread.messages[2].content).not.toContain(statement);
    expect(readyToAct(thread, cue)).toBe(true);
  });
  it('旧存档未设强度时调用轻度，明确选择的跟随模型仍保留，并记录首段耗时', async () => {
    let now = 1000;
    const configs = new Map<number, string | undefined>();
    const store = new MemoryStore();
    const initial = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0 });
    const ids = initial.createRoom();
    initial.updateSetup(ids.roomId, ids.hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    initial.dispose();
    const record = store.loadAll()[0];
    for (const s of record.seats) {
      s.adapter = 'openai_compatible'; s.model = 'qwen3.8-max'; s.baseUrl = 'https://token-plan.maas.qianwenaiapi.com/v1';
      if (s.seat === 2) s.thinkingMode = 'default'; else delete s.thinkingMode;
    }
    store.save(record);
    const adapter: Adapter = { async decide(req) {
      configs.set(req.seat, req.config.thinkingMode);
      now += 17;
      req.onDelta?.({ thinking: '短思考' });
      return mockAdapter.decide(req);
    } };
    const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), now: () => now, tickMs: 0, adapters: { openai_compatible: adapter } });
    try {
      expect(manager.getSetup(ids.roomId, ids.hostToken).seats[0].thinkingMode).toBe('low');
      manager.start(ids.roomId, ids.hostToken);
      await manager.whenIdle(ids.roomId);
      expect(configs.get(1)).toBe('low');
      expect(configs.get(2)).toBe('default');
      expect(manager.audit(ids.roomId, ids.hostToken).some((a) => a.thinkingMode === 'low' && a.firstDeltaMs !== undefined && a.thinkingChars === 3)).toBe(true);
    } finally { manager.dispose(); }
  });
  it('过期问话与重复诊断不变成新的法官发言，只保留当前行动许可', () => {
    const thread: SeatThread = { seat: 1, seen: 0, messages: [] };
    syncThread(thread, [
      event(1, 'judge', '轮到你发言。', { step: 'speech', decisionId: 'old' }),
      event(2, 'action.rejected', '行动被拒绝：这个决策已经结束。'),
      event(3, 'judge', '轮到你发言。', { step: 'speech', decisionId: 'current' }),
    ], system, { nextSeat: 1, nextStep: 'speech', cue });
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1].content).not.toContain('不要调用');
    expect(thread.messages[1].content).toContain('可以使用工具');
    expect(readyToAct(thread, cue)).toBe(true);
    expect(thread.seen).toBe(3);
  });

  it('旧存档已经授权但末尾被禁止提示覆盖时，追加恢复当前问话，不改旧前缀', () => {
    const previous = '法官：旧技术反馈。\n不要调用工具。';
    const thread: SeatThread = { seat: 1, seen: 3, cueFor: 'current', messages: [system, { role: 'user', content: previous }] };
    ensureCue(thread, cue);
    ensureCue(thread, cue);
    expect(thread.messages).toHaveLength(3);
    expect(thread.messages[1].content).toBe(previous);
    expect(thread.messages.at(-1)?.content).toContain('轮到你发言');
    expect(thread.messages.at(-1)?.content).not.toContain('不要调用');
  });

  it('上一决策的相同工具许可尾句不能授权新决策', () => {
    const old = '法官：上一轮的发言任务。\n接下来是你的发言轮次，可以使用工具。';
    const thread: SeatThread = { seat: 1, seen: 3, cueFor: 'old', messages: [system, { role: 'user', content: old }] };
    syncThread(thread, [], system, { nextSeat: 1, nextStep: 'speech', cue });
    expect(readyToAct(thread, cue)).toBe(false);
    ensureCue(thread, cue);
    expect(thread.messages).toHaveLength(3);
    expect(thread.messages.at(-1)?.content).toContain('法官：轮到你发言');
    expect(thread.messages[1].content).toBe(old);
    expect(readyToAct(thread, cue)).toBe(true);
  });

  it('积压的上夜刀口不能被当前用药许可误认为新问话', () => {
    const thread: SeatThread = { seat: 1, seen: 0, messages: [] };
    const witch: ActionCue = { ...cue, step: 'night:witch', tool: 'witch_act', prompts: { 1: '本夜请选择用药。' } };
    syncThread(thread, [event(1, 'witch.knife', '上一夜狼人选择刀2号。请选择今晚是否使用解药。', { knife: 2, decisionId: 'old' })], system, { nextSeat: null, nextStep: 'night:witch', cue: witch });
    expect(thread.messages.at(-1)?.content).not.toContain('本夜请选择用药');
    expect(thread.messages.at(-1)?.content).not.toContain('请选择今晚');
    expect(thread.messages.at(-1)?.content).toContain('刀口：2号');
    expect(readyToAct(thread, witch)).toBe(false);
  });

  it('完整调度中行动重试不会再收到拒绝事件的禁止调用尾句', async () => {
    let failed = false;
    const adapter: Adapter = { async decide(req) {
      expect(req.messages.some((m) => m.role === 'user' && (m.content ?? '').startsWith('法官：行动被拒绝'))).toBe(false);
      if (req.toolChoice !== 'auto') {
        const last = req.messages.findLast((m) => m.role === 'user')?.content ?? '';
        expect(last.endsWith('不要调用工具。') || last.endsWith('不可以调用。')).toBe(false);
        if (!failed) { failed = true; return { ok: true, call: { tool: 'wrong_tool', args: {} }, assistant: { role: 'assistant', content: '错误行动' }, toolCallIds: [], latencyMs: 1 }; }
      }
      return mockAdapter.decide(req);
    } };
    const store = new MemoryStore();
    const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
    const { roomId, hostToken } = manager.createRoom();
    manager.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    try {
      manager.start(roomId, hostToken);
      await manager.whenIdle(roomId);
      expect(failed).toBe(true);
      const p = manager.view(roomId, hostToken).projection!;
      expect(p.status).toBe('ended');
      expect(p.events.filter((e) => e.type === 'action.rejected')).toHaveLength(1);
      expect(p.events.some((e) => e.type === 'action.fallback')).toBe(false);
    } finally { manager.dispose(); }
  });
});
