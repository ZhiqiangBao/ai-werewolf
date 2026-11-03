import { afterEach, expect, it } from 'vitest';
import type { Projection } from '@werewolf/protocol';
import { mockAdapter, mockDecision, type Adapter } from '@werewolf/llm';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

const managers: RoomManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); });

function humanRoom(now: () => number = () => 100_000) {
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0, now });
  managers.push(manager);
  const { roomId, hostToken } = manager.createRoom();
  const setup = manager.updateSetup(roomId, hostToken, {
    presetId: 'mirror12', aiPacingMs: 0, humanTimeoutSec: 60,
    seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' as const })),
  });
  for (const seat of setup.tokens.seats) manager.participate(roomId, seat.token, { ready: true });
  manager.start(roomId, hostToken);
  const views = () => setup.tokens.seats.map(({ seat, token }) => ({ seat, token, p: manager.view(roomId, token).projection as Projection }));
  return { manager, roomId, hostToken, views };
}

it('超时与提交先后竞争时，每个决策只接受一次，暂停期间不触发超时', async () => {
  let now = 100_000;
  const { manager, roomId, hostToken, views } = humanRoom(() => now);
  await manager.whenIdle(roomId);
  const actor = views().find(({ p }) => p.task && !p.task.submitted)!;
  const task = actor.p.task!;
  const action = { decisionId: task.decisionId, ...mockDecision(actor.p, task.tools) };
  manager.control(roomId, hostToken, 'pause');
  now = task.deadline! + 1;
  manager.tick();
  expect(() => manager.act(roomId, actor.token, action)).toThrow('暂停');
  expect(views().find((v) => v.seat === actor.seat)!.p.task?.decisionId).toBe(task.decisionId);
  manager.control(roomId, hostToken, 'resume');
  expect(manager.act(roomId, actor.token, action).ok).toBe(true);
  expect(manager.act(roomId, actor.token, action).error?.code).toBe('STALE_DECISION');
  manager.tick();
  expect(manager.view(roomId, hostToken).projection!.events.filter((e) => e.type === 'action.fallback' && e.payload.reason === 'timeout')).toHaveLength(0);
});

it('超时先结算后，迟到提交和重复 tick 不会再执行原行动', async () => {
  let now = 100_000;
  const { manager, roomId, hostToken, views } = humanRoom(() => now);
  await manager.whenIdle(roomId);
  const actor = views().find(({ p }) => p.task && !p.task.submitted)!;
  const task = actor.p.task!;
  const action = { decisionId: task.decisionId, ...mockDecision(actor.p, task.tools) };
  now = task.deadline!;
  manager.tick();
  expect(manager.act(roomId, actor.token, action).error?.code).toBe('STALE_DECISION');
  const fallback = () => manager.view(roomId, hostToken).projection!.events.filter((e) => e.type === 'action.fallback' && e.payload.reason === 'timeout');
  const count = fallback().length;
  expect(count).toBe(1);
  manager.tick();
  expect(fallback()).toHaveLength(count);
});

it('自爆先于发言提交时，旧发言与重复自爆不能再次改变对局', async () => {
  const { manager, roomId, views } = humanRoom();
  for (let i = 0; i < 300; i++) {
    const all = views();
    const speaker = all.find(({ p }) => p.task && !p.task.submitted && p.task.tools.some((t) => t.name === 'speak'));
    const wolf = all.find(({ seat, p }) => seat !== speaker?.seat && p.interrupts.some((t) => t.name === 'wolf_explode'));
    if (speaker && wolf) {
      const decisionId = speaker.p.task!.decisionId;
      expect(wolf.p.actionWindowId).toBe(decisionId);
      expect(manager.act(roomId, wolf.token, { decisionId, tool: 'wolf_explode', args: {} }).ok).toBe(true);
      expect(manager.act(roomId, speaker.token, { decisionId, tool: 'speak', args: { content: '迟到的发言' } }).error?.code).toBe('STALE_DECISION');
      expect(manager.act(roomId, wolf.token, { decisionId, tool: 'wolf_explode', args: {} }).ok).toBe(false);
      expect(views().find((v) => v.seat === wolf.seat)!.p.me?.alive).toBe(false);
      expect(views().flatMap((v) => v.p.events).some((e) => e.type === 'speech' && e.payload.content === '迟到的发言')).toBe(false);
      return;
    }
    const actor = all.find(({ p }) => p.task && !p.task.submitted)!;
    expect(manager.act(roomId, actor.token, { decisionId: actor.p.task!.decisionId, ...mockDecision(actor.p, actor.p.task!.tools) }).ok).toBe(true);
  }
  throw new Error('没有到达可自爆的发言窗口');
});

