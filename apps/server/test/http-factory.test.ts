import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryStore, RoomManager, SecretBox, SpeechConnections, SpeechService } from '@werewolf/session';
import { createHttpServer } from '../src/http-server';

const fixtures: { close: () => Promise<0 | 1 | 2>; dir: string }[] = [];

async function fixture(label: string) {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-http-factory-'));
  mkdirSync(join(dir, 'dist')); writeFileSync(join(dir, 'dist', 'index.html'), label);
  const secrets = SecretBox.ephemeral();
  const manager = new RoomManager({ store: new MemoryStore(), secrets, tickMs: 0 });
  const speech = new SpeechService(dir, []);
  const speechConnections = new SpeechConnections(join(dir, 'connections.json'), secrets, dir);
  const http = createHttpServer({ manager, speech, speechConnections, webRoot: dir });
  fixtures.push({ close: () => http.close(), dir });
  await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
  const address = http.server.address();
  if (!address || typeof address === 'string') throw Error('port unavailable');
  return { ...http, manager, speechConnections, base: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.close(); rmSync(item.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

it('独立实例隔离存储、静态资源、订阅和关闭，关闭操作可重复调用', async () => {
  const a = await fixture('frontend A'), b = await fixture('frontend B');
  const roomA = a.manager.createRoom(), roomB = b.manager.createRoom();
  const unsubscribeA = vi.fn(), unsubscribeB = vi.fn();
  const subscribeA = a.manager.subscribe.bind(a.manager), subscribeB = b.manager.subscribe.bind(b.manager);
  vi.spyOn(a.manager, 'subscribe').mockImplementation((...args) => { const stop = subscribeA(...args); return () => { unsubscribeA(); stop(); }; });
  vi.spyOn(b.manager, 'subscribe').mockImplementation((...args) => { const stop = subscribeB(...args); return () => { unsubscribeB(); stop(); }; });
  const frontendCloseA = vi.fn(async () => {}), frontendCloseB = vi.fn(async () => {});
  a.setFrontend({ middlewares: (_req, res) => res.end('middleware A'), close: frontendCloseA });
  expect(await (await fetch(`${a.base}/`)).text()).toBe('middleware A');
  expect(await (await fetch(`${b.base}/`)).text()).toBe('frontend B');
  b.setFrontend({ middlewares: (_req, res) => res.end('middleware B'), close: frontendCloseB });
  expect((await fetch(`${b.base}/api/v1/rooms/${roomA.roomId}/setup?token=${roomA.hostToken}`)).status).toBe(404);
  const urlA = `${a.base}/api/v1/rooms/${roomA.roomId}`;
  expect((await fetch(`${urlA}/setup?token=${roomA.hostToken}`, { headers: { Authorization: 'Bearer invalid' } })).status).toBe(403);
  expect((await fetch(`${urlA}/invite-network?token=${roomA.hostToken}`)).status).toBe(200);
  const exportRecord = vi.spyOn(a.manager, 'exportRecord').mockReturnValue({ fixture: true });
  const exported = await fetch(`${urlA}/export?kind=god&token=${roomA.hostToken}`);
  expect(exportRecord).toHaveBeenCalledWith(roomA.roomId, roomA.hostToken, 'god');
  expect(exported.headers.get('content-type')).toContain('application/json');
  expect(exported.headers.get('content-disposition')).toBe(`attachment; filename="werewolf-${roomA.roomId}-god.json"`);
  expect(await exported.json()).toEqual({ fixture: true });
  const clearPing = vi.spyOn(globalThis, 'clearInterval');
  const abort = new AbortController();
  const streamA = await fetch(`${urlA}/stream?token=${roomA.hostToken}`, { signal: abort.signal });
  const readerA = streamA.body!.getReader(); await readerA.read();
  abort.abort(); await readerA.cancel().catch(() => {});
  await vi.waitFor(() => expect(unsubscribeA).toHaveBeenCalledTimes(1));
  const streamB = await fetch(`${b.base}/api/v1/rooms/${roomB.roomId}/stream?token=${roomB.hostToken}`);
  const readerB = streamB.body!.getReader(); await readerB.read();
  const closeA = a.close(); expect(a.close()).toBe(closeA); expect(await closeA).toBe(0);
  expect(frontendCloseA).toHaveBeenCalledTimes(1); expect(frontendCloseB).not.toHaveBeenCalled();
  expect(unsubscribeA).toHaveBeenCalledTimes(1); expect(unsubscribeB).not.toHaveBeenCalled();
  expect((await fetch(`${b.base}/api/v1/rooms/${roomB.roomId}/setup?token=${roomB.hostToken}`)).status).toBe(200);
  expect(await b.close()).toBe(0); expect((await readerB.read()).done).toBe(true);
  expect(frontendCloseB).toHaveBeenCalledTimes(1);
  expect(unsubscribeB).toHaveBeenCalledTimes(1);
  expect(clearPing).toHaveBeenCalledTimes(2);
}, 20_000);

it('请求体边界、非对象 JSON 与关闭期间未完成的请求沿用原有响应', async () => {
  const app = await fixture('body');
  vi.spyOn(app.speechConnections, 'saveShared').mockReturnValue({} as ReturnType<SpeechConnections['saveShared']>);
  const post = (body: string) => fetch(`${app.base}/api/v1/speech-settings`, { method: 'POST', body });
  expect((await post('')).status).toBe(201);
  expect((await post(`{}${' '.repeat(999_998)}`)).status).toBe(201);
  expect((await post(`{}${' '.repeat(999_999)}`)).status).toBe(413);
  for (const body of ['{', '[]', 'null']) expect((await post(body)).status).toBe(400);
  const url = new URL('/api/v1/speech-settings', app.base);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const aborted = new Promise<void>((resolve) => app.server.once('request', (incoming) => incoming.once('aborted', resolve)));
  const disconnected = new Promise<void>((resolve) => {
    const req = request(url, { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } });
    req.on('error', () => resolve()); req.write('{');
    app.server.once('request', () => req.destroy());
  });
  await Promise.all([aborted, disconnected]);
  expect((await post('{}')).status).toBe(201);
  log.mockRestore();
  const response = new Promise<number>((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.write('{');
    app.server.once('request', () => { void app.close(); req.end('}'); });
  });
  expect(await response).toBe(503);
  expect(await app.close()).toBe(0);
});
