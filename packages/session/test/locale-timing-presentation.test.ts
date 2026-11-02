import { afterEach, describe, expect, it } from 'vitest';
import { actionKind, defaultGameTiming, type GodProjection, type Projection, type GameTiming, type ToolSpec } from '@werewolf/protocol';
import { createGame, buildRules } from '@werewolf/engine';
import { mockAdapter, mockDecision, type Adapter, type DecideRequest } from '@werewolf/llm';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

const managers: RoomManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); });
const make = (options: Partial<ConstructorParameters<typeof RoomManager>[0]> = {}) => {
  const store = options.store ?? new MemoryStore();
  const manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, ...options });
  managers.push(manager);
  return { manager, store };
};
const kindOf = (tools: ToolSpec[]) => tools.some((t) => t.name === 'speak' || t.name === 'wolf_discuss') ? 'speech' : tools.some((t) => ['vote', 'exile_vote', 'sheriff_vote'].includes(t.name)) ? 'vote' : 'skill';
const timing: GameTiming = { speech: { limitSec: 17, intervalMs: 30 }, vote: { limitSec: 11, intervalMs: 40 }, skill: { limitSec: 7, intervalMs: 20 } };

describe('语言、节奏与页面死因展示', () => {
  it('新房间显示真实默认值；语言、时间的克隆和重载保持一致，非法设置不写入', () => {
    const { manager, store } = make();
    const { roomId, hostToken } = manager.createRoom();
    expect(manager.getSetup(roomId, hostToken)).toMatchObject({ locale: 'zh-CN', timing: defaultGameTiming() });
    manager.updateSetup(roomId, hostToken, { locale: 'ja', timing });
    const clone = manager.cloneRoom(roomId, hostToken);
    expect(manager.getSetup(clone.roomId, clone.hostToken)).toMatchObject({ locale: 'ja', timing });
    expect(() => manager.updateSetup(roomId, hostToken, { locale: 'bad-language', timing })).toThrow('语言');
    expect(() => manager.updateSetup(roomId, hostToken, { timing: { ...timing, speech: { limitSec: 0, intervalMs: 0 } } })).toThrow('时限');
    manager.dispose();
    const restored = make({ store }).manager;
    expect(restored.getSetup(roomId, hostToken)).toMatchObject({ locale: 'ja', timing });
  });

  it('真人的发言、投票和技能使用各自时限；推进间隔内不能抢交，间隔不占行动时限', async () => {
    let now = 100_000;
    const waits: { ms: number; done: () => void }[] = [];
    const { manager } = make({ now: () => now, sleep: (ms) => new Promise<void>((done) => waits.push({ ms, done })) });
    const { roomId, hostToken } = manager.createRoom();
    let setup = manager.updateSetup(roomId, hostToken, { timing, seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' as const })) });
    for (const seat of setup.tokens.seats) manager.participate(roomId, seat.token, { ready: true });
    manager.start(roomId, hostToken); await manager.whenIdle(roomId);
    const seen = new Set<string>();
    for (let step = 0; step < 160 && seen.size < 3; step++) {
      const god = manager.view(roomId, hostToken).projection as GodProjection;
      if (!god.god.pending) break;
      const actor = god.god.pending.actors.find((a) => !a.submitted)!;
      const token = setup.tokens.seats[actor.seat - 1].token;
      const p = manager.view(roomId, token).projection as Projection;
      const kind = kindOf(p.task!.tools); seen.add(kind);
      expect(p.task!.deadline).toBe(now + timing[kind].limitSec * 1000);
      const call = mockDecision(p, p.task!.tools);
      expect(manager.act(roomId, token, { decisionId: p.task!.decisionId, ...call }).ok).toBe(true);
      for (let turn = 0; turn < 12 && !waits.length && manager.view(roomId, hostToken).presentation?.actionAvailableAt; turn++) await Promise.resolve();
      if (!manager.view(roomId, hostToken).presentation?.actionAvailableAt) await manager.whenIdle(roomId);
      if (waits.length) {
        const wait = waits.shift()!;
        expect(wait.ms).toBe(timing[kind].intervalMs);
        const next = manager.view(roomId, hostToken);
        expect(next.presentation?.actionAvailableAt).toBe(now + wait.ms);
        const nextActor = (next.projection as GodProjection).god.pending!.actors[0].seat;
        const nextToken = setup.tokens.seats[nextActor - 1].token;
        const pending = manager.view(roomId, nextToken).projection as Projection;
        expect(pending.task!.deadline).toBeUndefined();
        expect(() => manager.act(roomId, nextToken, { decisionId: pending.task!.decisionId, tool: '', args: {} })).toThrow('推进间隔');
        now += wait.ms; wait.done(); await manager.whenIdle(roomId);
      }
    }
    expect([...seen].sort()).toEqual(['skill', 'speech', 'vote']);
  });

  it('AI 使用相同分类时限和间隔，英语发言上下文完整且不接收页面展示字段', async () => {
    let now = 100_000;
    const requests: DecideRequest[] = [], intervals: number[] = [];
    const adapter: Adapter = { async decide(req) {
      expect(req.projection).not.toHaveProperty('presentation');
      expect(req.projection!.seats.every((s) => !('causes' in s))).toBe(true);
      if (req.toolChoice !== 'auto') {
        requests.push(req);
        const kind = kindOf(req.projection!.task!.tools);
        expect(req.config.timeoutSec).toBe(timing[kind].limitSec);
        expect(req.projection!.task!.deadline).toBe(now + timing[kind].limitSec * 1000);
        expect(req.messages[0].content).toContain('Use English');
      }
      return mockAdapter.decide(req);
    } };
    const { manager } = make({ now: () => now, sleep: async (ms) => { intervals.push(ms); now += ms; }, adapters: { mock: adapter } });
    const { roomId, hostToken } = manager.createRoom({ locale: 'en' });
    manager.updateSetup(roomId, hostToken, { presetId: 'classic9', timing, seats: Array.from({ length: 9 }, (_, i) => ({ seat: i + 1, name: `Name${i + 1}` })) });
    manager.start(roomId, hostToken); await manager.whenIdle(roomId);
    expect(manager.view(roomId, hostToken).room.status).toBe('ended');
    expect(requests.length).toBeGreaterThan(10);
    expect(new Set(intervals)).toEqual(new Set([20, 30, 40]));
  });

  it('上帝得到精确死因，玩家及旁观者仅得到公开分类；展示字段与模型投影分离', () => {
    const { manager, store } = make();
    const { roomId, hostToken } = manager.createRoom();
    const setup = manager.getSetup(roomId, hostToken);
    manager.dispose();
    const record = store.loadAll()[0];
    const rules = buildRules('standard12');
    const { state, events } = createGame({ id: roomId, rules, seed: 'presentation' });
    state.deaths = [
      { seat: 1, day: 1, via: 'night', causes: ['poison'], batch: 1, lastWords: false, hooked: true },
      { seat: 2, day: 1, via: 'night', causes: ['wolf'], batch: 1, lastWords: false, hooked: true },
      { seat: 3, day: 1, via: 'night', causes: ['guard_and_save', 'poison'], batch: 1, lastWords: false, hooked: true },
      { seat: 4, day: 1, via: 'exile', causes: ['exile'], batch: 2, lastWords: false, hooked: true },
      { seat: 5, day: 1, via: 'shot', causes: ['shot'], batch: 2, lastWords: false, hooked: true },
      { seat: 6, day: 1, via: 'explode', causes: ['explode'], batch: 3, lastWords: false, hooked: true },
    ];
    for (const d of state.deaths) state.players[d.seat - 1].alive = false;
    Object.assign(record, { state, rules, events, seed: state.seed, status: 'running', paused: true }); store.save(record);
    const loaded = make({ store }).manager;
    expect(loaded.view(roomId, hostToken).presentation!.deaths.map((d) => d.causes)).toEqual([['poison'], ['wolf'], ['guard_and_save', 'poison'], ['exile'], ['shot'], ['explode']]);
    for (const token of [setup.tokens.seats[0].token, setup.tokens.spectator]) {
      const view = loaded.view(roomId, token);
      expect(view.presentation!.deaths.map((d) => d.causes)).toEqual([['night'], ['night'], ['night'], ['exile'], ['shot'], ['explode']]);
      expect(view.projection).not.toHaveProperty('presentation');
      expect(view.projection!.seats.every((s) => !('causes' in s))).toBe(true);
    }
    expect(actionKind('wolf.discuss')).toBe('speech');
  });
});