it('同一房间重复触发推进时不重复请求在途座位；暂停使迟到结果失效', async () => {
  const requests: { seat: number; resolve: (value: any) => void }[] = [];
  let releaseStep = false;
  const adapter: Adapter = { decide: (req) => releaseStep ? mockAdapter.decide(req) : new Promise((resolve) => { requests.push({ seat: req.seat, resolve }); }) };
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0, adapters: { mock: adapter } });
  managers.push(manager);
  const { roomId, hostToken } = manager.createRoom();
  manager.updateSetup(roomId, hostToken, { aiPacingMs: 0 });
  manager.start(roomId, hostToken);
  for (let i = 0; i < 20 && !requests.length; i++) await Promise.resolve();
  expect(requests.length).toBeGreaterThan(0);
  const initial = requests.length;
  manager.control(roomId, hostToken, 'resume');
  manager.tick();
  manager.control(roomId, hostToken, 'resume');
  await Promise.resolve();
  expect(requests).toHaveLength(initial);
  expect(new Set(requests.map((r) => r.seat)).size).toBe(initial);
  const before = manager.view(roomId, hostToken).projection!;
  manager.control(roomId, hostToken, 'pause');
  await manager.whenIdle(roomId);
  for (const request of requests) request.resolve({ ok: true, call: { tool: 'speak', args: { content: '迟到' } }, toolCallIds: [], latencyMs: 1 });
  await Promise.resolve();
  const after = manager.view(roomId, hostToken).projection!;
  expect(after.events).toEqual(before.events);
  expect(manager.view(roomId, hostToken).room.paused).toBe(true);
  releaseStep = true;
  manager.control(roomId, hostToken, 'step');
  await manager.whenIdle(roomId);
  expect(manager.audit(roomId, hostToken).length).toBeGreaterThan(0);
  expect(manager.view(roomId, hostToken).room.paused).toBe(true);
});

it('暂停与单步不接受自爆；恢复后同窗口仅执行一次，并使旧发言超时失效', async () => {
  let now = 100_000;
  const { manager, roomId, hostToken, views } = humanRoom(() => now);
  for (let i = 0; i < 300; i++) {
    const all = views();
    const speaker = all.find(({ p }) => p.task && !p.task.submitted && p.task.tools.some((t) => t.name === 'speak'));
    const wolf = all.find(({ seat, p }) => seat !== speaker?.seat && p.interrupts.some((t) => t.name === 'wolf_explode'));
    if (speaker && wolf) {
      const decisionId = speaker.p.task!.decisionId;
      const explode = { decisionId, tool: 'wolf_explode', args: {} };
      manager.control(roomId, hostToken, 'pause');
      now = speaker.p.task!.deadline! + 1;
      manager.tick();
      expect(() => manager.act(roomId, wolf.token, explode)).toThrow('对局已暂停');
      manager.control(roomId, hostToken, 'step');
      await manager.whenIdle(roomId);
      expect(views().find((v) => v.seat === speaker.seat)!.p.task?.decisionId).toBe(decisionId);
      manager.control(roomId, hostToken, 'resume');
      expect(manager.act(roomId, wolf.token, explode).ok).toBe(true);
      expect(manager.act(roomId, wolf.token, explode).ok).toBe(false);
      manager.tick();
      expect(manager.view(roomId, hostToken).projection!.events.some((e) => e.type === 'action.fallback')).toBe(false);
      expect(manager.act(roomId, speaker.token, { decisionId, tool: 'speak', args: { content: '旧窗口的迟到发言' } }).ok).toBe(false);
      return;
    }
    const actor = all.find(({ p }) => p.task && !p.task.submitted)!;
    manager.act(roomId, actor.token, { decisionId: actor.p.task!.decisionId, ...mockDecision(actor.p, actor.p.task!.tools) });
    await manager.whenIdle(roomId);
  }
  throw new Error('没有到达可自爆的发言窗口');
});
