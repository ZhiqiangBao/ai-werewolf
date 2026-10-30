import type { GodProjection, Projection, Seat } from '@werewolf/protocol';
import { mockAdapter, mockDecision, type Adapter, type DecideRequest } from '@werewolf/llm';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, RoomManager, SecretBox, type ManagerOptions } from '../src/index';
import { actionLimitSec } from '../src/manager';

const managers: RoomManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
});

function setup(extra: Partial<ManagerOptions> = {}) {
  const store = new MemoryStore();
  const m = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0, ...extra });
  managers.push(m);
  const { roomId, hostToken } = m.createRoom();
  const seatToken = (seat: Seat) => m.getSetup(roomId, hostToken).tokens.seats[seat - 1].token;
  return { m, store, roomId, hostToken, seatToken };
}

function god(m: RoomManager, roomId: string, hostToken: string): GodProjection {
  return m.view(roomId, hostToken).projection as GodProjection;
}

describe('会话：模拟玩家整局', () => {
  for (const presetId of ['classic9', 'standard12', 'idiot12']) {
    it(`${presetId}：无密钥时模拟玩家能打完并产生胜负（SYS-04）`, async () => {
      const { m, roomId, hostToken } = setup();
      m.updateSetup(roomId, hostToken, { presetId, aiPacingMs: 0 });
      m.start(roomId, hostToken);
      await m.whenIdle(roomId);
      const g = god(m, roomId, hostToken);
      expect(g.status).toBe('ended');
      expect(g.result?.winner).toMatch(/good|wolf|draw/);
      const audit = m.audit(roomId, hostToken);
      expect(audit.length).toBeGreaterThan(20);
      expect(audit.every((a) => a.ok)).toBe(true);
    });
  }
});

describe('凭证与信息屏障', () => {
  it('座位凭证拿不到上帝视角、审计和上帝记录（VIS-06）', async () => {
    const { m, roomId, hostToken, seatToken } = setup();
    m.updateSetup(roomId, hostToken, { aiPacingMs: 0 });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    const v = m.view(roomId, seatToken(3));
    expect(v.room.viewer).toBe('seat');
    expect(v.projection?.viewer).toEqual({ kind: 'seat', seat: 3 });
    expect('god' in (v.projection as object)).toBe(false);
    expect(() => m.audit(roomId, seatToken(3))).toThrow(/房主/);
    expect(() => m.exportRecord(roomId, seatToken(3), 'god')).toThrow(/房主/);
    expect(() => m.getSetup(roomId, seatToken(3))).toThrow(/房主/);
    expect(() => m.view(roomId, 'not-a-token')).toThrow(/凭证无效/);
    expect(() => m.act(roomId, seatToken(3), { tool: 'speak', args: { content: 'x' } })).toThrow(/不在进行中|模型控制/);
    const spectator = m.view(roomId, m.getSetup(roomId, hostToken).tokens.spectator);
    expect(spectator.projection?.events.every((e) => e.audience === 'public')).toBe(true);
  });

  it('模型收到的投影与该座位页面的投影完全一致，提示词不含别人的秘密（VIS-09 / VIS-01）', async () => {
    const mismatches: string[] = [];
    let m!: RoomManager;
    let ids!: { roomId: string; seatToken: (s: Seat) => string };
    const capture: Adapter = {
      async decide(req: DecideRequest) {
        const page = m.view(ids.roomId, ids.seatToken(req.seat)).projection as Projection;
        const strip = (p: Projection | undefined) => {
          if (!p) return '';
          const { thoughts: _thoughts, ...rest } = p;
          return JSON.stringify(rest);
        };
        if (strip(page) !== strip(req.projection)) mismatches.push(`${req.seat}号 ${req.projection?.task?.title}`);
        if (req.projection && 'thoughts' in req.projection) mismatches.push(`${req.seat}号的模型投影带了思考`);
        return mockAdapter.decide(req);
      },
    };
    const s = setup({ adapters: { mock: capture } });
    m = s.m;
    ids = s;
    m.updateSetup(s.roomId, s.hostToken, { aiPacingMs: 0 });
    m.start(s.roomId, s.hostToken);
    await m.whenIdle(s.roomId);
    expect(mismatches).toEqual([]);

    const roles = god(m, s.roomId, s.hostToken).god.roles;
    const audit = m.audit(s.roomId, s.hostToken);
    for (const r of roles) {
      const prompts = audit.filter((a) => a.seat === r.seat).map((a) => JSON.stringify(a.messages));
      const all = prompts.join('\n');
      if (r.role !== 'seer') expect(all).not.toContain('查验结果');
      if (r.role !== 'witch') expect(all).not.toContain('狼人今晚选择刀');
      if (r.role !== 'werewolf') expect(all).not.toContain('狼队成员');
      if (r.role !== 'guard') expect(all).not.toContain('你今晚守护了');
    }
  });

  it('密钥只以密文保存，接口、审计和导出里只有掩码', async () => {
    const secret = 'sk-test-SECRET-abcdefghijklmnop';
    const { m, store, roomId, hostToken } = setup();
    const view = m.updateSetup(roomId, hostToken, {
      seats: [{ seat: 1, controller: 'ai', adapter: 'mock', apiKey: secret } as never],
      aiPacingMs: 0,
    });
    expect(view.seats[0].apiKeyMasked).toBe('sk-••••mnop');
    expect(JSON.stringify(view)).not.toContain(secret);
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    m.dispose();
    const dumps = [
      JSON.stringify(store.loadAll()),
      JSON.stringify(m.audit(roomId, hostToken)),
      JSON.stringify(m.exportRecord(roomId, hostToken, 'god')),
      JSON.stringify(m.view(roomId, hostToken)),
      JSON.stringify(m.getSetup(roomId, hostToken)),
    ];
    for (const d of dumps) expect(d).not.toContain(secret);
    expect(JSON.stringify(store.loadAll())).toContain('v1.');
  });
});

