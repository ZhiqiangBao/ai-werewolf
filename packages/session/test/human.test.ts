import { afterEach, describe, expect, it } from 'vitest';
import type { GodProjection, Projection } from '@werewolf/protocol';
import { mockDecision } from '@werewolf/llm';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

const managers: RoomManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.dispose(); });
function room(allHuman = false) {
  const store = new MemoryStore(), secrets = SecretBox.ephemeral();
  const m = new RoomManager({ store, secrets, tickMs: 0 }); managers.push(m);
  const { roomId: id, hostToken: host } = m.createRoom();
  m.updateSetup(id, host, {
    presetId: 'mirror12', aiPacingMs: 0, humanTimeoutSec: 0,
    seats: (allHuman ? Array.from({ length: 12 }, (_, i) => i + 1) : [1]).map((seat) => ({ seat, controller: 'human' })),
  });
  const setup = m.getSetup(id, host), tok = (seat: number) => setup.tokens.seats[seat - 1].token;
  const ready = () => { for (const s of setup.seats.filter((s) => s.controller === 'human')) m.participate(id, tok(s.seat), { ready: true }); };
  return { m, store, secrets, id, host, tok, setup, ready };
}

describe('真人玩家接入、候场和凭证', () => {
  it('仅本人可确认昵称并准备；新房间必须全部真人准备后才能开局', async () => {
    const { m, id, host, tok, setup } = room();
    expect(() => m.start(id, host)).toThrow('等待真人');
    const joined = m.participate(id, tok(1), { name: '测试玩家', ready: true });
    expect(joined.room.seats[0].name).toBe('测试玩家');
    expect(joined.room.participants).toEqual([{ seat: 1, joined: true, ready: true, online: false }]);
    expect(joined.room.ruleCard).toContain('魔镜少女');
    expect(joined.projection).toBeNull();
    expect(JSON.stringify(joined)).not.toMatch(/hostToken|seatTokens|apiKey|baseUrl|seed/);
    expect(() => m.participate(id, host, { ready: true })).toThrow('座位凭证');
    expect(() => m.participate(id, setup.tokens.spectator, { ready: true })).toThrow('座位凭证');
    expect(() => m.participate(id, tok(2), { ready: true })).toThrow('模型控制');
    m.start(id, host); await m.whenIdle(id);
    expect(m.view(id, tok(1)).projection?.me?.name).toBe('测试玩家');
  });

  it('输入严格校验，不能借传入座位号改别人或更换控制者', () => {
    const { m, id, host, tok, setup } = room();
    for (const input of [{ name: '' }, { name: '一'.repeat(13) }, { name: 23 }, { ready: 'yes' }]) {
      expect(() => m.participate(id, tok(1), input as never)).toThrow();
    }
    m.participate(id, tok(1), { name: '本人', seat: 2, controller: 'ai', ready: true } as never);
    expect(m.getSetup(id, host).seats[0]).toMatchObject({ name: '本人', controller: 'human' });
    expect(m.getSetup(id, host).seats[1].name).toBe(setup.seats[1].name);
  });

  it('修改规则或版型取消准备；改 AI 配置不影响真人确认，改回真人需要重新确认', () => {
    const { m, id, host, tok } = room();
    m.participate(id, tok(1), { ready: true });
    m.updateSetup(id, host, { seats: [{ seat: 2, name: 'AI名字' }] });
    expect(m.getSetup(id, host).participants[0].ready).toBe(true);
    m.updateSetup(id, host, { ruleValues: { 'vote.allowAbstain': false } });
    expect(m.getSetup(id, host).participants[0].ready).toBe(false);
    m.participate(id, tok(1), { ready: true });
    m.updateSetup(id, host, { presetId: 'classic9' });
    expect(m.getSetup(id, host).participants[0].ready).toBe(false);
    m.participate(id, tok(1), { ready: true });
    m.updateSetup(id, host, { seats: [{ seat: 1, controller: 'ai' }] });
    expect(m.getSetup(id, host).participants).toEqual([]);
    m.updateSetup(id, host, { seats: [{ seat: 1, controller: 'human' }] });
    expect(m.getSetup(id, host).participants[0]).toMatchObject({ joined: false, ready: false });
  });

  it('加入、准备和多连接的离线状态即时通知房主；最终断线不改变准备状态', () => {
    const { m, id, host, tok } = room();
    const updates: number[] = [];
    const closeHost = m.subscribe(id, host, (n) => updates.push(n));
    const closeA = m.subscribe(id, tok(1), () => {});
    const closeB = m.subscribe(id, tok(1), () => {});
    expect(m.getSetup(id, host).participants[0].online).toBe(true);
    m.participate(id, tok(1), { name: '已接入', ready: true });
    closeA();
    expect(m.getSetup(id, host).participants[0].online).toBe(true);
    closeB();
    expect(m.getSetup(id, host).participants[0]).toMatchObject({ online: false, ready: true });
    expect(updates.length).toBeGreaterThanOrEqual(3);
    closeHost();
  });

  it('重启保留昵称和准备，不保留在线；克隆清空准备并更换凭证', () => {
    const { m, store, secrets, id, host, tok } = room();
    m.participate(id, tok(1), { name: '重连玩家', ready: true });
    m.dispose();
    const next = new RoomManager({ store, secrets, tickMs: 0 }); managers.push(next);
    expect(next.getSetup(id, host).participants[0]).toMatchObject({ joined: true, ready: true, online: false });
    const copy = next.cloneRoom(id, host), setup = next.getSetup(copy.roomId, copy.hostToken);
    expect(setup.seats[0].name).toBe('重连玩家');
    expect(setup.participants[0]).toMatchObject({ joined: false, ready: false });
    expect(setup.tokens.seats[0].token).not.toBe(tok(1));
  });

  it('旧存档缺少候场字段可照常开局；运行中重接入不能改姓名、底牌或决策', async () => {
    const { m, store, secrets, id, host, tok, ready } = room(true);
    ready(); m.dispose();
    const record = store.rooms.get(id)!; delete record.participants;
    const next = new RoomManager({ store, secrets, tickMs: 0 }); managers.push(next);
    next.start(id, host); await next.whenIdle(id);
    const before = next.view(id, tok(1)).projection;
    next.participate(id, tok(1), {});
    expect(next.view(id, tok(1)).projection).toEqual(before);
    expect(() => next.participate(id, tok(1), { name: '改名' })).toThrow('开局后');
    expect(() => next.participate(id, tok(1), { ready: false })).toThrow('开局后');
  });
});

