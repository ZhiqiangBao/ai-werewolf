import { expect, it, vi } from 'vitest';
import { API_PROTOCOLS } from '@werewolf/protocol';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';

it('保存席位的 GPT-6 高档位后，测通将所选力度原样发给 Responses', async () => {
  const store = new MemoryStore(), secrets = SecretBox.ephemeral();
  let manager = new RoomManager({ store, secrets, tickMs: 0 });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: 'completed', output: [
    { type: 'function_call', name: 'ping', call_id: 'ping-call', arguments: '{"ok":true}' },
  ] }));
  vi.stubGlobal('fetch', fetch);
  try {
    const baseUrl = 'https://api.openai.com/v1', model = 'gpt-6.2-sol';
    const { roomId, hostToken } = manager.createRoom();
    manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, adapter: 'openai_compatible', baseUrl, model, apiProtocol: 'responses', thinkingMode: 'high' }] });
    for (const thinkingMode of ['high', 'xhigh', 'max'] as const) {
      if (thinkingMode !== 'high') manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, thinkingMode }] });
      manager.dispose();
      await manager.whenDisposed();
      manager = new RoomManager({ store, secrets, tickMs: 0 });
      expect(manager.getSetup(roomId, hostToken).seats[0].thinkingMode).toBe(thinkingMode);
      expect(await manager.testSeat(roomId, hostToken, 1)).toMatchObject({ ok: true });
      const [url, request] = fetch.mock.lastCall!;
      expect(url).toBe(`${baseUrl}/responses`);
      expect(JSON.parse(String(request?.body))).toMatchObject({ model, reasoning: { effort: thinkingMode } });
    }
  } finally {
    manager.dispose();
    await manager.whenDisposed();
    vi.unstubAllGlobals();
  }
});

it('房间选择 Qwen4 与 DeepSeek 时使用真实轻度默认，并保留明确选择的强度', () => {
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
  try {
    for (const apiProtocol of API_PROTOCOLS) {
      for (const name of ['qwen4-max-preview', 'deepseek-flash']) {
        const baseUrl = name.startsWith('qwen') ? 'https://token-plan.maas.qianwenaiapi.com/v1'
          : apiProtocol === 'anthropic_messages' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com';
        const preset = manager.addModel({ name, baseUrl, apiKey: 'fixture-key', apiProtocol });
        const room = manager.createRoom();
        manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, presetId: preset.id }] });
        const seat = () => manager.getSetup(room.roomId, room.hostToken).seats[0];
        expect(seat()).toMatchObject({ model: name, apiProtocol, thinkingMode: 'low' });
        for (const thinkingMode of ['medium', 'high', 'default', 'off'] as const) {
          manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, thinkingMode }] });
          expect(seat().thinkingMode).toBe(thinkingMode);
        }
      }
    }
  } finally { manager.dispose(); }
});

it('切换至 MiMo 时纠正不支持的旧档位，并拒绝显式提交不存在的强度', () => {
  const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
  try {
    const room = manager.createRoom();
    const qwen = manager.addModel({ name: 'qwen4-max-preview', baseUrl: 'https://token-plan.maas.qianwenaiapi.com/v1', apiKey: 'fixture-key', apiProtocol: 'responses' });
    const mimo = manager.addModel({ name: 'mimo-v2.6-flash', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiKey: 'fixture-key', apiProtocol: 'responses' });
    manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, presetId: qwen.id, thinkingMode: 'high' }] });
    manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, presetId: mimo.id }] });
    const seat = () => manager.getSetup(room.roomId, room.hostToken).seats[0];
    expect(seat()).toMatchObject({ model: 'mimo-v2.6-flash', thinkingMode: 'default' });
    expect(() => manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, thinkingMode: 'low' }] })).toThrow('仅支持思考开关');
    expect(seat().thinkingMode).toBe('default');
    manager.updateSetup(room.roomId, room.hostToken, { seats: [{ seat: 1, thinkingMode: 'off' }] });
    expect(seat().thinkingMode).toBe('off');
  } finally { manager.dispose(); }
});