describe('真人座位', () => {
  it('真人通过接口提交行动，模型座位等待真人后继续，直到终局', async () => {
    const { m, roomId, hostToken, seatToken } = setup();
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0, seats: [{ seat: 2, controller: 'human' } as never] });
    m.start(roomId, hostToken);
    const tok = seatToken(2);
    for (let i = 0; i < 500; i++) {
      await m.whenIdle(roomId);
      const v = m.view(roomId, tok);
      if (v.room.status === 'ended') break;
      const p = v.projection as Projection;
      expect(p.task && !p.task.submitted).toBe(true);
      expect(p.task!.deadline).toBeGreaterThan(Date.now());
      const call = mockDecision(p, p.task!.tools);
      expect(m.act(roomId, tok, { decisionId: p.task!.decisionId, ...call })).toEqual({ ok: true });
    }
    expect(m.view(roomId, hostToken).room.status).toBe('ended');
  });

  it('过期决策被拒绝；非法行动只回给本人；开局后配置锁定', async () => {
    const { m, roomId, hostToken, seatToken } = setup();
    m.updateSetup(roomId, hostToken, { aiPacingMs: 0, seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' }) as never) });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    const g = god(m, roomId, hostToken);
    const actor = g.god.pending!.actors[0].seat;
    const villager = g.god.roles.find((r) => r.role === 'villager' && r.seat !== actor)!.seat;
    const r = m.act(roomId, seatToken(villager), { tool: 'wolf_kill', args: { target: 1 } });
    expect(r.ok).toBe(false);
    expect(m.act(roomId, seatToken(actor), { decisionId: 'stale', tool: 'x', args: {} }).error?.code).toBe('STALE_DECISION');
    const pub = m.view(roomId, m.getSetup(roomId, hostToken).tokens.spectator).projection!;
    expect(pub.events.some((e) => e.type === 'action.rejected')).toBe(false);
    const mine = m.view(roomId, seatToken(villager)).projection!;
    expect(mine.events.filter((e) => e.type === 'action.rejected')).toHaveLength(1);
    expect(() => m.updateSetup(roomId, hostToken, { aiPacingMs: 5 })).toThrow(/已经开始/);
  });

  it('真人超时后托管，托管说明只发给本人', async () => {
    let now = 1_000_000;
    const { m, roomId, hostToken, seatToken } = setup({ now: () => now });
    m.updateSetup(roomId, hostToken, {
      aiPacingMs: 0,
      humanTimeoutSec: 30,
      seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' }) as never),
    });
    m.start(roomId, hostToken);
    const actor = god(m, roomId, hostToken).god.pending!.actors[0].seat;
    const task = (m.view(roomId, seatToken(actor)).projection as Projection).task!;
    expect(task.deadline).toBe(now + 30_000);
    now += 29_000;
    m.tick();
    expect(god(m, roomId, hostToken).god.pending!.actors[0].submitted).toBe(false);
    now += 2_000;
    m.tick();
    const mine = m.view(roomId, seatToken(actor)).projection!;
    expect(mine.events.some((e) => e.type === 'action.fallback')).toBe(true);
    const other = actor === 1 ? 2 : 1;
    expect(m.view(roomId, seatToken(other)).projection!.events.some((e) => e.type === 'action.fallback')).toBe(false);
  });

  it('发言限时 3 分钟，投票限时 90 秒', async () => {
    expect(actionLimitSec('speech', 30)).toBe(180);
    expect(actionLimitSec('wolf.discuss', 30)).toBe(180);
    expect(actionLimitSec('exile.vote', 30)).toBe(90);
    expect(actionLimitSec('sheriff.vote', 30)).toBe(90);
    expect(actionLimitSec('night:guard', 30)).toBe(30);

    let now = 1_000_000;
    const { m, roomId, hostToken, seatToken } = setup({ now: () => now });
    m.updateSetup(roomId, hostToken, {
      aiPacingMs: 0,
      humanTimeoutSec: 30,
      seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' }) as never),
    });
    m.start(roomId, hostToken);
    const seen = { speech: false, vote: false };
    const checked = new Set<string>();
    for (let i = 0; i < 800 && (!seen.speech || !seen.vote); i++) {
      await m.whenIdle(roomId);
      const pending = god(m, roomId, hostToken).god.pending;
      if (!pending) break;
      const actor = pending.actors.find((a) => !a.submitted);
      if (!actor) break;
      const task = (m.view(roomId, seatToken(actor.seat)).projection as Projection).task!;
      const speech = actor.tools.includes('speak') || actor.tools.includes('wolf_discuss');
      const vote = actor.tools.includes('vote') || actor.tools.includes('sheriff_vote');
      if (!checked.has(pending.decisionId)) {
        checked.add(pending.decisionId);
        const limit = speech ? 180_000 : vote ? 90_000 : 30_000;
        expect(task.deadline).toBe(now + limit);
      }
      if (speech) seen.speech = true;
      if (vote) seen.vote = true;
      if (task.deadline && task.deadline > now) now = task.deadline;
      m.tick();
    }
    expect(seen).toEqual({ speech: true, vote: true });
  });
});

