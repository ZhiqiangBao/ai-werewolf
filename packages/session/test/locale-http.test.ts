import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { preferredLanguage, gameText } from '@werewolf/protocol';
import { MemoryStore, RoomManager, SecretBox, SpeechConnections, SpeechService } from '../src';
import { createHttpServer } from '../../../apps/server/src/http-server';

it('按请求显示配置错误、按房间显示行动错误，语言切换不改变房间或权限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'werewolf-i18n-http-'));
  const secrets = SecretBox.ephemeral();
  const manager = new RoomManager({ store: new MemoryStore(), secrets, tickMs: 0 });
  const room = manager.createRoom({ locale: 'en' });
  manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, controller: 'human' }] });
  const http = createHttpServer({ manager, speech: new SpeechService(dir, []), speechConnections: new SpeechConnections(join(dir, 'connections.json'), secrets, dir), webRoot: dir });
  try {
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const address = http.server.address();
    if (!address || typeof address === 'string') throw Error('No port');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    const headers = { Authorization: `Bearer ${room.hostToken}`, 'Accept-Language': 'ja', 'Content-Type': 'application/json' };
    const setup = await (await fetch(`${base}/rooms/${room.roomId}/setup`, { headers })).json();
    expect(setup.locale).toBe('en');
    expect(setup.validationErrors.join(' ')).toContain('準備');
    const unsupported = await (await fetch(`${base}/rooms/${room.roomId}/setup`, { method: 'PUT', headers, body: JSON.stringify({ locale: 'unsupported' }) })).json();
    expect(unsupported.code).toBe('BAD_REQUEST');
    expect(unsupported.message).toBe('対応していない対局言語です');
    const action = await (await fetch(`${base}/rooms/${room.roomId}/act`, { method: 'POST', headers, body: '{}' })).json();
    expect(action.code).toBe('FORBIDDEN');
    expect(action.message).toBe('A seat credential is required to submit an action');
    const denied = await (await fetch(`${base}/rooms/${room.roomId}/act`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer invalid' }, body: '{}' })).json();
    expect(denied.code).toBe('FORBIDDEN');
    expect(denied.message).toBe('認証情報が無効です');
    const model = await (await fetch(`${base}/models`, { method: 'POST', headers, body: JSON.stringify({ name: '', baseUrl: 'https://example.invalid/v1', apiKey: 'fixture-only' }) })).json();
    expect(model.code).toBe('BAD_REQUEST');
    expect(model.message).toBe('モデル名を入力してください。');
    for (const locale of ['en', 'ja']) {
      const localizedHeaders = { ...headers, 'Accept-Language': locale };
      const badProtocol = await (await fetch(`${base}/rooms/${room.roomId}/setup`, { method: 'PUT', headers: localizedHeaders, body: JSON.stringify({ seats: [{ seat: 2, apiProtocol: 'invalid' }] }) })).json();
      expect(badProtocol.message).toBe(gameText(locale, '无效的接口协议'));
      const badTiming = await (await fetch(`${base}/rooms/${room.roomId}/setup`, { method: 'PUT', headers: localizedHeaders, body: JSON.stringify({ timing: { speech: { limitSec: 0, intervalMs: 0 } } }) })).json();
      expect(badTiming.message).toBe(gameText(locale, '行动时限为 1–3600 秒，推进间隔为 0–60000 毫秒'));
      const badUrl = await (await fetch(`${base}/rooms/${room.roomId}/setup`, { method: 'PUT', headers: localizedHeaders, body: JSON.stringify({ seats: [{ seat: 2, adapter: 'openai_compatible', baseUrl: 'example.com', model: 'fixture' }] }) })).json();
      expect(badUrl.validationErrors).toContain(gameText(locale, '{0}号：{1}', 2, gameText(locale, '请输入完整的 HTTP 或 HTTPS 接口地址')));
      const notReady = await (await fetch(`${base}/rooms/${room.roomId}/start`, { method: 'POST', headers: localizedHeaders })).json();
      expect(notReady.code).toBe('INVALID_SETUP');
      expect(notReady.message).toContain(gameText(locale, '{0}号：等待真人进入座位并确认准备', 1));
      expect(notReady.message).toContain(gameText(locale, '请输入完整的 HTTP 或 HTTPS 接口地址'));
    }
    expect(manager.getSetup(room.roomId, room.hostToken).locale).toBe('en');
  } finally { await http.close(); await rm(dir, { recursive: true, force: true }); }
});

it('Accept-Language 遵循质量值并回退到已注册基础语言', () => {
  expect(preferredLanguage('fr;q=1,en-GB;q=0.9,ja;q=0.8', ['zh-CN', 'en', 'ja'])).toBe('en');
  expect(preferredLanguage('en;q=0,ja;q=0.5', ['zh-CN', 'en', 'ja'])).toBe('ja');
  expect(preferredLanguage('unsupported', ['zh-CN', 'en', 'ja'])).toBe('zh-CN');
});
