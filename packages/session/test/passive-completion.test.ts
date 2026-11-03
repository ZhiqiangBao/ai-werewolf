import { describe, expect, it } from 'vitest';
import { mockAdapter, type Adapter, type DecideRequest, type DecideResult } from '@werewolf/llm';
import { DEAL9, TestGame } from '../../engine/test/harness';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

function savedGame(g: TestGame) {
  const store = new MemoryStore();
  const setup = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0 });
  const ids = setup.createRoom();
  setup.updateSetup(ids.roomId, ids.hostToken, { presetId: 'classic9', aiPacingMs: 0 });
  setup.dispose();
  const record = store.loadAll()[0];
  Object.assign(record, { status: 'running', paused: false, state: g.state, rules: g.state.rules,
    seed: g.state.seed, events: g.events, actions: g.actions, deadlines: {} });
  for (const seat of record.seats) seat.controller = 'human';
  return { store, record, ...ids };
}

describe('完成本局任务后的模型旁听', () => {
  it('最后一次行动完成本人遗言后，接受的工具调用和回执仍保存', async () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false } });
    g.night({ kill: 9, inspect: 1 });
    expect(g.pending?.step).toMatchObject({ type: 'speech', kind: 'lastwords', seat: 9 });
    const { store, record, roomId, hostToken } = savedGame(g);
    record.seats[8].controller = 'ai';
    record.threads = [{ seat: 9, seen: g.state.seq, cueFor: g.pending!.id, messages: [] }];
    store.save(record);
    const calls: DecideRequest[] = [];
    const adapter: Adapter = { async decide(req) {
      calls.push(req);
      return { ok: true, call: { tool: 'speak', args: { content: '最后遗言' } },
        assistant: { role: 'assistant', content: null, calls: [{ id: 'last-words-call', name: 'speak', arguments: '{"content":"最后遗言"}' }] },
        toolCallIds: ['last-words-call'], latencyMs: 1 };
    } };
    const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
    try {
      manager.resumeAll();
      await manager.whenIdle(roomId);
      expect(calls).toHaveLength(1);
      expect(calls[0].toolChoice).not.toBe('auto');
      expect(manager.view(roomId, hostToken).projection!.events.some(e => e.payload.content === '最后遗言')).toBe(true);
      manager.dispose();
      const messages = store.loadAll()[0].threads!.find(t => t.seat === 9)!.messages;
      expect(messages.some(m => m.role === 'assistant' && m.calls?.some(c => c.id === 'last-words-call'))).toBe(true);
      expect(messages.some(m => m.role === 'tool' && m.callId === 'last-words-call')).toBe(true);
    } finally { manager.dispose(); }
  });

  it('合法旁听自爆使本人结清时仍保存已接受的工具调用和回执', async () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false, 'explode.window': 'interrupt', 'lastWords.explode': false } });
    g.night({ kill: null, inspect: 1 });
    g.until(x => x.pending?.step.type === 'speech' && x.pending.step.kind === 'discussion');
    const seen = g.state.seq;
    const previous = g.waiting()[0];
    g.ok(previous, 'speak', { content: '触发旁听的发言' });
    const wolf = [1, 2, 3].find(s => s !== previous && !g.pending!.actors.includes(s))!;
    const { store, record, roomId, hostToken } = savedGame(g);
    record.seats[wolf - 1].controller = 'ai';
    record.threads = [{ seat: wolf, seen, messages: [] }];
    store.save(record);
    const calls: DecideRequest[] = [];
    const adapter: Adapter = { async decide(req) {
      calls.push(req);
      expect(req.projection!.interrupts.some(t => t.name === 'wolf_explode')).toBe(true);
      return { ok: true, call: { tool: 'wolf_explode', args: {} },
        assistant: { role: 'assistant', content: null, calls: [{ id: 'explode-call', name: 'wolf_explode', arguments: '{}' }] },
        toolCallIds: ['explode-call'], latencyMs: 1 };
    } };
    const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
    try {
      manager.resumeAll();
      await manager.whenIdle(roomId);
      expect(calls).toHaveLength(1);
      expect(calls[0].toolChoice).toBe('auto');
      expect(manager.view(roomId, hostToken).projection!.events.some(e => e.type === 'explode' && e.payload.seat === wolf)).toBe(true);
      manager.dispose();
      const messages = store.loadAll()[0].threads!.find(t => t.seat === wolf)!.messages;
      expect(messages.some(m => m.role === 'assistant' && m.calls?.some(c => c.id === 'explode-call'))).toBe(true);
      expect(messages.some(m => m.role === 'tool' && m.callId === 'explode-call')).toBe(true);
    } finally { manager.dispose(); }
  });

  it('旧房间重载、暂停恢复后不再为已结清席位发请求，其他席位照常旁听；真人和旁观订阅继续', async () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false } });
    g.night({ kill: 9, inspect: 1 });
    g.until(x => x.pending?.step.type === 'speech' && x.pending.step.kind === 'discussion');
    const seen = g.state.seq;
    g.ok(g.waiting()[0], 'speak', { content: '完成后仍应公开的发言' });
    const listener = g.alive().find(s => !g.pending!.actors.includes(s))!;
    const { store, record, roomId, hostToken } = savedGame(g);
    record.seats[8].controller = 'ai';
    record.seats[listener - 1].controller = 'ai';
    record.threads = [{ seat: 9, seen, messages: [] }, { seat: listener, seen, messages: [] }];
    store.save(record);
    const calls: DecideRequest[] = [];
    const adapter: Adapter = { async decide(req) { calls.push(req); return mockAdapter.decide(req); } };
    const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
    try {
      manager.control(roomId, hostToken, 'pause');
      manager.control(roomId, hostToken, 'resume');
      manager.resumeAll();
      await manager.whenIdle(roomId);
      expect(calls.some(c => c.seat === 9)).toBe(false);
      expect(calls.some(c => c.seat === listener && c.toolChoice === 'auto')).toBe(true);
      const seatView = manager.view(roomId, record.seatTokens[8]).projection!;
      const spectatorView = manager.view(roomId, record.spectatorToken).projection!;
      expect(seatView.events.some(e => e.payload.content === '完成后仍应公开的发言')).toBe(true);
      expect(spectatorView.events.some(e => e.payload.content === '完成后仍应公开的发言')).toBe(true);
      let seatUpdates = 0, spectatorUpdates = 0;
      manager.subscribe(roomId, record.seatTokens[8], () => seatUpdates++);
      manager.subscribe(roomId, record.spectatorToken, () => spectatorUpdates++);
      const task = manager.view(roomId, hostToken).projection!.task;
      const actor = g.waiting()[0];
      const result = manager.act(roomId, record.seatTokens[actor - 1], { decisionId: g.pending!.id, tool: 'speak', args: { content: '后续公开发言' } });
      expect(result.ok).toBe(true);
      await manager.whenIdle(roomId);
      expect(task).toBeDefined();
      expect(seatUpdates).toBeGreaterThan(0);
      expect(spectatorUpdates).toBeGreaterThan(0);
      expect(manager.view(roomId, record.seatTokens[8]).projection!.events.some(e => e.payload.content === '后续公开发言')).toBe(true);
      expect(manager.view(roomId, record.spectatorToken).projection!.events.some(e => e.payload.content === '后续公开发言')).toBe(true);
      expect(calls.some(c => c.seat === 9)).toBe(false);
    } finally { manager.dispose(); }
  });

  it('其他人的猎枪使旁听者任务结清后取消在途请求，迟到结果不写入座位上下文', async () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false, 'lastWords.shotAfterFirstNight': false } });
    g.night({ kill: 6, inspect: 1 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    const publicEvent = [...g.events].reverse().find(e => e.audience === 'public')!;
    const { store, record, roomId, hostToken } = savedGame(g);
    record.seats[6].controller = 'ai';
    record.seats[7].controller = 'ai';
    record.threads = [7, 8].map(seat => ({ seat, seen: publicEvent.seq - 1, messages: [] }));
    store.save(record);
    const requests = new Map<number, DecideRequest>();
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: (result: DecideResult) => void;
    const delayed = new Promise<DecideResult>(resolve => { release = resolve; });
    let releaseOther!: (result: DecideResult) => void;
    const otherDelayed = new Promise<DecideResult>(resolve => { releaseOther = resolve; });
    const adapter: Adapter = { async decide(req) {
      if (!requests.has(req.seat)) requests.set(req.seat, req);
      if (requests.size === 2) enter();
      return req.seat === 7 ? delayed : otherDelayed;
    } };
    const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
    try {
      manager.resumeAll();
      await entered;
      expect(requests.get(7)?.toolChoice).toBe('auto');
      expect(requests.get(8)?.toolChoice).toBe('auto');
      const result = manager.act(roomId, record.seatTokens[5], { decisionId: g.pending!.id, tool: 'hunter_shoot', args: { target: 7 } });
      expect(result.ok).toBe(true);
      expect(requests.get(7)?.signal?.aborted).toBe(true);
      expect(requests.get(8)?.signal?.aborted).toBe(false);
      release({ ok: true, reply: 'LATE_RESPONSE_MUST_NOT_BE_STORED', toolCallIds: [], latencyMs: 1 });
      releaseOther({ ok: true, reply: 'OTHER_LISTENER_REPLY', toolCallIds: [], latencyMs: 1 });
      await manager.whenIdle(roomId);
      manager.dispose();
      expect(JSON.stringify(store.loadAll()[0].threads)).not.toContain('LATE_RESPONSE_MUST_NOT_BE_STORED');
      expect(JSON.stringify(store.loadAll()[0].threads)).toContain('OTHER_LISTENER_REPLY');
    } finally { manager.dispose(); }
  });

  it('房主终结对局时取消存活席位的在途旁听，迟到响应不进入上下文', async () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false } });
    g.night({ kill: 6, inspect: 1 });
    const publicEvent = [...g.events].reverse().find(e => e.audience === 'public')!;
    const { store, record, roomId, hostToken } = savedGame(g);
    record.seats[6].controller = 'ai';
    record.threads = [{ seat: 7, seen: publicEvent.seq - 1, messages: [] }];
    store.save(record);
    let enter!: (req: DecideRequest) => void;
    const entered = new Promise<DecideRequest>(resolve => { enter = resolve; });
    let release!: (result: DecideResult) => void;
    const delayed = new Promise<DecideResult>(resolve => { release = resolve; });
    const adapter: Adapter = { async decide(req) { enter(req); return delayed; } };
    const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
    try {
      manager.resumeAll();
      const request = await entered;
      manager.control(roomId, hostToken, 'end');
      expect(request.signal?.aborted).toBe(true);
      release({ ok: true, reply: 'POST_END_REPLY', toolCallIds: [], latencyMs: 1 });
      await manager.whenIdle(roomId);
      expect(manager.view(roomId, hostToken).room.status).toBe('ended');
      manager.dispose();
      expect(JSON.stringify(store.loadAll()[0].threads)).not.toContain('POST_END_REPLY');
    } finally { manager.dispose(); }
  });

  it('胜负成立时存活席继续在途旁听并接收终局，结清的出局席不再请求', async () => {
    const g = new TestGame({ deal: DEAL9, values: { 'sheriff.enabled': false } });
    g.night({ kill: 6, inspect: 1 });
    expect(g.hasTool('hunter_shoot')).toBe(true);
    g.removeSeats(2, 3, 8);
    const publicEvent = [...g.events].reverse().find(e => e.audience === 'public')!;
    const { store, record, roomId, hostToken } = savedGame(g);
    record.seats[6].controller = 'ai';
    record.seats[7].controller = 'ai';
    record.threads = [7, 8].map(seat => ({ seat, seen: publicEvent.seq - 1, messages: [] }));
    store.save(record);
    let enter!: (req: DecideRequest) => void;
    const entered = new Promise<DecideRequest>(resolve => { enter = resolve; });
    let release!: (result: DecideResult) => void;
    const delayed = new Promise<DecideResult>(resolve => { release = resolve; });
    const calls: DecideRequest[] = [];
    const adapter: Adapter = { async decide(req) {
      calls.push({ ...req, messages: structuredClone(req.messages) });
      if (calls.length === 1) { enter(req); return delayed; }
      return { ok: true, reply: 'POST_WIN_LISTEN', toolCallIds: [], latencyMs: 1 };
    } };
    const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
    try {
      manager.resumeAll();
      const request = await entered;
      expect(manager.act(roomId, record.seatTokens[5], { decisionId: g.pending!.id, tool: 'hunter_shoot', args: { target: 1 } }).ok).toBe(true);
      expect(request.seat).toBe(7);
      expect(request.signal?.aborted).toBe(false);
      release({ ok: true, reply: 'SURVIVING_INFLIGHT_REPLY', toolCallIds: [], latencyMs: 1 });
      await manager.whenIdle(roomId);
      expect(manager.view(roomId, hostToken).room.status).toBe('ended');
      manager.dispose();
      const threads = store.loadAll()[0].threads!;
      const surviving = JSON.stringify(threads.find(t => t.seat === 7));
      expect(surviving).toContain('SURVIVING_INFLIGHT_REPLY');
      expect(surviving).toContain('游戏结束');
      expect(surviving).toContain('终局复盘');
      expect(calls.some(c => c.seat === 8)).toBe(false);
    } finally { manager.dispose(); }
  });
});