describe('模型调度', () => {
  it('模型发言请求 180 秒，投票请求 90 秒，其余仍是座位时限', async () => {
    const got = { speech: 0, vote: 0, other: 0 };
    const recording: Adapter = {
      async decide(req) {
        const names = req.tools.map((t) => t.name);
        const text = req.messages.map((m) => ('content' in m && m.content ? m.content : '')).join('\n');
        if (names.includes('speak') || names.includes('wolf_discuss')) {
          got.speech = req.config.timeoutSec;
          expect(text).toContain('这一步限时 180 秒');
        } else if (names.includes('vote') || names.includes('sheriff_vote')) {
          got.vote = req.config.timeoutSec;
          expect(text).toContain('这一步限时 90 秒');
        } else if (!got.other) {
          got.other = req.config.timeoutSec;
          expect(text).toContain('这一步限时 60 秒');
        }
        return mockAdapter.decide(req);
      },
    };
    const { m, roomId, hostToken } = setup({ adapters: { mock: recording } });
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    expect(got).toEqual({ speech: 180, vote: 90, other: 60 });
  });

  it('两次非法输出后托管，审计记录每次失败并把错误发回模型', async () => {
    const seen: number[] = [];
    const bad: Adapter = {
      async decide(req) {
        seen.push(req.messages.length);
        return { ok: false, error: '没有调用工具', assistant: { role: 'assistant', content: '我想刀 3 号' }, toolCallIds: [], latencyMs: 1 };
      },
    };
    const { m, roomId, hostToken } = setup({ adapters: { mock: bad } });
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    const audit = m.audit(roomId, hostToken);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => !a.ok)).toBe(true);
    expect(seen.slice(0, 2)).toEqual([2, 4]);
    expect(god(m, roomId, hostToken).status).toBe('ended');
  });

  it('被引擎拒绝的行动带着原因重试一次', async () => {
    let first = true;
    const picky: Adapter = {
      async decide(req) {
        if (first && req.tools.some((t) => t.name === 'speak')) {
          first = false;
          return { ok: true, call: { tool: 'vote', args: { target: 1 } }, assistant: { role: 'assistant', content: null }, toolCallIds: ['c1'], latencyMs: 1 };
        }
        return mockAdapter.decide(req);
      },
    };
    const { m, roomId, hostToken } = setup({ adapters: { mock: picky } });
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    const audit = m.audit(roomId, hostToken);
    const failed = audit.find((a) => !a.ok)!;
    expect(failed.error).toContain('当前不能使用「vote」');
    const retry = audit[audit.indexOf(failed) + 1];
    expect(retry.ok).toBe(true);
    const last = (retry.messages as { role: string; content: string }[]).at(-1)!;
    expect(last.role).toBe('tool');
    expect(last.content).toContain('没有被法官接受');
  });

  it('暂停后不再请求模型，单步只推进一次模型决策', async () => {
    const { m, roomId, hostToken } = setup();
    m.updateSetup(roomId, hostToken, { aiPacingMs: 0 });
    m.start(roomId, hostToken);
    m.control(roomId, hostToken, 'pause');
    await m.whenIdle(roomId);
    const before = m.audit(roomId, hostToken).length;
    const version = god(m, roomId, hostToken).version;
    await new Promise((r) => setTimeout(r, 20));
    expect(god(m, roomId, hostToken).version).toBe(version);
    m.control(roomId, hostToken, 'step');
    await m.whenIdle(roomId);
    const after = m.audit(roomId, hostToken).length;
    expect(after).toBeGreaterThan(before);
    const pending = god(m, roomId, hostToken).god.pending;
    expect(pending).not.toBeNull();
    m.control(roomId, hostToken, 'resume');
    await m.whenIdle(roomId);
    expect(god(m, roomId, hostToken).status).toBe('ended');
  });

  it('订阅只在本视角的内容变化时推送', async () => {
    const { m, roomId, hostToken, seatToken } = setup();
    m.updateSetup(roomId, hostToken, { aiPacingMs: 0 });
    const counts = { host: 0, seat: 0 };
    m.subscribe(roomId, hostToken, () => counts.host++);
    m.subscribe(roomId, seatToken(1), () => counts.seat++);
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    expect(counts.host).toBeGreaterThan(counts.seat);
    expect(counts.seat).toBeGreaterThan(0);
  });

  it('思考和正文只出现在对应视角，不进入任何座位的提示词', async () => {
    const capture: Adapter = {
      async decide(req) {
        req.onDelta?.({ thinking: `思维痕迹ZZZ9-${req.seat}` });
        req.onDelta?.({ reply: `正文痕迹QQQ9-${req.seat}` });
        return mockAdapter.decide(req);
      },
    };
    const { m, roomId, hostToken, seatToken } = setup({ adapters: { mock: capture } });
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    const g = god(m, roomId, hostToken);
    expect(g.thoughts?.some((t) => t.thinking.includes('思维痕迹ZZZ9-1') && t.reply.includes('正文痕迹QQQ9-1'))).toBe(true);
    expect(g.thoughts?.some((t) => t.seat !== 1)).toBe(true);
    expect(JSON.stringify(g.events)).not.toContain('思维痕迹');
    expect(JSON.stringify(g.events)).not.toContain('正文痕迹');
    const prompts = JSON.stringify(m.audit(roomId, hostToken).map((a) => a.messages));
    expect(prompts).not.toContain('思维痕迹');
    expect(prompts).not.toContain('正文痕迹');
    const mine = m.view(roomId, seatToken(1)).projection as Projection;
    expect(mine.thoughts?.every((t) => t.seat === 1)).toBe(true);
    expect(JSON.stringify(mine.thoughts)).toContain('思维痕迹ZZZ9-1');
    expect(JSON.stringify(mine)).not.toContain('思维痕迹ZZZ9-2');
    const spectator = m.view(roomId, m.getSetup(roomId, hostToken).tokens.spectator).projection as Projection;
    expect(spectator.thoughts).toBeUndefined();
    expect(JSON.stringify(spectator)).not.toContain('思维痕迹');
  });

  it('房主终结会取消正在进行的模型请求，并记为流局且不公开身份', async () => {
    let release!: (signal: AbortSignal) => void;
    const entered = new Promise<AbortSignal>((resolve) => {
      release = resolve;
    });
    let settled = 'pending';
    const hanging: Adapter = {
      async decide(req) {
        release(req.signal!);
        await new Promise<void>((_, reject) => {
          const abort = () => {
            settled = 'aborted';
            reject(new Error('aborted'));
          };
          if (req.signal?.aborted) {
            abort();
            return;
          }
          req.signal?.addEventListener('abort', abort, { once: true });
        });
        settled = 'returned';
        return { ok: false, error: '不应返回', toolCallIds: [], latencyMs: 1 };
      },
    };
    const { m, roomId, hostToken, seatToken } = setup({ adapters: { mock: hanging } });
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    const signal = await entered;
    m.control(roomId, hostToken, 'end');
    expect(signal.aborted).toBe(true);
    await m.whenIdle(roomId);
    expect(settled).toBe('aborted');
    const g = god(m, roomId, hostToken);
    expect(g.status).toBe('ended');
    expect(g.result).toMatchObject({ winner: 'draw', reveal: false });
    expect(g.result?.reason).toContain('无胜负');
    expect(g.events.some((e) => e.type === 'review')).toBe(false);
    expect(g.events.some((e) => e.type === 'game.end' && e.text.includes('无胜负'))).toBe(true);
    const seat = m.view(roomId, seatToken(1)).projection as Projection;
    expect(seat.seats.every((s) => !s.revealedRole)).toBe(true);
    expect(seat.events.some((e) => e.type === 'review')).toBe(false);
    expect(() => m.control(roomId, hostToken, 'resume')).toThrow(/不在进行中/);
  });

  it('复制房间保留配置、换掉全部凭证', () => {
    const { m, roomId, hostToken } = setup();
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', seats: [{ seat: 4, controller: 'human', name: '小王' } as never] });
    const copy = m.cloneRoom(roomId, hostToken);
    const a = m.getSetup(roomId, hostToken);
    const b = m.getSetup(copy.roomId, copy.hostToken);
    expect(b.presetId).toBe('classic9');
    expect(b.seats[3]).toMatchObject({ controller: 'human', name: '小王' });
    expect(b.tokens.seats[0].token).not.toBe(a.tokens.seats[0].token);
  });
});
