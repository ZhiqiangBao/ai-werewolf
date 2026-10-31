import type { GodProjection, GameEvent, Projection, Seat } from '@werewolf/protocol';
import { mockAdapter, mockDecision, type Adapter, type ChatMessage, type DecideRequest } from '@werewolf/llm';
import { afterEach, describe, expect, it } from 'vitest';
import { syncThread } from '../src/agent';
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
        expect(names).toContain('speak');
        expect(names).toContain('vote');
        if (req.toolChoice === 'auto') return mockAdapter.decide(req);
        const text = req.messages.map((m) => ('content' in m && m.content ? m.content : '')).join('\n');
        const taskNames = req.projection?.task?.tools.map((t) => t.name) ?? [];
        if (taskNames.includes('speak') || taskNames.includes('wolf_discuss')) got.speech = req.config.timeoutSec;
        else if (taskNames.includes('vote') || taskNames.includes('sheriff_vote')) got.vote = req.config.timeoutSec;
        else if (!got.other) got.other = req.config.timeoutSec;
        expect(text).toContain('发言限时 180 秒');
        expect(text).toContain('技能限时 90 秒');
        return mockAdapter.decide(req);
      },
    };
    const { m, roomId, hostToken } = setup({ adapters: { mock: recording } });
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    expect(got.speech).toBeCloseTo(180, 1);
    expect(got.vote).toBeCloseTo(90, 1);
    expect(got.other).toBeCloseTo(90, 1);
  });

  it('五次非法输出后托管，审计记录每次失败并把错误发回模型', async () => {
    const seen: number[] = [];
    const bad: Adapter = {
      async decide(req) {
        if (req.toolChoice === 'auto') return { ok: true, assistant: { role: 'assistant', content: '' }, toolCallIds: [], latencyMs: 1 };
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
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen.slice(0, 5)).toEqual([0, 1, 2, 3, 4].map((i) => seen[0] + i * 2));
    expect(god(m, roomId, hostToken).status).toBe('ended');
  });

  it('被引擎拒绝的行动带着原因重试一次', async () => {
    let first = true;
    const picky: Adapter = {
      async decide(req) {
        if (first && req.toolChoice !== 'auto' && req.projection?.task?.tools.some((t) => t.name === 'speak')) {
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
    const retry = audit.filter((a) => a.seat === failed.seat)[audit.filter((a) => a.seat === failed.seat).indexOf(failed) + 1];
    expect(retry.ok).toBe(true);
    const last = (retry.messages as { role: string; content: string }[]).at(-1)!;
    expect(last.role).toBe('tool');
    expect(last.content).toContain('工具调用错误，请调用正确工具。');
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

  it('同一座位下一轮只在上一轮消息后面追加', async () => {
    const { m, roomId, hostToken } = setup();
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    const audit = m.audit(roomId, hostToken);
    const bySeat = new Map<number, unknown[][]>();
    for (const row of audit) {
      if (!row.messages) continue;
      const list = bySeat.get(row.seat) ?? [];
      list.push(row.messages as unknown[]);
      bySeat.set(row.seat, list);
    }
    expect(bySeat.size).toBeGreaterThan(0);
    for (const rows of bySeat.values()) {
      for (const messages of rows) expect(JSON.stringify(messages)).not.toContain('存活（');
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const next = rows[i];
        expect(next.length).toBeGreaterThan(prev.length);
        expect(prev.every((message, k) => JSON.stringify(message) === JSON.stringify(next[k]))).toBe(true);
      }
    }
    const events = god(m, roomId, hostToken).events;
    const chat = events.find((e) => e.type === 'wolf.chat' && Array.isArray(e.audience));
    expect(chat).toBeTruthy();
    const wolves = chat!.audience as number[];
    const outsider = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((seat) => !wolves.includes(seat))!;
    const blob = (seat: number) => (bySeat.get(seat) ?? []).map((messages) => JSON.stringify(messages)).join('\n');
    expect(blob(wolves[0])).toContain('狼队密谈');
    expect(blob(outsider)).not.toContain('狼队密谈');
    const speech = events.find((e) => e.type === 'speech' && e.payload.kind === 'discussion');
    expect(speech).toBeTruthy();
    const speaker = speech!.payload.seat as number;
    const text = speech!.payload.content as string;
    const said = JSON.stringify(bySeat.get(speaker)!.at(-1));
    expect(said).toContain(text);
    expect(said).not.toContain(`${speaker}号发言：${text}`);
    const listener = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((seat) => seat !== speaker)!;
    expect(blob(listener)).toContain(`${speaker}号发言：${text}`);
    const roles = god(m, roomId, hostToken).god.roles;
    const seer = roles.find((r) => r.role === 'seer')!.seat;
    const seerText = blob(seer);
    expect(seerText.indexOf('天黑请闭眼')).toBeGreaterThan(-1);
    expect(seerText.indexOf('你现在可以使用查验工具。')).toBeGreaterThan(seerText.indexOf('天黑请闭眼'));
    const witch = roles.find((r) => r.role === 'witch')!.seat;
    const witchText = blob(witch);
    expect(witchText).toContain('你现在可以使用用药工具。');
    expect(witchText).not.toMatch(/狼人今晚选择刀[^\n]*\n不要调用工具/);
    expect(witchText).not.toMatch(/狼人今晚没有落刀。\n不要调用工具/);
    const signupText = blob(1);
    expect(signupText).toContain('你现在可以使用上警与否工具。');
    expect(signupText).not.toContain('开始竞选警长。\n不要调用工具。');
    const lastOf = (row: (typeof audit)[number]) => {
      const messages = (row.messages ?? []) as { content?: string }[];
      return messages.filter((m) => m.content).at(-1)?.content ?? '';
    };
    for (const seat of new Set(audit.map((row) => row.seat))) {
      expect(audit.some((row) => row.seat === seat && lastOf(row).includes('天黑请闭眼') && lastOf(row).includes('不要调用工具'))).toBe(true);
    }
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

  it('旁听误调普通工具只返回私有反馈，不生成会被再次旁听的拒绝事件', async () => {
    let trapped = false;
    let trappedSeat = 0;
    const adapter: Adapter = {
      async decide(req) {
        if (!trapped && req.toolChoice === 'auto') {
          trapped = true;
          trappedSeat = req.seat;
          return { ok: true, call: { tool: 'vote', args: { target: 1 } }, assistant: { role: 'assistant', content: null }, toolCallIds: ['c1'], latencyMs: 1 };
        }
        return mockAdapter.decide(req);
      },
    };
    const { m, roomId, hostToken, seatToken } = setup({ adapters: { mock: adapter } });
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    const g = god(m, roomId, hostToken);
    const rejected = g.events.filter((e) => e.type === 'action.rejected');
    expect(rejected).toHaveLength(0);
    const seat = trappedSeat;
    const spectator = m.view(roomId, m.getSetup(roomId, hostToken).tokens.spectator).projection as Projection;
    expect(spectator.events.some((e) => e.type === 'action.rejected')).toBe(false);
    const other = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((n) => n !== seat)!;
    expect((m.view(roomId, seatToken(other)).projection as Projection).events.some((e) => e.type === 'action.rejected')).toBe(false);
    const mine = m.view(roomId, seatToken(seat)).projection as Projection;
    expect(mine.events.some((e) => e.type === 'action.rejected')).toBe(false);
    const audit = m.audit(roomId, hostToken);
    expect(audit.some((row) => row.seat === seat && row.purpose === 'listen' && row.error?.includes('不是工具调用轮次'))).toBe(true);
    expect(audit.some((row) => row.seat === seat && JSON.stringify(row.messages).includes('不是工具调用轮次'))).toBe(true);
    expect(g.status).toBe('ended');
  });

  it('白天不是发言轮次时，狼人自爆由引擎执行', async () => {
    let done = false;
    const adapter: Adapter = {
      async decide(req) {
        const can = req.projection?.interrupts.some((t) => t.name === 'wolf_explode');
        if (!done && req.toolChoice === 'auto' && can) {
          done = true;
          return { ok: true, call: { tool: 'wolf_explode', args: {} }, assistant: { role: 'assistant', content: null }, toolCallIds: ['ex'], latencyMs: 1 };
        }
        return mockAdapter.decide(req);
      },
    };
    const { m, roomId, hostToken } = setup({ adapters: { mock: adapter } });
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    const g = god(m, roomId, hostToken);
    const exploded = g.events.find((e) => e.type === 'explode');
    expect(exploded?.audience).toBe('public');
    const seat = exploded?.payload.seat as number;
    expect(g.god.roles.find((r) => r.seat === seat)?.alive).toBe(false);
    expect(g.status).toBe('ended');
  });

  it('连续旁听误调用不会产生拒绝事件循环，对局仍能结束', async () => {
    const adapter: Adapter = {
      async decide(req) {
        if (req.toolChoice === 'auto' && req.seat === 1) {
          return { ok: true, call: { tool: 'vote', args: { target: 2 } }, assistant: { role: 'assistant', content: null }, toolCallIds: ['c'], latencyMs: 1 };
        }
        return mockAdapter.decide(req);
      },
    };
    const { m, roomId, hostToken } = setup({ adapters: { mock: adapter } });
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    await m.whenIdle(roomId);
    const g = god(m, roomId, hostToken);
    expect(g.status).toBe('ended');
    let streak = 0;
    let max = 0;
    for (const e of g.events) {
      if (e.type === 'action.rejected' && Array.isArray(e.audience) && e.audience[0] === 1) {
        streak += 1;
        max = Math.max(max, streak);
      } else if (e.type !== 'action.rejected') streak = 0;
    }
    expect(max).toBeLessThanOrEqual(5);
    expect(g.events.some((e) => e.type === 'action.rejected' && Array.isArray(e.audience) && e.audience[0] === 1)).toBe(false);
    expect(g.events.filter((e) => e.audience === 'public').every((e) => e.type !== 'action.rejected')).toBe(true);
  });

  it('上警到点没交的记为不上警，全员到齐后结算', async () => {
    let now = 1_000_000;
    let held: number | null = null;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: Adapter = {
      async decide(req) {
        const signup = req.projection?.task?.tools.some((t) => t.name === 'sheriff_signup') && !req.projection.task.submitted;
        if (signup && req.toolChoice !== 'auto') {
          if (held === null) held = req.seat;
          if (req.seat === held) {
            await gate;
            return { ok: false, fatal: true, error: '超过 90 秒没有返回', toolCallIds: [], latencyMs: 1 };
          }
        }
        return mockAdapter.decide(req);
      },
    };
    const { m, roomId, hostToken } = setup({ now: () => now, adapters: { mock: adapter } });
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', aiPacingMs: 0 });
    m.start(roomId, hostToken);
    let found = false;
    for (let i = 0; i < 200 && !found; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const pending = god(m, roomId, hostToken).god.pending;
      const signup = pending?.actors.filter((a) => a.tools.includes('sheriff_signup')) ?? [];
      found = !!held && signup.some((a) => a.seat === held && !a.submitted) && signup.every((a) => a.seat === held || a.submitted);
    }
    expect(found).toBe(true);
    now += 90_000;
    m.tick();
    const g = god(m, roomId, hostToken);
    expect(g.events.some((e) => e.type === 'action.fallback' && Array.isArray(e.audience) && e.audience.includes(held!))).toBe(true);
    expect(g.events.some((e) => e.type === 'sheriff.signup' || e.text.includes('没有警长'))).toBe(true);
    expect(g.god.pending?.actors.some((a) => a.tools.includes('sheriff_signup'))).toBe(false);
    release();
    await m.whenIdle(roomId);
  });

  it('复制房间保留配置、换掉全部凭证', () => {
    const { m, roomId, hostToken } = setup();
    m.updateSetup(roomId, hostToken, { presetId: 'classic9', seats: [{ seat: 4, controller: 'human', name: '小王', thinkingMode: 'off' } as never] });
    const copy = m.cloneRoom(roomId, hostToken);
    const a = m.getSetup(roomId, hostToken);
    const b = m.getSetup(copy.roomId, copy.hostToken);
    expect(b.presetId).toBe('classic9');
    expect(b.seats[3]).toMatchObject({ controller: 'human', name: '小王' });
    expect(b.seats[3].thinkingMode).toBe('off');
    expect(b.tokens.seats[0].token).not.toBe(a.tokens.seats[0].token);
  });

  it('思考强度自动保存，复制后保留；换到不支持的模型会回到默认', () => {
    const { m, store, roomId, hostToken } = setup();
    const baseUrl = 'https://token-plan.maas.qianwenaiapi.com/v1';
    for (const thinkingMode of ['low', 'medium', 'high'] as const) {
      const view = m.updateSetup(roomId, hostToken, { seats: [{ seat: 1, model: 'qwen3.8-flash', baseUrl, thinkingMode }] });
      expect(view.seats[0].thinkingMode).toBe(thinkingMode);
    }
    m.dispose();
    expect(store.loadAll()[0].seats[0].thinkingMode).toBe('high');
    const clone = m.cloneRoom(roomId, hostToken);
    expect(m.getSetup(clone.roomId, clone.hostToken).seats[0].thinkingMode).toBe('high');
    m.updateSetup(roomId, hostToken, { seats: [{ seat: 1, thinkingMode: 'low' }] });
    const changed = m.updateSetup(roomId, hostToken, { seats: [{ seat: 1, model: 'deepseek-v4-pro' }] });
    expect(changed.seats[0].thinkingMode).toBe('default');
    expect(() => m.updateSetup(roomId, hostToken, { seats: [{ seat: 1, thinkingMode: 'low' }] })).toThrow('没有独立的轻度档');
    expect(m.getSetup(roomId, hostToken).seats[0].thinkingMode).toBe('default');
  });
});

describe('警长投票播报', () => {
  const system: ChatMessage = { role: 'system', content: '规则' };

  function feed(seat: number, event: GameEvent, hint: { nextSeat: number | null; nextStep: string | null }) {
    const thread = { seat, seen: 0, messages: [] as ChatMessage[] };
    syncThread(thread, [event], system, hint);
    return thread.messages.filter((m) => m.role === 'user').map((m) => m.content ?? '');
  }

  function vote(text: string, payload: Record<string, unknown>): GameEvent {
    return { seq: 1, day: 1, phase: 'day', audience: 'public', type: 'vote.result', text, payload };
  }

  it('当选、平票、警徽流失各只有一条法官消息', () => {
    const elected = feed(
      2,
      vote('警长 PK 投票结果：3号 3 票（4号、6号、10号）；5号 2 票（11号、12号）。3号当选警长。', {
        kind: 'sheriff',
        outcome: 'elected',
      }),
      { nextSeat: null, nextStep: null },
    );
    expect(elected).toHaveLength(1);
    expect(elected[0]).toContain('3 票');
    expect(elected[0]).toContain('3号当选警长。');
    expect(elected[0]).toContain('不要调用工具。');

    const pk = feed(
      4,
      vote('警长投票结果：9号 5 票（1号）；10号 5 票（2号）。9号、10号平票，进入竞选 PK。发言顺序：4号、9号。', {
        kind: 'sheriff',
        outcome: 'pk',
        order: [4, 9],
      }),
      { nextSeat: 4, nextStep: 'speech' },
    );
    expect(pk).toHaveLength(1);
    expect(pk[0]).toContain('进入竞选 PK');
    expect(pk[0]).toContain('有请4号玩家发言。');
    expect(pk[0]).toContain('可以调用speak工具。');
    expect(pk[0]).not.toContain('不要调用工具。');

    const lost = feed(
      1,
      vote('警长 PK 投票结果：3号 3 票（4号）；5号 3 票（6号）。3号、5号再次平票，警徽流失，本局没有警长。', {
        kind: 'sheriff',
        outcome: 'lost',
      }),
      { nextSeat: null, nextStep: null },
    );
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain('3 票');
    expect(lost[0]).toContain('警徽流失，本局没有警长。');
    expect(lost[0]).toContain('不要调用工具。');
  });

  it('法官的问话进入行动者上下文，并允许他使用工具', () => {
    const event: GameEvent = {
      seq: 1,
      day: 1,
      phase: 'day',
      audience: 'public',
      type: 'judge',
      text: '请投票放逐一名玩家。票齐之前看不到别人的票。',
      payload: { step: 'exile.vote' },
    };
    const cue = {
      id: 'd1',
      afterSeq: event.seq,
      step: 'exile.vote',
      kind: null,
      actors: [1],
      prompts: { 1: event.text },
      tool: 'vote',
      broadcast: true,
    };
    const voter = { seat: 1, seen: 0, messages: [] as ChatMessage[] };
    syncThread(voter, [event], system, { nextSeat: null, nextStep: 'exile.vote', cue });
    expect(voter.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(voter.messages.at(-1)?.content).toContain('请投票放逐一名玩家');
    expect(voter.messages.at(-1)?.content).toContain('你现在可以使用投票工具。');

    const other = { seat: 2, seen: 0, messages: [] as ChatMessage[] };
    syncThread(other, [event], system, { nextSeat: null, nextStep: 'exile.vote', cue });
    expect(other.messages.at(-1)?.content).toContain('请投票放逐一名玩家');
    expect(other.messages.at(-1)?.content).toContain('不要调用工具。');
  });
});
