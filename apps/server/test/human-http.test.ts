import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateRoomResult, RoomSetupView, ViewResponse } from '@werewolf/protocol';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dataDir = mkdtempSync(resolve(tmpdir(), 'werewolf-human-http-'));
let child: ChildProcess, base: string;
let room: CreateRoomResult, setup: RoomSetupView;
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const request = (path: string, token: string, body?: unknown, method = 'POST') => fetch(`${base}/${path}`, {
  method, headers: headers(token), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeAll(async () => {
  const port = await new Promise<number>((res, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') throw new Error('无法取得测试端口');
      probe.close(() => res(address.port));
    });
  });
  base = `http://127.0.0.1:${port}/api/v1`;
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', WEREWOLF_DATA: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  await new Promise<void>((res, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`测试服务提前退出：${code}`)));
    child.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('已启动')) res(); });
  });
  room = await (await request('rooms', '', {})).json() as CreateRoomResult;
  setup = await (await request(`rooms/${room.roomId}/setup`, room.hostToken, {
    presetId: 'mirror12', humanTimeoutSec: 0,
    seats: Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, controller: 'human' })),
  }, 'PUT')).json() as RoomSetupView;
}, 10000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((res) => child.once('exit', () => res()));
    child.kill(); await exited;
  }
  const parent = resolve(tmpdir()) + sep;
  if (!resolve(dataDir).startsWith(parent) || !dataDir.includes('werewolf-human-http-')) throw new Error('测试目录边界不正确');
  rmSync(dataDir, { recursive: true, force: true });
});

describe('真人 HTTP 与 SSE 接入', () => {
  it('候场接口保持凭证边界，SSE 首次连接能正确返回响应头，断线不会取消准备', async () => {
    const path = `rooms/${room.roomId}/participate`;
    expect((await request(path, '', { ready: true })).status).toBe(401);
    expect((await request(path, room.hostToken, { ready: true })).status).toBe(403);
    expect((await request(`rooms/${room.roomId}/start`, room.hostToken, {})).status).toBe(422);
    const tok = setup.tokens.seats[0].token;
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/rooms/${room.roomId}/stream?token=${tok}`, { signal: ctrl.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('Content-Type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('retry: 2000');
    const joined = await (await request(path, tok, { name: '网页真人', ready: true })).json() as ViewResponse;
    expect(joined.room.participants?.find((p) => p.seat === 1)).toMatchObject({ ready: true, online: true });
    expect(joined.projection).toBeNull();
    expect(JSON.stringify(joined)).not.toMatch(/apiKey|hostToken|seatTokens|seed/);
    ctrl.abort(); await reader.cancel().catch(() => {});
    for (const t of setup.tokens.seats.slice(1)) expect((await request(path, t.token, { ready: true })).status).toBe(200);
  });

  it('真人与模型共用工具参数和决策，过期重发不会更改其他座位或公开秘密', async () => {
    expect((await request(`rooms/${room.roomId}/start`, room.hostToken, {})).status).toBe(200);
    const views = await Promise.all(setup.tokens.seats.map(async (t) => ({
      token: t.token, view: await (await request(`rooms/${room.roomId}/view`, t.token, undefined, 'GET')).json() as ViewResponse,
    })));
    const actor = views.find((v) => v.view.projection?.task)!;
    const task = actor.view.projection!.task!, tool = task.tools[0];
    const args = Object.fromEntries(tool.params.map((p) => [p.name, p.kind === 'seat' ? p.options[0] : '']));
    const path = `rooms/${room.roomId}/act`;
    expect((await request(path, actor.token, { tool: tool.name, args })).status).toBe(400);
    expect((await request(path, room.hostToken, { decisionId: task.decisionId, tool: tool.name, args })).status).toBe(403);
    const input = { decisionId: task.decisionId, tool: tool.name, args };
    expect(await (await request(path, actor.token, input)).json()).toEqual({ ok: true });
    expect((await (await request(path, actor.token, input)).json()).error.code).toBe('STALE_DECISION');
    const spectator = await (await request(`rooms/${room.roomId}/view`, setup.tokens.spectator, undefined, 'GET')).json() as ViewResponse;
    expect(spectator.projection?.events.every((e) => e.audience === 'public')).toBe(true);
    expect(JSON.stringify(spectator)).not.toContain('awakened.mimic');
    expect(spectator.projection && 'god' in spectator.projection).toBe(false);
    const speechPath = `rooms/${room.roomId}/speech`;
    expect((await request(speechPath, '', { eventSeq: 1 })).status).toBe(401);
    expect((await request(speechPath, setup.tokens.spectator, { text: '客户端自由文本' })).status).toBe(400);
    expect((await request(speechPath, setup.tokens.spectator, { eventSeq: spectator.projection!.events[0].seq })).status).toBe(404);
  });
});
