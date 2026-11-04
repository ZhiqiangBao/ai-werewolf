import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { buildRules, createGame } from '@werewolf/engine';
import { mockAdapter, mockDecision, type Adapter } from '@werewolf/llm';
import type { CreateRoomResult, GodProjection, Projection, RoomSetupView, ViewResponse } from '@werewolf/protocol';
import { createHttpServer } from '../../../apps/server/src/http-server';
import { FileStore, MemoryStore, RoomManager, SecretBox, SpeechConnections, SpeechService } from '../src/index';

const tempRoot = realpathSync(tmpdir());
const tempPrefix = 'werewolf-core-room-';

function removeDataDir(dir: string): void {
  const target = realpathSync(dir);
  if (dirname(target) !== tempRoot || !target.startsWith(join(tempRoot, tempPrefix))) {
    throw new Error(`测试目录越界 ${dir}`);
  }
  rmSync(target, { recursive: true, force: true });
}

function chooseAction(projection: Projection) {
  const task = projection.task;
  expect(task?.submitted).toBe(false);
  return { decisionId: task!.decisionId, ...mockDecision(projection, task!.tools) };
}

it('从 HTTP 建房和候场到真人夜间行动，按凭证隔离投影、订阅和房主接口', async () => {
  const dir = mkdtempSync(join(tempRoot, tempPrefix));
  const secrets = SecretBox.ephemeral();
  const manager = new RoomManager({ store: new MemoryStore(), secrets, tickMs: 0 });
  const http = createHttpServer({
    manager, webRoot: dir, speech: new SpeechService(dir, []),
    speechConnections: new SpeechConnections(join(dir, 'speech-connections.json'), secrets, dir),
  });
  const stream = new AbortController();
  // 用系统本地 IPC 承载完整 HTTP 解析和 SSE，测试环境无需 TCP 网络权限。
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\${tempPrefix}${randomUUID()}` : join(dir, 'http.sock');
  try {
    await new Promise<void>((ready, fail) => {
      http.server.once('error', fail);
      http.server.listen(socketPath, ready);
    });
    function open(path: string, method: string, token: string | undefined, body?: unknown, signal = AbortSignal.timeout(5000)) {
      return new Promise<IncomingMessage>((ready, fail) => {
        const req = httpRequest({
          socketPath, path: `/api/v1/rooms${path}`, method, signal,
          headers: { ...(token && { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/json' },
        }, ready);
        req.once('error', fail);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    }
    async function request<T>(path: string, status: number, method = 'GET', token?: string, body?: unknown): Promise<T> {
      const response = await open(path, method, token, body);
      expect(response.statusCode, `${method} ${path}`).toBe(status);
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(chunk as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
    }

    const { roomId, hostToken } = await request<CreateRoomResult>('', 201, 'POST', undefined, {});
    const room = `/${roomId}`;
    const setup = await request<RoomSetupView>(`${room}/setup`, 200, 'PUT', hostToken, {
      presetId: 'mirror12', aiPacingMs: 0, humanTimeoutSec: 0,
      seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' })),
    });
    const { spectator, seats } = setup.tokens;
    await request(`${room}/view`, 401);
    await request(`${room}/view`, 403, 'GET', 'invalid-token');
    await request(`${room}/setup?token=${hostToken}`, 403, 'GET', seats[0].token);
    await request(`${room}/start`, 403, 'POST', spectator);
    await request(`${room}/start`, 422, 'POST', hostToken);
    await request(`${room}/participate`, 403, 'POST', spectator, { ready: true });

    const feed = await open(`${room}/stream?token=${seats[0].token}`, 'GET', undefined, undefined,
      AbortSignal.any([stream.signal, AbortSignal.timeout(5000)]));
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toContain('text/event-stream');
    feed.setEncoding('utf8');
    const frames = feed[Symbol.asyncIterator]();
    let buffered = '';
    async function readFrame(): Promise<string> {
      while (!buffered.includes('\n\n')) {
        const chunk = await frames.next();
        if (chunk.done) throw new Error('事件流提前关闭');
        buffered += chunk.value;
      }
      const end = buffered.indexOf('\n\n');
      const frame = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      return frame;
    }
    expect(await readFrame()).toBe('retry: 2000');
    const joined = await request<ViewResponse>(`${room}/participate`, 200, 'POST', seats[0].token, { name: '测试玩家', ready: true });
    expect(joined.room.participants?.[0]).toMatchObject({ seat: 1, joined: true, ready: true, online: true });
    expect(joined.room.seats[0].name).toBe('测试玩家');
    expect(joined.projection).toBeNull();
    expect(await readFrame()).toMatch(/^event: update\ndata: \d+$/);
    await frames.return?.();
    for (const seat of seats.slice(1)) {
      await request(`${room}/participate`, 200, 'POST', seat.token, { ready: true });
    }

    const started = await request<RoomSetupView>(`${room}/start`, 200, 'POST', hostToken);
    expect(started.status).toBe('running');
    const host = await request<ViewResponse>(`${room}/view`, 200, 'GET', hostToken);
    const pending = (host.projection as GodProjection).god.pending!;
    const actor = seats.find(({ seat }) => seat === pending.actors[0].seat)!;
    const bystander = seats.find(({ seat }) => !pending.actors.some((entry) => entry.seat === seat))!;
    const acting = await request<ViewResponse>(`${room}/view`, 200, 'GET', actor.token);
    expect(acting.projection?.viewer).toEqual({ kind: 'seat', seat: actor.seat });
    expect(acting.projection?.task?.decisionId).toBe(pending.decisionId);
    expect(acting.projection).not.toHaveProperty('god');
    const privateEvent = acting.projection!.events.find((event) => Array.isArray(event.audience) && event.audience.length === 1);
    expect(privateEvent).toBeDefined();
    const privateContent = expect.objectContaining({ type: privateEvent!.type, text: privateEvent!.text, audience: [actor.seat] });
    expect(host.projection?.events).toContainEqual(privateContent);
    const other = await request<ViewResponse>(`${room}/view`, 200, 'GET', bystander.token);
    expect(other.projection?.task).toBeNull();
    expect(other.projection?.events).not.toContainEqual(privateContent);
    await request(`${room}/audit`, 403, 'GET', actor.token);
    await request(`${room}/export?kind=god`, 403, 'GET', spectator);

    const action = chooseAction(acting.projection!);
    await request(`${room}/act`, 403, 'POST', hostToken, action);
    await request(`${room}/act`, 403, 'POST', spectator, action);
    expect(await request(`${room}/act`, 200, 'POST', bystander.token, action))
      .toMatchObject({ ok: false, error: { code: 'NOT_YOUR_TURN' } });
    expect(await request(`${room}/act`, 200, 'POST', actor.token, action)).toEqual({ ok: true });
    expect(await request(`${room}/act`, 200, 'POST', actor.token, action))
      .toMatchObject({ ok: false, error: { code: 'STALE_DECISION' } });
    const watched = await request<ViewResponse>(`${room}/view`, 200, 'GET', spectator);
    expect(watched.room.viewer).toBe('spectator');
    expect(watched.projection).not.toHaveProperty('god');
    expect(watched.projection).not.toHaveProperty('me');
    expect(watched.projection?.task).toBeNull();
    expect(watched.projection!.events.every((event) => event.audience === 'public')).toBe(true);
    for (const token of [hostToken, spectator, ...seats.map(({ token }) => token)]) {
      expect(JSON.stringify(watched)).not.toContain(token);
    }
  } finally {
    stream.abort();
    try { expect(await http.close()).toBe(0); }
    finally { removeDataDir(dir); }
  }
});

it('暂停混合对局后从旧版文件恢复，隔离同模型同密钥的座位历史并继续到终局', async () => {
  const dir = mkdtempSync(join(tempRoot, tempPrefix));
  const secrets = SecretBox.ephemeral();
  const store = new FileStore(dir);
  const sharedModel = 'fixture-model';
  const sharedKey = 'fixture-key';
  const marker = (seat: number) => `private-history-of-seat-${seat}`;
  const witchSeat = 9;
  let restored = false;
  const calls: { seat: number; restored: boolean; markers: string[]; judgeLines: string[]; cacheKey?: string; model: string; key: string | null }[] = [];
  const adapter: Adapter = {
    async decide(req) {
      calls.push({
        seat: req.seat, restored, cacheKey: req.cacheKey, model: req.config.model, key: req.config.apiKey,
        markers: req.messages.flatMap((message) =>
          message.role === 'assistant' && message.content?.startsWith('private-history-of-seat-') ? [message.content] : []),
        judgeLines: req.messages.flatMap((message) => message.role === 'user' && message.name === 'judge' ? [message.content] : []),
      });
      const decision = await mockAdapter.decide(req);
      const tools = req.toolChoice === 'auto' ? [] : req.projection?.task?.tools ?? [];
      // 首夜固定刀口和女巫选择，让用药回执一定出现且女巫能收到后续请求。
      if (req.projection?.day === 1 && tools.some((tool) => tool.name === 'wolf_kill')) {
        decision.call = { tool: 'wolf_kill', args: { targetSeat: 2 } };
      }
      if (req.projection?.day === 1 && tools.some((tool) => tool.name === 'witch_skip')) {
        decision.call = { tool: 'witch_skip', args: {} };
      }
      return restored ? decision : { ...decision, assistant: { role: 'assistant', content: marker(req.seat) } };
    },
  };
  const load = () => new RoomManager({ store: new FileStore(dir), secrets, tickMs: 0, adapters: { mock: adapter } });
  let manager = load();
  try {
    const { roomId, hostToken } = manager.createRoom();
    const setup = manager.updateSetup(roomId, hostToken, {
      presetId: 'classic9', aiPacingMs: 0, humanTimeoutSec: 0,
      seats: [
        ...[1, 2, 3, 4, 5].map((seat) => ({ seat, controller: 'human' as const })),
        ...[6, 7, 8, 9].map((seat) => ({ seat, adapter: 'mock' as const, model: sharedModel, apiKey: sharedKey })),
      ],
    });
    const humans = setup.tokens.seats.slice(0, 5);
    for (const { token } of humans) manager.participate(roomId, token, { ready: true });
    const god = () => manager.view(roomId, hostToken).projection as GodProjection;
    const waitingHuman = () => {
      const pending = god().god.pending;
      const actor = humans.find(({ seat }) => pending?.actors.some((entry) => entry.seat === seat && !entry.submitted));
      expect(actor, '调度空闲时应轮到真人行动').toBeDefined();
      return { token: actor!.token, action: chooseAction(manager.view(roomId, actor!.token).projection!) };
    };

    // 固定发牌让女巫和狼队都由模拟适配器控制，同时保留真人行动检查点。
    manager.dispose();
    expect((await manager.whenDisposed()).durable).toBe(true);
    const initial = store.loadAll()[0];
    const rules = buildRules('classic9');
    const seed = 'core-room-checkpoint';
    const { state, events } = createGame({ id: roomId, rules, seed, names: setup.seats.map((seat) => seat.name),
      deal: ['seer', 'villager', 'hunter', 'villager', 'villager', 'werewolf', 'werewolf', 'werewolf', 'witch'] });
    store.save({ ...initial, status: 'running', seed, state, events, rules });
    manager = load();
    manager.resumeAll();
    await manager.whenIdle(roomId);
    const first = waitingHuman();
    expect(manager.act(roomId, first.token, first.action)).toEqual({ ok: true });
    await manager.whenIdle(roomId);
    const checkpoint = waitingHuman();
    expect(manager.control(roomId, hostToken, 'pause').paused).toBe(true);
    const eventsAtPause = god().events.slice();
    const pendingAtPause = god().god.pending;
    manager.dispose();
    expect((await manager.whenDisposed()).durable).toBe(true);

    const recordPath = join(dir, 'rooms', `${roomId}.json`);
    const saved = store.loadAll()[0];
    expect(saved.actions).toContainEqual(expect.objectContaining({ decisionId: first.action.decisionId }));
    expect(saved.threads!.length).toBeGreaterThan(0);
    const { threads: _threads, ...legacy } = saved;
    for (const player of legacy.state!.players) delete player.dataVersion;
    const legacyFile = JSON.stringify(legacy);
    writeFileSync(recordPath, legacyFile);

    restored = true;
    manager = load();
    manager.resumeAll();
    await manager.whenIdle(roomId);
    expect(manager.view(roomId, hostToken).room.paused).toBe(true);
    expect(god().events).toEqual(eventsAtPause);
    expect(god().god.pending).toEqual(pendingAtPause);
    expect(readFileSync(recordPath, 'utf8')).toBe(legacyFile);

    manager.control(roomId, hostToken, 'resume');
    expect(manager.act(roomId, checkpoint.token, checkpoint.action)).toEqual({ ok: true });
    for (let i = 0; i < 500; i++) {
      await manager.whenIdle(roomId);
      if (god().status === 'ended') break;
      const { token, action } = waitingHuman();
      expect(manager.act(roomId, token, action)).toEqual({ ok: true });
    }
    const ended = god();
    expect(ended.status).toBe('ended');
    expect(ended.result?.winner).toMatch(/^(good|wolf|draw)$/);
    expect(ended.events.slice(0, eventsAtPause.length)).toEqual(eventsAtPause);
    const continuedSeats = new Set(calls.filter((call) => call.restored && call.markers.includes(marker(call.seat))).map((call) => call.seat));
    expect(continuedSeats.size).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toMatchObject({ model: sharedModel, key: sharedKey, cacheKey: `werewolf:${roomId}:seat:${call.seat}` });
      expect(call.markers.every((message) => message === marker(call.seat))).toBe(true);
    }
    const receipts = ended.events.filter((event) => event.day === 1 && ['witch.no_save', 'witch.no_poison'].includes(event.type));
    expect(receipts.map((event) => event.type)).toEqual(['witch.no_save', 'witch.no_poison']);
    for (const receipt of receipts) {
      expect(receipt.audience).toEqual([witchSeat]);
      const deliveredTo = new Set(calls.filter((call) => call.judgeLines.some((line) => line.includes(receipt.text))).map((call) => call.seat));
      expect(deliveredTo).toEqual(new Set([witchSeat]));
    }
    expect(manager.audit(roomId, hostToken)).toContainEqual(expect.objectContaining({ ok: true }));
    const publicRecord = manager.exportRecord(roomId, setup.tokens.spectator, 'public') as Projection;
    expect(publicRecord.result).toEqual(ended.result);
    expect(publicRecord).not.toHaveProperty('god');
    expect(publicRecord.events.every((event) => event.audience === 'public')).toBe(true);

    manager.dispose();
    expect((await manager.whenDisposed()).durable).toBe(true);
    const finished = store.loadAll()[0];
    expect(finished.status).toBe('ended');
    expect(finished.state!.players.every((player) => player.dataVersion === 1)).toBe(true);
  } finally {
    manager.dispose();
    await manager.whenDisposed();
    removeDataDir(dir);
  }
}, 15_000);
