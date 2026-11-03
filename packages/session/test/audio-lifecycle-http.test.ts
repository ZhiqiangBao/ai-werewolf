import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { MemoryStore, RoomManager, SecretBox, SpeechConnections, SpeechService } from '../src';
import { createHttpServer } from '../../../apps/server/src/http-server';

it('客户端在合成中断开后后台合成继续并写入缓存', async () => {
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
    await entered; controller.abort(); await pending; await closed;
    expect(signal.aborted).toBe(false);
    release();
    const response = await fetch(url, options);
    expect(response.status).toBe(200); expect(await response.text()).toBe('fixture audio');
    const cached = await fetch(url, options);
    expect(await cached.text()).toBe('fixture audio'); expect(synthesize).toHaveBeenCalledTimes(1);
  } finally { await http.close(); await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); }
});
