import { expect, it } from 'vitest';
import { buildRules, createGame, seatTools } from '@werewolf/engine';
import { mockAdapter, mockDecision, type Adapter, type DecideRequest } from '@werewolf/llm';
import type { GameEvent, GodProjection, Projection, ToolCall } from '@werewolf/protocol';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

it('私密行动的推进间隔只发给当前行动人和房主，其他席位不能通过订阅或提交探测', async () => {
  let now = 1_000_000;
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0, now: () => now });
  const { roomId, hostToken } = manager.createRoom();
  const timing = { speech: { limitSec: 90, intervalMs: 1000 }, vote: { limitSec: 90, intervalMs: 1000 }, skill: { limitSec: 90, intervalMs: 1000 } };
  const setup = manager.updateSetup(roomId, hostToken, { presetId: 'merchant12', timing,
    seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' as const })) });
  for (const { token } of setup.tokens.seats) manager.participate(roomId, token, { ready: true });
  const token = (seat: number) => setup.tokens.seats[seat - 1].token;
  const view = (seat: number) => manager.view(roomId, token(seat));
  try {
    manager.start(roomId, hostToken);
    const roles = (manager.view(roomId, hostToken).projection as GodProjection).god.roles;
    const merchant = roles.find((p) => p.role === 'miracle_merchant')!.seat;
    const guard = roles.find((p) => p.role === 'guard')!.seat;
    const observer = roles.find((p) => p.role === 'villager')!.seat;
    let merchantUpdates = 0, observerUpdates = 0, spectatorUpdates = 0;
    manager.subscribe(roomId, token(merchant), () => { merchantUpdates++; });
    manager.subscribe(roomId, token(observer), () => { observerUpdates++; });
    manager.subscribe(roomId, setup.tokens.spectator, () => { spectatorUpdates++; });
    merchantUpdates = observerUpdates = spectatorUpdates = 0;

    const badCall = { decisionId: 'unknown', tool: 'speak', args: { content: '过' } };
    const before = manager.act(roomId, token(observer), badCall);
    observerUpdates = 0;
    expect(manager.act(roomId, token(merchant), { decisionId: view(merchant).projection!.task!.decisionId,
      tool: 'merchant_gift_guard', args: { targetSeat: guard } })).toEqual({ ok: true });
    expect(observerUpdates).toBe(0);
    expect(spectatorUpdates).toBe(0);
    expect(manager.act(roomId, token(observer), badCall)).toEqual(before);
    const guardTask = view(guard).projection!.task!;
    expect(manager.act(roomId, token(observer), { decisionId: guardTask.decisionId, tool: 'guard_skip', args: {} }))
      .toMatchObject({ ok: false, error: { code: 'NOT_YOUR_TURN' } });
    expect(() => manager.act(roomId, token(guard), { decisionId: guardTask.decisionId, tool: 'guard_skip', args: {} }))
      .toThrow('推进间隔尚未结束');
    observerUpdates = 0;
    expect(view(guard).presentation?.actionAvailableAt).toBe(now + 1000);
    expect(manager.view(roomId, hostToken).presentation?.actionAvailableAt).toBe(now + 1000);
    expect(view(merchant).presentation?.actionAvailableAt).toBeUndefined();
    expect(view(observer).presentation?.actionAvailableAt).toBeUndefined();
    expect(manager.view(roomId, setup.tokens.spectator).presentation?.actionAvailableAt).toBeUndefined();
    expect(observerUpdates).toBe(0);
    expect(spectatorUpdates).toBe(0);

    merchantUpdates = 0;
    now += 1001;
    expect(manager.act(roomId, token(guard), { decisionId: view(guard).projection!.task!.decisionId,
      tool: 'guard_skip', args: {} })).toEqual({ ok: true });
    expect(merchantUpdates).toBe(0);
    expect(observerUpdates).toBe(0);
    expect(spectatorUpdates).toBe(0);
    expect(view(merchant).presentation?.actionAvailableAt).toBeUndefined();
  } finally {
    manager.dispose();
    await manager.whenDisposed();
  }
});

