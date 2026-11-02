import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateRoomResult, InviteNetworkView, RoomSetupView, ViewResponse } from '@werewolf/protocol';
import { mockDecision } from '../../../packages/llm/src/index';
import { wavHeader } from '../../../packages/session/src/speech/audio';

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
  const audio = Buffer.concat([wavHeader(24000, 24000), Buffer.alloc(48000)]);
  writeFileSync(resolve(dataDir, 'speech-adapter.mjs'), `export async function synthesize({text}) { if(!text.endsWith("接口朗读原文。"))throw Error("Unexpected source text"); return {bytes:Buffer.from("${audio.toString('base64')}","base64"),mimeType:"audio/wav"}; }`);
  writeFileSync(resolve(dataDir, 'speech-providers.json'), JSON.stringify({ providers: [{ id: 'fixture', label: '接口测试', type: 'module', module: './speech-adapter.mjs' }] }));
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), WEREWOLF_DATA: dataDir };
  delete env.HOST; // 验证默认启动本身支持局域网，而非仅依赖显式 HOST 覆盖。
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    cwd: root, env,
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
  it('仅房主能发现分享地址，默认服务可通过真实 LAN 地址接入座位与观战', async () => {
    const path = `rooms/${room.roomId}/invite-network`;
    expect((await request(path, '', undefined, 'GET')).status).toBe(401);
    for (const token of [setup.tokens.spectator, setup.tokens.seats[0].token]) {
      expect((await request(path, token, undefined, 'GET')).status).toBe(403);
    }
    const response = await request(path, room.hostToken, undefined, 'GET');
    expect(response.status).toBe(200);
    const network = await response.json() as InviteNetworkView;
    expect(network.loopbackOnly).toBe(false);
    expect(network.addresses.every((a) => !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(a.origin))).toBe(true);
    // CI 可能只有回环网卡；有真实网卡时，实际走 LAN origin 验证 HTTP 与 SSE。
    if (!network.addresses.length) return;
    const lan = `${network.addresses[0].origin}/api/v1/rooms/${room.roomId}`;
    const ctrl = new AbortController();
    const stream = await fetch(`${lan}/stream?token=${setup.tokens.seats[0].token}`, { signal: ctrl.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('retry: 2000');
    const joined = await (await fetch(`${lan}/participate`, {
      method: 'POST', headers: headers(setup.tokens.seats[0].token), body: JSON.stringify({ name: '扫码玩家' }),
    })).json() as ViewResponse;
    expect(joined.room.participants?.find((p) => p.seat === 1)?.online).toBe(true);
    expect(joined.room.viewer).toBe('seat');
    expect(joined.projection).toBeNull();
    const watch = await (await fetch(`${lan}/view`, { headers: headers(setup.tokens.spectator) })).json() as ViewResponse;
    expect(watch.room.viewer).toBe('spectator');
    expect(JSON.stringify(watch)).not.toMatch(/apiKey|hostToken|seatTokens|seed/);
    ctrl.abort(); await reader.cancel().catch(() => {});
  });

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

  it('朗读目录不暴露配置，HTTP 只合成凭证可见的已接受原文，不接受自由文本或未知提供方', async () => {
    const path = `rooms/${room.roomId}`;
    expect((await request(`${path}/speech-providers`, '', undefined, 'GET')).status).toBe(401);
    expect(await (await request(`${path}/speech-providers`, setup.tokens.spectator, undefined, 'GET')).json()).toEqual({ providers: [{ id: 'fixture', label: '接口测试' }], defaultProviderId: 'fixture' });
    for (let i = 0; i < 150; i++) {
      const views = await Promise.all(setup.tokens.seats.map(async (t) => ({ token: t.token, view: await (await request(`${path}/view`, t.token, undefined, 'GET')).json() as ViewResponse })));
      const actor = views.find((v) => v.view.projection?.task && !v.view.projection.task.submitted)!;
      const p = actor.view.projection!, task = p.task!;
      const call = task.tools.some((t) => t.name === 'speak') ? { tool: 'speak', args: { content: '接口朗读原文。' } } : mockDecision(p, task.tools);
      expect((await request(`${path}/act`, actor.token, { decisionId: task.decisionId, ...call })).status).toBe(200);
      if (call.tool !== 'speak') continue;
      const watch = await (await request(`${path}/view`, setup.tokens.spectator, undefined, 'GET')).json() as ViewResponse;
      const event = watch.projection!.events.find((e) => e.type === 'speech')!;
      expect((await request(`${path}/speech`, setup.tokens.spectator, { eventSeq: event.seq, providerId: 'unknown' })).status).toBe(400);
      const response = await request(`${path}/speech`, setup.tokens.spectator, { eventSeq: event.seq, providerId: 'fixture', text: '不能替换原文' });
      expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('audio/wav');
      expect(Buffer.from(await response.arrayBuffer()).toString('ascii', 0, 4)).toBe('RIFF');
      return;
    }
    throw Error('没有到达可测试的公开发言');
  });
  it('房主可通过网页接口管理与试听 TTS；密钥加密，座位和观战不能读配置，来源按房间隔离', async () => {
    const calls: { body: any; authorization?: string }[] = [];
    const fixture = createHttpServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({ body: JSON.parse(Buffer.concat(chunks).toString()), authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(Buffer.concat([wavHeader(24000, 24000), Buffer.alloc(48000)]));
    });
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
    try {
      const address = fixture.address(); if (!address || typeof address === 'string') throw Error('fixture port');
      const path = `rooms/${room.roomId}`, settings = `${path}/speech-settings`;
      const draft = { kind: 'speech-compatible', name: '网页添加的来源', url: `http://127.0.0.1:${address.port}/speech`, apiKey: 'fixture-web-tts-secret', model: 'fixture-model', voice: 'fixture-voice' };
      expect((await request(settings, '', undefined, 'GET')).status).toBe(401);
      for (const t of [setup.tokens.spectator, setup.tokens.seats[0].token]) {
        expect((await request(settings, t, undefined, 'GET')).status).toBe(403);
        expect((await request(settings, t, draft)).status).toBe(403);
      }
      const response = await request(settings, room.hostToken, draft); expect(response.status).toBe(201);
      const saved = await response.json(); expect(saved.hasKey).toBe(true); expect(JSON.stringify(saved)).not.toContain(draft.apiKey);
      expect(calls).toHaveLength(0); // Saving never triggers a billable test request.
      expect(readFileSync(resolve(dataDir, 'speech-connections.json'), 'utf8')).not.toContain(draft.apiKey);
      const catalog = await (await request(`${path}/speech-providers`, setup.tokens.spectator, undefined, 'GET')).json();
      expect(catalog.providers).toContainEqual({ id: saved.id, label: draft.name });
      expect(JSON.stringify(catalog)).not.toMatch(/fixture-web-tts-secret|127\.0\.0\.1|fixture-model|apiKeyEnc/);
      expect((await request(`${settings}/${saved.id}/test`, setup.tokens.spectator)).status).toBe(403);
      const test = await request(`${settings}/${saved.id}/test`, room.hostToken); expect(test.status).toBe(200); await test.arrayBuffer();
      expect(calls).toEqual([{ authorization: 'Bearer fixture-web-tts-secret', body: { input: '这是一段语音接入测试。一二三。', model: 'fixture-model', voice: 'fixture-voice', response_format: 'wav' } }]);
      const other = await (await request('rooms', '', {})).json() as CreateRoomResult;
      expect((await request(settings, other.hostToken, undefined, 'GET')).status).toBe(403);
      expect((await request(`rooms/${other.roomId}/speech-settings/${saved.id}/test`, other.hostToken)).status).toBe(404);
      expect((await request(`${settings}/${saved.id}`, room.hostToken, { ...draft, apiKey: '', name: '修改名称' }, 'PUT')).status).toBe(200);
      expect((await request(`${settings}/${saved.id}`, room.hostToken, undefined, 'DELETE')).status).toBe(200);
      expect((await request(`${settings}/${saved.id}/test`, room.hostToken)).status).toBe(404);
    } finally { await new Promise<void>((done, reject) => fixture.close((error) => error ? reject(error) : done())); }
  });
  it('首页 TTS 库在所有房间可选，旧私有配置需要房主显式分享，朗读 API 仍只接受授权事件', async () => {
    const draft = { kind: 'speech-compatible', name: '首页共享语音', url: 'https://fixture.invalid/audio/speech', apiKey: 'fixture-shared-secret' };
    const created = await request('speech-settings', '', draft); expect(created.status).toBe(201);
    const shared = await created.json(); expect(shared.hasKey).toBe(true); expect(JSON.stringify(shared)).not.toContain(draft.apiKey);
    const other = await (await request('rooms', '', {})).json() as CreateRoomResult;
    for (const [id, token] of [[room.roomId, setup.tokens.spectator], [other.roomId, other.hostToken]]) {
      const catalog = await (await request(`rooms/${id}/speech-providers`, token, undefined, 'GET')).json();
      expect(catalog.providers).toContainEqual({ id: shared.id, label: draft.name }); expect(JSON.stringify(catalog)).not.toMatch(/fixture.invalid|fixture-shared-secret/);
    }
    const privateResponse = await request(`rooms/${room.roomId}/speech-settings`, room.hostToken, { ...draft, name: '旧私有来源' });
    const legacy = await privateResponse.json();
    const homepage = await (await request('speech-settings', '', undefined, 'GET')).json();
    expect(homepage.connections.some((item: any) => item.id === legacy.id)).toBe(false);
    const share = `rooms/${room.roomId}/speech-settings/${legacy.id}/share`;
    expect((await request(share, setup.tokens.spectator)).status).toBe(403);
    expect((await request(share, other.hostToken)).status).toBe(403);
    expect((await request(share, room.hostToken)).status).toBe(200);
    const next = await (await request(`rooms/${other.roomId}/speech-providers`, other.hostToken, undefined, 'GET')).json();
    expect(next.providers).toContainEqual({ id: legacy.id, label: '旧私有来源' });
    expect((await request(`rooms/${other.roomId}/speech`, other.hostToken, { text: '自由文本', providerId: shared.id })).status).toBe(400);
    expect((await request(`rooms/${other.roomId}/speech-settings/${shared.id}`, other.hostToken, undefined, 'DELETE')).status).toBe(400);
    expect((await request(`speech-settings/${shared.id}`, '', { ...draft, apiKey: '', name: '首页修改' }, 'PUT')).status).toBe(200);
    expect((await request(`speech-settings/${shared.id}`, '', undefined, 'DELETE')).status).toBe(200);
    expect((await request(`speech-settings/${legacy.id}`, '', undefined, 'DELETE')).status).toBe(200);
  });
});