describe('真人行动复用引擎', () => {
  it('真人发言后能按新窗口退水，保留他人发言和截止时间，重接入后仍生效', async () => {
    const { m, store, secrets, id, host, tok, setup, ready } = room(true);
    m.updateSetup(id, host, { humanTimeoutSec: 60 }); ready(); m.start(id, host);
    for (let i = 0; i < 300; i++) {
      const p = m.view(id, host).projection as GodProjection;
      const actor = p.god.pending!.actors.find((a) => !a.submitted)!;
      const own = m.view(id, tok(actor.seat)).projection!;
      if (own.task!.title.endsWith('· 竞选发言')) {
        const first = actor.seat;
        expect(m.act(id, tok(first), { decisionId: own.task!.decisionId, tool: 'speak', args: { content: '真人已完成的竞选发言。' } }).ok).toBe(true);
        const next = (m.view(id, host).projection as GodProjection).god.pending!;
        const speaker = next.actors[0].seat;
        const before = m.view(id, tok(speaker)).projection!.task;
        const retired = m.view(id, tok(first)).projection!;
        expect(retired.task).toBeNull();
        expect(retired.interrupts.some((t) => t.name === 'sheriff_withdraw')).toBe(true);
        expect(m.act(id, tok(first), { decisionId: retired.actionWindowId!, tool: 'sheriff_withdraw', args: { content: '' } }).ok).toBe(true);
        expect(m.view(id, tok(speaker)).projection!.task).toEqual(before);
        expect(m.view(id, setup.tokens.spectator).projection!.events.filter((e) => e.type === 'sheriff.withdraw')).toHaveLength(1);
        expect(m.view(id, setup.tokens.spectator).projection!.events.filter((e) => e.type === 'speech' && e.payload.seat === first)).toHaveLength(1);
        m.dispose();
        const restored = new RoomManager({ store, secrets, tickMs: 0 }); managers.push(restored);
        expect(restored.view(id, tok(first)).projection!.interrupts.some((t) => t.name === 'sheriff_withdraw')).toBe(false);
        expect(restored.view(id, tok(speaker)).projection!.task?.decisionId).toBe(next.decisionId);
        expect(restored.audit(id, host)).toEqual([]);
        return;
      }
      const call = own.task!.tools.some((t) => t.name === 'sheriff_signup')
        ? { tool: [1, 2, 3].includes(actor.seat) ? 'sheriff_signup' : 'sheriff_stay_off', args: {} }
        : mockDecision(own, own.task!.tools);
      expect(m.act(id, tok(actor.seat), { decisionId: own.task!.decisionId, ...call }).ok).toBe(true);
      await m.whenIdle(id);
    }
    throw Error('未进入普通竞选发言');
  });

  it('私密 speech 也必须先经过本人投影，其他座位和观战不能请求隐藏发言', () => {
    const { m, store, secrets, id, host, tok, setup, ready } = room(true); ready(); m.start(id, host); m.dispose();
    const record = store.rooms.get(id)!;
    const seq = ++record.state!.seq;
    record.events.push({ seq, day: 1, phase: 'night', type: 'speech', audience: [1], text: '合成的授权发言', payload: { seat: 1, content: '仅本人可听的合成发言' } });
    const next = new RoomManager({ store, secrets, tickMs: 0 }); managers.push(next);
    for (const token of [host, tok(1)]) {
      const own = next.view(id, token).projection!.events.find((e) => e.payload.content === '仅本人可听的合成发言')!;
      expect(next.speechText(id, token, own.seq)).toBe('1号发言。仅本人可听的合成发言');
    }
    for (const token of [tok(2), setup.tokens.spectator]) {
      expect(next.view(id, token).projection!.events.some((e) => e.payload.content === '仅本人可听的合成发言')).toBe(false);
      expect(() => next.speechText(id, token, seq)).toThrow();
    }
  });
  it('朗读按各凭证的投影编号读取已接受公开发言，不读取私密记录或自由文本', () => {
    const { m, id, host, tok, setup, ready } = room(true); ready();
    expect(() => m.speechText(id, host, 1)).toThrow('还没有开始');
    m.start(id, host);
    for (let i = 0; i < 300; i++) {
      const views = setup.tokens.seats.map((s) => ({ seat: s.seat, p: m.view(id, s.token).projection as Projection }));
      const speaker = views.find((v) => v.p.task && !v.p.task.submitted && v.p.task.tools.some((t) => t.name === 'speak'));
      if (speaker) {
        expect(m.act(id, tok(speaker.seat), { decisionId: speaker.p.task!.decisionId, tool: 'speak', args: { content: '公开朗读原文。' } }).ok).toBe(true);
        for (const token of [host, tok(speaker.seat), setup.tokens.spectator]) {
          const p = m.view(id, token).projection!;
          const event = p.events.find((e) => e.type === 'speech' && e.audience === 'public')!;
          expect(m.speechText(id, token, event.seq)).toBe(`${speaker.seat}号发言。公开朗读原文。`);
        }
        const p = m.view(id, host).projection!;
        const privateEvent = p.events.find((e) => e.audience !== 'public')!;
        expect(() => m.speechText(id, host, privateEvent.seq)).toThrow('可朗读');
        expect(() => m.speechText(id, host, p.events.find((e) => e.type === 'game.start')!.seq)).toThrow('可朗读');
        expect(() => m.speechText(id, 'invalid-token', 1)).toThrow();
        for (const invalid of ['1', 1.5, 0, null, '自由文本']) expect(() => m.speechText(id, host, invalid)).toThrow('请选择');
        return;
      }
      const actor = views.find((v) => v.p.task && !v.p.task.submitted)!;
      const call = mockDecision(actor.p, actor.p.task!.tools);
      expect(m.act(id, tok(actor.seat), { decisionId: actor.p.task!.decisionId, ...call }).ok).toBe(true);
    }
    throw Error('没有到达公开发言窗口');
  });
  it('插入自爆也绑定当前发言窗口，旧页面不能打断下一段发言', async () => {
    const { m, id, host, tok, setup, ready } = room(true); ready(); m.start(id, host);
    for (let i = 0; i < 300; i++) {
      const views = setup.tokens.seats.map((s) => ({ seat: s.seat, p: m.view(id, s.token).projection as Projection }));
      const speaker = views.find((v) => v.p.task && !v.p.task.submitted && v.p.task.tools.some((t) => t.name === 'speak'));
      const wolf = views.find((v) => v.p.interrupts.some((t) => t.name === 'wolf_explode') && v.seat !== speaker?.seat);
      if (speaker && wolf) {
        const window = wolf.p.actionWindowId!;
        expect(window).toBe(speaker.p.task!.decisionId);
        expect(m.act(id, tok(speaker.seat), { decisionId: window, tool: 'speak', args: { content: '本段发言结束。' } }).ok).toBe(true);
        expect(m.act(id, tok(wolf.seat), { decisionId: window, tool: 'wolf_explode', args: {} }).error?.code).toBe('STALE_DECISION');
        expect((m.view(id, tok(wolf.seat)).projection as Projection).me?.alive).toBe(true);
        return;
      }
      const actor = views.find((v) => v.p.task && !v.p.task.submitted)!;
      const call = mockDecision(actor.p, actor.p.task!.tools);
      expect(m.act(id, tok(actor.seat), { decisionId: actor.p.task!.decisionId, ...call }).ok).toBe(true);
    }
    throw new Error('没有到达可验证的公开发言窗口');
  });

  it('必须带决策和参数对象，重复或过期提交不执行两次，拒绝仅本人可见', async () => {
    const { m, id, host, tok, setup, ready } = room(true); ready(); m.start(id, host); await m.whenIdle(id);
    const god = m.view(id, host).projection as GodProjection;
    const seat = god.god.pending!.actors[0].seat;
    const p = m.view(id, tok(seat)).projection as Projection, task = p.task!, call = mockDecision(p, task.tools);
    expect(() => m.act(id, tok(seat), { ...call })).toThrow('决策标识');
    expect(() => m.act(id, tok(seat), { decisionId: task.decisionId, tool: 'awakened_wait', args: [] })).toThrow('参数对象');
    expect(m.act(id, tok(seat), { decisionId: task.decisionId, ...call }).ok).toBe(true);
    expect(m.act(id, tok(seat), { decisionId: task.decisionId, ...call }).error?.code).toBe('STALE_DECISION');
    const spectator = m.view(id, setup.tokens.spectator).projection!;
    expect(spectator.events.some((e) => e.type === 'action.rejected')).toBe(false);
    expect(m.view(id, tok(seat)).projection!.events.some((e) => e.type === 'action.rejected')).toBe(true);
  });

  it('镜隐迷踪可由真人与模拟 AI 混坐完成整局，不为真人调用模型', async () => {
    const { m, id, host, tok, ready } = room(); ready(); m.start(id, host);
    for (let i = 0; i < 1000; i++) {
      await m.whenIdle(id);
      const v = m.view(id, tok(1));
      if (v.room.status === 'ended') break;
      const p = v.projection as Projection;
      expect(p.task && !p.task.submitted).toBeTruthy();
      const call = mockDecision(p, p.task!.tools);
      expect(m.act(id, tok(1), { decisionId: p.task!.decisionId, ...call }).ok).toBe(true);
    }
    expect(m.view(id, host).room.status).toBe('ended');
    expect(m.audit(id, host).some((a) => a.seat === 1)).toBe(false);
  });
});
