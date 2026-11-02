import { afterEach, expect, it } from 'vitest';
import { actionKind, defaultGameTiming, type Projection } from '@werewolf/protocol';
import { mockDecision, type Adapter } from '@werewolf/llm';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

const managers: RoomManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); });

function humanRoom(options: Partial<ConstructorParameters<typeof RoomManager>[0]> = {}) {
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0, ...options });
  managers.push(manager);
  const { roomId, hostToken } = manager.createRoom();
  const timing = defaultGameTiming();
  for (const value of Object.values(timing)) value.intervalMs = 0;
  const setup = manager.updateSetup(roomId, hostToken, { timing, seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' as const })) });
  for (const seat of setup.tokens.seats) manager.participate(roomId, seat.token, { ready: true });
  manager.start(roomId, hostToken);
  const views = () => setup.tokens.seats.map((s) => ({ seat: s.seat, token: s.token, p: manager.view(roomId, s.token).projection as Projection }));
  const live = (manager as any).rooms.get(roomId);
  return { manager, roomId, hostToken, views, live };
}

it('暂停冻结间隔，单步不会清除真人等待的间隔，恢复后仍阻止提前提交，结束清理间隔', async () => {
  let now = 100_000;
  const waits: (() => void)[] = [];
  const { manager, roomId, hostToken, views, live } = humanRoom({ now: () => now, sleep: () => new Promise<void>((done) => waits.push(done)) });
  await manager.whenIdle(roomId);
  for (const value of Object.values(live.rec.timing) as { intervalMs: number }[]) value.intervalMs = 1200;
  const first = views().find((v) => v.p.task && !v.p.task.submitted)!;
  manager.act(roomId, first.token, { decisionId: first.p.task!.decisionId, ...mockDecision(first.p, first.p.task!.tools) });
  expect(live.rec.actionAvailableAt).toBe(101_200);
  now += 400;
  manager.control(roomId, hostToken, 'pause');
  waits.splice(0).forEach((done) => done());
  await manager.whenIdle(roomId);
  now += 5000;
  expect(() => manager.control(roomId, hostToken, 'step')).toThrow('推进间隔尚未结束');
  expect(live.rec.actionAvailableAt).toBe(101_200);
  manager.control(roomId, hostToken, 'resume');
  expect(live.rec.actionAvailableAt).toBe(106_200);
  const next = views().find((v) => v.p.task && !v.p.task.submitted)!;
  expect(() => manager.act(roomId, next.token, { decisionId: next.p.task!.decisionId, ...mockDecision(next.p, next.p.task!.tools) })).toThrow('推进间隔');
  expect(next.p.task!.deadline).toBeUndefined();
  now += 800;
  waits.splice(0).forEach((done) => done());
  await manager.whenIdle(roomId);
  expect(views().find((v) => v.seat === next.seat)!.p.task!.deadline).toBe(now + live.rec.timing[actionKind(live.rec.state.pending.step.type)].limitSec * 1000);
  manager.act(roomId, next.token, { decisionId: next.p.task!.decisionId, ...mockDecision(next.p, next.p.task!.tools) });
  expect(live.rec.actionAvailableAt).toBeDefined();
  manager.control(roomId, hostToken, 'end');
  expect(manager.view(roomId, hostToken).presentation?.actionAvailableAt).toBeUndefined();
  waits.splice(0).forEach((done) => done());
});

it('迟到的旁听打断在间隔内获得工具错误回执，不暂停对局', async () => {
  let finish!: (result: any) => void;
  const adapter: Adapter = { decide: () => new Promise((resolve) => { finish = resolve; }) };
  const { manager, roomId, hostToken, views, live } = humanRoom({ adapters: { mock: adapter }, sleep: () => new Promise<void>(() => {}) });
  await manager.whenIdle(roomId);
  for (let i = 0; i < 300; i++) {
    const all = views();
    const speaker = all.find((v) => v.p.task && !v.p.task.submitted && v.p.task.tools.some((t) => t.name === 'speak'));
    const wolf = all.find((v) => v.seat !== speaker?.seat && v.p.interrupts.some((t) => t.name === 'wolf_explode'));
    if (speaker && wolf) {
      const receive = (manager as any).receive(live, wolf.seat, speaker.p.task!.decisionId);
      live.rec.timing.speech.intervalMs = 60_000;
      manager.act(roomId, speaker.token, { decisionId: speaker.p.task!.decisionId, tool: 'speak', args: { content: '发言结束。' } });
      expect(views().find((v) => v.seat === wolf.seat)!.p.interrupts.some((t) => t.name === 'wolf_explode')).toBe(true);
      finish({ ok: true, call: { tool: 'wolf_explode', args: {} }, assistant: { role: 'assistant', content: null }, toolCallIds: ['late'], latencyMs: 1 });
      await receive;
      expect(live.rec.paused).toBe(false);
      expect(manager.audit(roomId, hostToken).some((row) => row.seat === wolf.seat && row.error?.includes('推进间隔'))).toBe(true);
      expect(live.rec.threads.find((t: any) => t.seat === wolf.seat).messages.some((m: any) => m.role === 'tool' && m.callId === 'late' && m.isError && m.content.includes('推进间隔'))).toBe(true);
      manager.control(roomId, hostToken, 'end');
      return;
    }
    const actor = all.find((v) => v.p.task && !v.p.task.submitted)!;
    manager.act(roomId, actor.token, { decisionId: actor.p.task!.decisionId, ...mockDecision(actor.p, actor.p.task!.tools) });
    await manager.whenIdle(roomId);
  }
  throw Error('没有到达可打断的发言窗口');
});

it('暂停期间重载房间后仍保留推进间隔的剩余时间', async () => {
  let now = 20_000;
  const store = new MemoryStore();
  const waits: (() => void)[] = [];
  const { manager, roomId, hostToken, views, live } = humanRoom({ store, now: () => now, sleep: () => new Promise<void>((done) => waits.push(done)) });
  await manager.whenIdle(roomId);
  for (const value of Object.values(live.rec.timing) as { intervalMs: number }[]) value.intervalMs = 1200;
  const actor = views().find((v) => v.p.task && !v.p.task.submitted)!;
  manager.act(roomId, actor.token, { decisionId: actor.p.task!.decisionId, ...mockDecision(actor.p, actor.p.task!.tools) });
  now += 400;
  manager.control(roomId, hostToken, 'pause');
  waits.splice(0).forEach((done) => done());
  await manager.whenIdle(roomId);
  manager.dispose();
  now += 30_000;
  const restored = new RoomManager({ store, secrets: SecretBox.ephemeral(), now: () => now, tickMs: 0, sleep: () => new Promise<void>(() => {}) });
  managers.push(restored);
  restored.control(roomId, hostToken, 'resume');
  expect(restored.view(roomId, hostToken).presentation?.actionAvailableAt).toBe(now + 800);
  restored.control(roomId, hostToken, 'end');
});


it('暂停保留已用时，重载后恢复每席剩余行动时限', async () => {
  let now = 100_000;
  const store = new MemoryStore();
  const { manager, roomId, hostToken, views, live } = humanRoom({ store, now: () => now });
  await manager.whenIdle(roomId);
  const actor = views().find((v) => v.p.task && !v.p.task.submitted)!;
  const deadline = actor.p.task!.deadline!;
  now += 15_000;
  manager.control(roomId, hostToken, 'pause');
  manager.dispose();
  now += 60_000;
  const restored = new RoomManager({ store, secrets: SecretBox.ephemeral(), now: () => now, tickMs: 0 });
  managers.push(restored);
  restored.control(roomId, hostToken, 'resume');
  const task = (restored.view(roomId, actor.token).projection as Projection).task!;
  expect(task.deadline).toBe(now + deadline - 115_000);
  expect(live.rec.deadlineRemainingMs).toBeDefined();
  restored.control(roomId, hostToken, 'end');
});

it('暂停取消在途行动，迟到的工具结果不执行也不触发托管，单步可重新执行', async () => {
  let finish!: (result: any) => void;
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  let calls = 0;
  const adapter: Adapter = { decide: (req) => {
    calls++;
    if (calls === 1) { requested(); return new Promise((resolve) => { finish = resolve; }); }
    return Promise.resolve({ ok: true, call: mockDecision(req.projection!, req.tools), toolCallIds: [], latencyMs: 1 });
  } };
  const { manager, roomId, hostToken, views, live } = humanRoom({ adapters: { mock: adapter } });
  await manager.whenIdle(roomId);
  const actor = views().find((v) => v.p.task && !v.p.task.submitted)!;
  live.rec.seats[actor.seat - 1].controller = 'ai';
  (manager as any).syncThread(live, actor.seat);
  const decision = actor.p.task!.decisionId;
  const pending = (manager as any).runAi(live, actor.seat, decision);
  await started;
  const count = live.rec.actions.length;
  manager.control(roomId, hostToken, 'pause');
  await pending;
  finish({ ok: true, call: mockDecision(actor.p, actor.p.task!.tools), toolCallIds: [], latencyMs: 1 });
  await Promise.resolve();
  expect(live.rec.actions).toHaveLength(count);
  expect(live.rec.actions.some((a: any) => a.autoReason === 'request_failed')).toBe(false);
  manager.control(roomId, hostToken, 'step');
  await manager.whenIdle(roomId);
  expect(live.rec.actions.length).toBeGreaterThan(count);
  expect(live.rec.paused).toBe(true);
  manager.control(roomId, hostToken, 'end');
});
