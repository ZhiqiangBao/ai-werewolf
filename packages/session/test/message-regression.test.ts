import { describe, expect, it } from 'vitest';
import type { GodProjection } from '@werewolf/protocol';
import { mockAdapter, type Adapter, type DecideRequest } from '@werewolf/llm';
import { DEAL9, TestGame } from '../../engine/test/harness';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

function room(adapter: Adapter, extra: Record<string, unknown> = {}) {
  const store = new MemoryStore();
  const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter }, ...extra });
  const ids = manager.createRoom();
  manager.updateSetup(ids.roomId, ids.hostToken, { presetId: 'classic9', aiPacingMs: 0 });
  return { store, manager, ...ids };
}

describe('座位消息与行动的回归场景', () => {
  it('重启时问话已经落盘但尚未提交，直接恢复行动而不重复问话', async () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false } });
    g.night({ kill: null, inspect: 1 });
    const d = g.pending!;
    const actor = d.actors[0];
    const initial = room(mockAdapter);
    initial.manager.dispose();
    const record = initial.store.loadAll()[0];
    Object.assign(record, {
      status: 'running', state: g.state, rules: g.state.rules, seed: g.state.seed,
      events: g.events, actions: g.actions, deadlines: {}, threads: [{
        seat: actor, seen: g.state.seq, cueFor: d.id,
        messages: [{ role: 'system', content: '规则' }, { role: 'user', name: 'judge', content: `法官：${d.prompts[actor]}\n接下来是你的发言轮次，可以使用工具。` }],
      }],
    });
    for (const seat of record.seats) seat.controller = seat.seat === actor ? 'ai' : 'human';
    initial.store.save(record);
    let captured: DecideRequest | undefined;
    const adapter: Adapter = { async decide(req) { if (req.toolChoice !== 'auto') captured ??= req; return mockAdapter.decide(req); } };
    const manager = new RoomManager({ store: initial.store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
    try {
      manager.resumeAll();
      await manager.whenIdle(record.id);
      expect(captured).toBeDefined();
      expect(captured!.messages).toHaveLength(3);
      expect(captured!.messages[1]).toEqual(record.threads![0].messages[1]);
      expect(captured!.messages.at(-1)?.content).toContain('本轮只能从以下工具中选择一个调用');
      expect(captured!.messages.at(-1)?.content).not.toContain(d.prompts[actor]);
      expect(manager.view(record.id, record.hostToken).projection!.events.some((e) => e.type === 'speech' && e.payload.seat === actor)).toBe(true);
      expect(manager.view(record.id, record.hostToken).room.paused).toBe(false);
    } finally { manager.dispose(); }
  });

  it('恢复积压消息：最后一位发言送到后才允许行动，旁听期间不开始计时', async () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false } });
    g.night({ kill: null, inspect: 1 });
    const order = g.events.find((e) => e.type === 'speech.order')!.payload.order as number[];
    const [first, second, actor] = order;
    const seen = g.state.seq;
    g.ok(first, 'speak', { content: 'FIRST_PRIOR_SPEECH' });
    g.ok(second, 'speak', { content: 'LATEST_PRIOR_SPEECH' });
    const captured: DecideRequest[] = [];
    let now = 1000;
    const adapter: Adapter = {
      async decide(req) {
        captured.push({ ...req, messages: structuredClone(req.messages) });
        if (req.toolChoice === 'auto') {
          expect(req.messages.at(-1)?.content).not.toContain('接下来是你的发言轮次');
          expect(req.projection?.task?.deadline).toBeUndefined();
          now += 300_000;
          manager.tick();
        }
        return mockAdapter.decide(req);
      },
    };
    const initial = room(mockAdapter);
    initial.manager.dispose();
    const record = initial.store.loadAll()[0];
    Object.assign(record, {
      status: 'running', state: g.state, rules: g.state.rules, seed: g.state.seed, events: g.events,
      actions: g.actions, deadlines: { [`${g.pending!.id}:${actor}`]: 1000 }, threads: [{ seat: actor, seen, messages: [] }],
    });
    for (const seat of record.seats) seat.controller = seat.seat === actor ? 'ai' : 'human';
    initial.store.save(record);
    const manager = new RoomManager({ store: initial.store, secrets: SecretBox.ephemeral(), tickMs: 0, now: () => now, adapters: { mock: adapter } });
    try {
      manager.tick(); // 老存档里过期的截止时间不能证明问话已经送到。
      manager.resumeAll();
      await manager.whenIdle(record.id);
      const action = captured.find((r) => r.toolChoice !== 'auto')!;
      expect(action).toBeDefined();
      const history = JSON.stringify(action.messages);
      expect(history).toContain('FIRST_PRIOR_SPEECH');
      expect(history).toContain('LATEST_PRIOR_SPEECH');
      expect(history.indexOf('FIRST_PRIOR_SPEECH')).toBeLessThan(history.indexOf('LATEST_PRIOR_SPEECH'));
      expect(action.messages.at(-1)?.content).toContain('LATEST_PRIOR_SPEECH');
      expect(action.messages.at(-1)?.content).toContain('现在轮到你行动，请调用本轮菜单中的一个工具');
      expect(action.config.timeoutSec).toBe(180);
      expect(manager.view(record.id, record.hostToken).projection?.events.some((e) => e.type === 'action.fallback')).toBe(false);
    } finally { manager.dispose(); }
  });

  it('旁听接口失败或提前调用合法工具，都不能在问话前消耗行动', async () => {
    let failures = 0;
    let earlyCalls = 0;
    const adapter: Adapter = {
      async decide(req) {
        if (req.toolChoice === 'auto' && req.projection?.task && !req.projection.task.submitted) {
          expect(req.projection.task.deadline).toBeUndefined();
          if (!failures++) return { ok: false, fatal: true, error: '模拟 HTTP 500', failureKind: 'http', toolCallIds: [], latencyMs: 1 };
          if (!earlyCalls++) {
            const spec = req.projection.task.tools[0];
            return { ok: true, call: { tool: spec.name, args: { content: 'EARLY_ACTION' } }, toolCallIds: [], latencyMs: 1 };
          }
        }
        return mockAdapter.decide(req);
      },
    };
    const { manager, roomId, hostToken } = room(adapter);
    try {
      manager.start(roomId, hostToken);
      await manager.whenIdle(roomId);
      const p = manager.view(roomId, hostToken).projection as GodProjection;
      expect(failures).toBeGreaterThan(0);
      expect(earlyCalls).toBeGreaterThan(0);
      expect(p.status).toBe('ended');
      expect(p.events.some((e) => e.type === 'action.fallback')).toBe(false);
      expect(p.events.some((e) => e.payload.content === 'EARLY_ACTION')).toBe(false);
    } finally { manager.dispose(); }
  });

  it('五次失败的助手调用和工具反馈均进入后续上下文及座位存档', async () => {
    let decision = '';
    let seat = 0;
    let attempts = 0;
    let laterSawFailure = false;
    const adapter: Adapter = {
      async decide(req) {
        if (req.toolChoice !== 'auto' && !decision) { decision = req.projection!.task!.decisionId; seat = req.seat; }
        if (req.toolChoice !== 'auto' && req.projection?.task?.decisionId === decision && req.seat === seat) {
          const id = `FAILED_CALL_${++attempts}`;
          return {
            ok: true, call: { tool: 'nonexistent_tool', args: {} },
            assistant: { role: 'assistant', content: null, calls: [{ id, name: 'nonexistent_tool', arguments: '{}' }] },
            toolCallIds: [id], latencyMs: 1,
          };
        }
        if (req.seat === seat && JSON.stringify(req.messages).includes('FAILED_CALL_5')) laterSawFailure = true;
        return mockAdapter.decide(req);
      },
    };
    const { manager, store, roomId, hostToken } = room(adapter);
    try {
      manager.start(roomId, hostToken);
      await manager.whenIdle(roomId);
      expect(attempts).toBe(5);
      expect(laterSawFailure).toBe(true);
      const fallback = manager.view(roomId, hostToken).projection!.events.find((e) => e.type === 'action.fallback');
      expect(fallback?.payload.reason).toBe('invalid_tool');
      expect(fallback?.text).toContain('连续工具调用失败');
      manager.dispose();
      const messages = store.loadAll()[0].threads!.find((t) => t.seat === seat)!.messages;
      for (let i = 1; i <= 5; i++) {
        expect(messages.some((m) => m.role === 'assistant' && m.calls?.some((c) => c.id === `FAILED_CALL_${i}`))).toBe(true);
        expect(messages.some((m) => m.role === 'tool' && m.callId === `FAILED_CALL_${i}` && m.content.includes('工具调用错误'))).toBe(true);
      }
    } finally { manager.dispose(); }
  });

  it('换下一位时不取消还在收听上一条发言的模型', async () => {
    let checked = false;
    const adapter: Adapter = {
      async decide(req) {
        const last = req.messages.at(-1);
        if (!checked && req.toolChoice === 'auto' && last?.role === 'user' && last.name !== 'judge' && req.projection?.phase === 'day') {
          checked = true;
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(req.signal?.aborted).toBe(false);
        }
        return mockAdapter.decide(req);
      },
    };
    const { manager, roomId, hostToken } = room(adapter);
    try {
      manager.start(roomId, hostToken);
      await manager.whenIdle(roomId);
      expect(checked).toBe(true);
    } finally { manager.dispose(); }
  });

  it('重试仅使用本轮剩余时间，耗尽后按超时托管', async () => {
    let now = 1000;
    let decision = '';
    const budgets: number[] = [];
    const adapter: Adapter = {
      async decide(req) {
        if (req.toolChoice !== 'auto' && !decision) decision = req.projection!.task!.decisionId;
        if (req.toolChoice !== 'auto' && req.projection?.task?.decisionId === decision) {
          budgets.push(req.config.timeoutSec);
          now += 40_000;
          return { ok: false, error: '模拟工具参数错误', assistant: { role: 'assistant', content: 'bad' }, toolCallIds: [], latencyMs: 40_000 };
        }
        return mockAdapter.decide(req);
      },
    };
    const { manager, roomId, hostToken } = room(adapter, { now: () => now });
    manager.updateSetup(roomId, hostToken, { presetId: 'standard12' });
    try {
      manager.start(roomId, hostToken);
      await manager.whenIdle(roomId);
      expect(budgets).toEqual([90, 50, 10]);
      expect(manager.view(roomId, hostToken).projection!.events.find((e) => e.type === 'action.fallback')?.payload.reason).toBe('timeout');
    } finally { manager.dispose(); }
  });

  it('AI 展示间隔不占用模型的行动倒计时', async () => {
    let now = 1000;
    const adapter: Adapter = {
      async decide(req) {
        if (req.toolChoice !== 'auto') expect(req.projection!.task!.deadline! - now).toBe(req.config.timeoutSec * 1000);
        return mockAdapter.decide(req);
      },
    };
    const { manager, roomId, hostToken } = room(adapter, { now: () => now, sleep: async (ms: number) => { now += ms; } });
    manager.updateSetup(roomId, hostToken, { aiPacingMs: 10_000 });
    try { manager.start(roomId, hostToken); await manager.whenIdle(roomId); }
    finally { manager.dispose(); }
  });
});