it('奇迹商人房间恢复未用和已用能力，并保留双守的跨夜限制和私密边界', async () => {
  const store = new MemoryStore();
  const secrets = SecretBox.ephemeral();
  const load = () => new RoomManager({ store, secrets, tickMs: 0 });
  let manager = load();
  const { roomId, hostToken } = manager.createRoom();
  const setup = manager.updateSetup(roomId, hostToken, {
    presetId: 'merchant12', aiPacingMs: 0, humanTimeoutSec: 0,
    seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' as const })),
  });
  const tokens = setup.tokens.seats;
  for (const { token } of tokens) manager.participate(roomId, token, { ready: true });
  const god = () => manager.view(roomId, hostToken).projection as GodProjection;
  const view = (seat: number) => manager.view(roomId, tokens[seat - 1].token).projection!;
  const record = () => store.loadAll()[0];
  const reload = async () => {
    manager.dispose();
    expect((await manager.whenDisposed()).durable).toBe(true);
    manager = load();
    manager.resumeAll();
    await manager.whenIdle(roomId);
  };
  const act = (seat: number, call: ToolCall) => manager.act(roomId, tokens[seat - 1].token,
    { decisionId: view(seat).task!.decisionId, ...call });
  const advance = (until: () => boolean) => {
    for (let i = 0; i < 300 && !until(); i++) {
      const pending = god().god.pending!;
      const actor = pending.actors.find((entry) => !entry.submitted)!.seat;
      const projection = view(actor);
      const names = projection.task!.tools.map((tool) => tool.name);
      const skip = ['wolf_empty_kill', 'witch_skip', 'sheriff_stay_off', 'vote_abstain', 'sheriff_abstain', 'wolf_decline_explode']
        .find((name) => names.includes(name));
      const talk = names.find((name) => name === 'speak' || name === 'wolf_discuss');
      const call = skip ? { tool: skip, args: {} } : talk ? { tool: talk, args: { content: '过。' } } : mockDecision(projection, projection.task!.tools);
      expect(act(actor, call)).toEqual({ ok: true });
    }
    expect(until()).toBe(true);
  };
  try {
    expect(manager.start(roomId, hostToken).status).toBe('running');
    const merchantSeat = god().god.roles.find((player) => player.role === 'miracle_merchant')!.seat;
    const guardSeat = god().god.roles.find((player) => player.role === 'guard')!.seat;
    const bystander = tokens.find(({ seat }) => seat !== merchantSeat && seat !== guardSeat)!.seat;
    await reload();
    const initialTools = seatTools(record().state!, guardSeat);

    expect(act(merchantSeat, { tool: 'merchant_gift_guard', args: { targetSeat: guardSeat } })).toEqual({ ok: true });
    expect(act(guardSeat, { tool: 'guard_protect', args: { targetSeat: 3 } })).toEqual({ ok: true });
    advance(() => view(guardSeat).task?.tools.some((tool) => tool.name === 'lucky_guard') === true);
    const before = view(guardSeat);
    const gift = before.events.find((event) => event.type === 'merchant.gift.received')!;
    const receipt = view(merchantSeat).events.find((event) => event.type === 'merchant.gift')!;
    expect(gift).toBeDefined();
    expect(receipt.audience).toEqual([merchantSeat]);
    expect(before.events.some((event) => event.type === 'merchant.gift')).toBe(false);
    expect(gift.audience).toEqual([guardSeat]);
    expect(gift.payload).toEqual({ skill: 'guard', activeFromNight: 1 });
    expect(gift).not.toHaveProperty('round');
    expect(gift.text).not.toContain(`${merchantSeat}号`);
    expect(JSON.stringify(gift)).not.toContain('miracle_merchant');
    expect(view(bystander).events.some((event) => event.type.startsWith('merchant.gift'))).toBe(false);
    expect((manager.view(roomId, setup.tokens.spectator).projection as Projection).events.some((event) => event.type.startsWith('merchant.gift'))).toBe(false);
    const pending = before.task;
    await reload();
    expect(view(guardSeat).task).toEqual(pending);
    expect(view(guardSeat).events.filter((event) => event.type === 'merchant.gift.received')).toEqual([gift]);
    expect(seatTools(record().state!, guardSeat)).toEqual(initialTools);
    expect(act(guardSeat, { tool: 'lucky_guard', args: { targetSeat: 7 } })).toEqual({ ok: true });
    await reload();
    const use = view(guardSeat).events.find((event) => event.type === 'lucky.guard')!;
    expect(use.audience).toEqual([guardSeat]);
    expect(use.round).toMatchObject({ actorSeatId: guardSeat, targetSeatId: 7 });
    const ability = record().state!.players[guardSeat - 1].abilities!.find((item) => item.definition === 'lucky_guard')!;
    expect(ability.state).toMatchObject({ used: { night: 1, target: 7 } });
    expect(seatTools(record().state!, guardSeat)).toEqual(initialTools);
    const privateExport = manager.exportRecord(roomId, hostToken, 'god') as { events: GameEvent[] };
    const publicExport = manager.exportRecord(roomId, hostToken, 'public') as Projection;
    const withoutSeq = ({ seq: _seq, ...event }: GameEvent) => event;
    const exportedEvents = privateExport.events.map(withoutSeq);
    expect(exportedEvents).toContainEqual(withoutSeq(gift));
    expect(exportedEvents).toContainEqual(withoutSeq(receipt));
    expect(exportedEvents).toContainEqual(withoutSeq(use));
    expect(publicExport).toEqual(manager.view(roomId, setup.tokens.spectator).projection);
    expect(publicExport.events.some((event) => event.type.startsWith('merchant.gift'))).toBe(false);
    expect(() => manager.exportRecord(roomId, setup.tokens.spectator, 'god')).toThrow();

    advance(() => god().day === 2 && view(guardSeat).task?.tools.some((tool) => tool.name === 'guard_protect') === true);
    const guard = view(guardSeat).task!.tools.find((tool) => tool.name === 'guard_protect')!;
    const targets = guard.params.find((param) => param.name === 'targetSeat');
    expect(targets?.kind === 'seat' && targets.options).not.toContain(3);
    expect(targets?.kind === 'seat' && targets.options).not.toContain(7);
    expect(act(guardSeat, { tool: 'guard_protect', args: { targetSeat: 3 } }).ok).toBe(false);
    expect(act(guardSeat, { tool: 'guard_protect', args: { targetSeat: 7 } }).ok).toBe(false);
    expect(act(guardSeat, { tool: 'guard_protect', args: { targetSeat: 6 } })).toEqual({ ok: true });
    advance(() => god().day === 2 && god().phase === 'day');
    expect(god().events.filter((event) => event.type === 'merchant.gift.received')).toHaveLength(1);
    expect(god().events.filter((event) => event.type === 'lucky.guard')).toHaveLength(1);
  } finally {
    manager.dispose();
    await manager.whenDisposed();
  }
});

