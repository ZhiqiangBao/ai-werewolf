import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { MemoryStore, RoomManager, SecretBox, SpeechConnections, SpeechService } from '../src';
import { createHttpServer } from '../../../apps/server/src/http-server';

it('一个 HTTP 等待者断开时另一等待者仍可取得共享合成结果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'werewolf-audio-http-'));
  const secrets = SecretBox.ephemeral();
  const manager = new RoomManager({ store: new MemoryStore(), secrets, tickMs: 0 });
  const room = manager.createRoom();
  vi.spyOn(manager, 'speechText').mockReturnValue('合成测试');
  vi.spyOn(manager, 'speechLocale').mockReturnValue('zh-CN');
  let release!: () => void, signal!: AbortSignal, started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const synthesize = vi.fn(async (_text: string, current: AbortSignal) => {
    signal = current; started(); await new Promise<void>((resolve) => { release = resolve; });
    return { bytes: Buffer.from('fixture audio'), mimeType: 'audio/mpeg' };
  });
  const speech = new SpeechService(dir, [{ id: 'fixture', label: 'fixture', cacheIdentity: {}, synthesize }]);
  const http = createHttpServer({ manager, speech, speechConnections: new SpeechConnections(join(dir, 'connections.json'), secrets, dir), webRoot: dir });
  try {
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const address = http.server.address(); if (!address || typeof address === 'string') throw Error('port unavailable');
    const url = `http://127.0.0.1:${address.port}/api/v1/rooms/${room.roomId}/speech`;
    const controller = new AbortController();
    const options = { method: 'POST', headers: { Authorization: `Bearer ${room.hostToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ eventSeq: 1, providerId: 'fixture' }) };
    const closed = new Promise<void>((resolve) => http.server.once('request', (_req, res) => res.once('close', resolve)));
    const pending = fetch(url, { ...options, signal: controller.signal }).catch(() => undefined);
    await entered;
    const secondEntered = new Promise<void>((resolve) => http.server.once('request', () => resolve()));
    const second = fetch(url, options); await secondEntered;
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(); await pending; await closed;
    expect(signal.aborted).toBe(false);
    release();
    const response = await second;
    expect(response.status).toBe(200); expect(await response.text()).toBe('fixture audio');
    const cached = await fetch(url, options);
    expect(await cached.text()).toBe('fixture audio'); expect(synthesize).toHaveBeenCalledTimes(1);
  } finally { await http.close(); await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); }
});

it('试听断连取消上游；关闭在不合作的对局合成未结束时报告宽限超时', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'werewolf-audio-http-'));
  const secrets = SecretBox.ephemeral();
  const manager = new RoomManager({ store: new MemoryStore(), secrets, tickMs: 0 });
  const room = manager.createRoom();
  vi.spyOn(manager, 'speechText').mockReturnValue('对局合成');
  vi.spyOn(manager, 'speechLocale').mockReturnValue('zh-CN');
  const jobs = new Map<string, { signal: AbortSignal; release: () => void }>();
  const provider = { id: 'fixture', label: 'fixture', cacheIdentity: {}, synthesize: (text: string, signal: AbortSignal) => new Promise<{ bytes: Buffer; mimeType: string }>((resolve) => {
    jobs.set(text, { signal, release: () => resolve({ bytes: Buffer.from('fixture'), mimeType: 'audio/mpeg' }) });
  }) };
  const speech = new SpeechService(dir, [provider]);
  const connections = new SpeechConnections(join(dir, 'connections.json'), secrets, dir);
  vi.spyOn(connections, 'sharedProviders').mockReturnValue([provider]);
  const http = createHttpServer({ manager, speech, speechConnections: connections, webRoot: dir });
  try {
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const address = http.server.address(); if (!address || typeof address === 'string') throw Error('port unavailable');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    const controller = new AbortController();
    const preview = fetch(`${base}/speech-settings/fixture/test`, { method: 'POST', signal: controller.signal }).catch(() => undefined);
    const previewText = '这是一段语音接入测试。一二三。';
    await vi.waitFor(() => expect(jobs.has(previewText)).toBe(true));
    controller.abort(); await preview;
    await vi.waitFor(() => expect(jobs.get(previewText)!.signal.aborted).toBe(true));
    jobs.get(previewText)!.release();
    const game = fetch(`${base}/rooms/${room.roomId}/speech`, { method: 'POST', headers: { Authorization: `Bearer ${room.hostToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ eventSeq: 1, providerId: 'fixture' }) }).catch(() => undefined);
    await vi.waitFor(() => expect(jobs.has('对局合成')).toBe(true));
    expect(await http.close({ graceMs: 30 })).toBe(2);
    expect(jobs.get('对局合成')!.signal.aborted).toBe(true);
    jobs.get('对局合成')!.release(); await speech.whenDisposed(); await game;
  } finally { await http.close(); await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); }
});