it('模型席获赐前后的固定工具与开局系统消息不变，私信只进入本人对话', async () => {
  const store = new MemoryStore();
  const secrets = SecretBox.ephemeral();
  const calls: Pick<DecideRequest, 'projection' | 'messages' | 'tools' | 'toolChoice'>[] = [];
  const adapter: Adapter = {
    async decide(req) {
      calls.push(structuredClone({ projection: req.projection, messages: req.messages, tools: req.tools, toolChoice: req.toolChoice }));
      const result = await mockAdapter.decide(req);
      if (req.toolChoice !== 'auto' && req.projection?.task?.tools.some((tool) => tool.name === 'lucky_inspect')) {
        result.call = { tool: 'lucky_inspect', args: { targetSeat: 3 } };
      }
      return result;
    },
  };
  const load = () => new RoomManager({ store, secrets, tickMs: 0, adapters: { mock: adapter } });
  let manager = load();
  const { roomId, hostToken } = manager.createRoom();
  const setup = manager.updateSetup(roomId, hostToken, {
    presetId: 'merchant12', aiPacingMs: 0, humanTimeoutSec: 0,
    seats: Array.from({ length: 12 }, (_, i) => i === 1
      ? { seat: i + 1, adapter: 'mock' as const, model: 'synthetic-model' }
      : { seat: i + 1, controller: 'human' as const }),
  });
  for (const { seat, token } of setup.tokens.seats) if (seat !== 2) manager.participate(roomId, token, { ready: true });
  const view = (seat: number) => manager.view(roomId, setup.tokens.seats[seat - 1].token).projection!;
  try {
    manager.dispose();
    expect((await manager.whenDisposed()).durable).toBe(true);
    const initial = store.loadAll()[0];
    const rules = buildRules('merchant12');
    const seed = 'merchant-model-checkpoint';
    const { state, events } = createGame({ id: roomId, rules, seed, names: setup.seats.map((seat) => seat.name),
      deal: ['miracle_merchant', 'villager', 'villager', 'seer', 'witch', 'guard', 'villager', 'villager', 'werewolf', 'werewolf', 'werewolf', 'wolf_king'] });
    const initialTools = seatTools(state, 2);
    store.save({ ...initial, status: 'running', seed, state, events, rules });
    manager = load();
    manager.resumeAll();
    await manager.whenIdle(roomId);
    manager.dispose();
    expect((await manager.whenDisposed()).durable).toBe(true);
    const openingSystem = store.loadAll()[0].threads!.find((thread) => thread.seat === 2)!.messages[0];
    manager = load();
    manager.resumeAll();
    await manager.whenIdle(roomId);
    const merchant = view(1).task!;
    expect(manager.act(roomId, setup.tokens.seats[0].token,
      { decisionId: merchant.decisionId, tool: 'merchant_gift_inspect', args: { targetSeat: 2 } })).toEqual({ ok: true });
    for (let i = 0; i < 300; i++) {
      await manager.whenIdle(roomId);
      if (calls.some((call) => call.toolChoice !== 'auto' && call.projection?.task?.tools.some((tool) => tool.name === 'lucky_inspect')) &&
          calls.some((call) => call.projection?.day === 1 && call.projection.phase === 'day')) break;
      const pending = (manager.view(roomId, hostToken).projection as GodProjection).god.pending!;
      const actor = pending.actors.find((entry) => !entry.submitted && entry.seat !== 2);
      expect(actor).toBeDefined();
      const projection = view(actor!.seat);
      const names = projection.task!.tools.map((tool) => tool.name);
      const skip = ['wolf_empty_kill', 'witch_skip', 'guard_skip', 'sheriff_stay_off', 'vote_abstain', 'sheriff_abstain', 'wolf_decline_explode']
        .find((name) => names.includes(name));
      const talk = names.find((name) => name === 'speak' || name === 'wolf_discuss');
      const call = skip ? { tool: skip, args: {} } : talk ? { tool: talk, args: { content: '过。' } } : mockDecision(projection, projection.task!.tools);
      expect(manager.act(roomId, setup.tokens.seats[actor!.seat - 1].token,
        { decisionId: projection.task!.decisionId, ...call })).toEqual({ ok: true });
    }
    const lucky = calls.find((call) => call.toolChoice !== 'auto' && call.projection?.task?.tools.some((tool) => tool.name === 'lucky_inspect'))!;
    const later = calls.find((call) => call.projection?.day === 1 && call.projection.phase === 'day')!;
    expect(lucky).toBeDefined();
    expect(later).toBeDefined();
    expect(lucky.tools).toEqual(initialTools);
    expect(later.tools).toEqual(initialTools);
    expect(lucky.messages[0]).toEqual(openingSystem);
    expect(later.messages[0]).toEqual(openingSystem);
    const gift = view(2).events.find((event) => event.type === 'merchant.gift.received')!;
    expect(lucky.messages.some((message) => message.content?.includes(gift.text))).toBe(true);
    expect(view(3).events.some((event) => event.type === 'merchant.gift.received')).toBe(false);
    expect(view(2).events.some((event) => event.type === 'lucky.inspect')).toBe(true);
    await manager.whenIdle(roomId);
    manager.dispose();
    expect((await manager.whenDisposed()).durable).toBe(true);
    const saved = store.loadAll()[0];
    const savedThread = saved.threads!.find((thread) => thread.seat === 2)!;
    expect(savedThread.messages.filter((message) => message.content?.includes(gift.text))).toHaveLength(1);
    expect(saved.events.filter((event) => event.type === 'merchant.gift.received')).toHaveLength(1);
  } finally {
    manager.dispose();
    await manager.whenDisposed();
  }
});
