import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_PROTOCOLS } from '@werewolf/protocol';
import { protocolBinding, responsesInput, type AdapterConfig } from '@werewolf/llm';
import { FileStore, MemoryStore, RoomManager, SecretBox } from '../src/index';
import { presetsFromQwenSettings } from '../src/qwen-presets';
import { migrateThread, type SeatThread } from '../src/agent';
import type { RoomRecord } from '../src/store';

describe('协议配置和旧存档兼容', () => {
  it('相同模型与地址可按协议分别添加，选择、克隆、重载保留协议且不返回密钥', () => {
    const dir = mkdtempSync(join(tmpdir(), 'werewolf-protocol-config-'));
    const store = new MemoryStore(); const secrets = SecretBox.ephemeral();
    const file = join(dir, 'models.json');
    const manager = new RoomManager({ store, secrets, modelsPath: file, tickMs: 0 });
    const key = 'unit-secret-protocol-config';
    try {
      const entries = API_PROTOCOLS.map((apiProtocol) => manager.addModel({ name: 'qwen3.8-flash', baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1', apiKey: key, apiProtocol }));
      expect(new Set(entries.map((m) => m.id)).size).toBe(3);
      expect(JSON.stringify(entries)).not.toContain(key); expect(readFileSync(file, 'utf8')).not.toContain(key);
      expect(() => manager.addModel({ name: 'bad', baseUrl: 'https://example.com', apiKey: key, apiProtocol: 'unsupported' })).toThrow('无效');
      const { roomId, hostToken } = manager.createRoom();
      for (const entry of entries) {
        const view = manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, presetId: entry.id, maxOutputTokens: 24576 }] });
        expect(view.seats[0].apiProtocol).toBe(entry.apiProtocol); expect(view.seats[0].thinkingMode).toBe('low');
      }
      const copy = manager.cloneRoom(roomId, hostToken);
      expect(manager.getSetup(copy.roomId, copy.hostToken).seats[0]).toMatchObject({ apiProtocol: 'anthropic_messages', maxOutputTokens: 24576 });
      expect(() => manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, maxOutputTokens: 0 }] })).toThrow('输出上限');
      const reloaded = new RoomManager({ store, secrets, modelsPath: file, tickMs: 0 });
      try { expect(reloaded.modelPresets().filter((m) => m.source === 'added')).toHaveLength(3); } finally { reloaded.dispose(); }
    } finally { manager.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('settings 新协议分组分别导入，原 Chat 模型 ID 不因新增协议改变', () => {
    const row = { id: 'same-model', baseUrl: 'https://example.com/v1', envKey: 'UNIT_API_KEY' };
    const old = presetsFromQwenSettings({ modelProviders: { openai: [row] } }, { UNIT_API_KEY: 'unit-test-key' });
    const added = presetsFromQwenSettings({ modelProviders: { openai: [row], responses: [row], anthropic: [row] } }, { UNIT_API_KEY: 'unit-test-key' });
    expect(added).toHaveLength(3);
    expect(added.find((m) => m.apiProtocol === 'chat_completions')?.id).toBe(old[0].id);
    expect(new Set(added.map((m) => m.id)).size).toBe(3);
  });

  it('旧 tool_calls 与结果只迁移结构，v2 原生推理重启后按相同绑定续接', () => {
    const legacy = { seat: 1, seen: 9, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'legacy', type: 'function', function: { name: 'vote', arguments: '{"target":5}' } }] }, { role: 'tool', tool_call_id: 'legacy', content: '已采纳' }] };
    const migrated = migrateThread(structuredClone(legacy) as unknown as SeatThread);
    expect(migrated).toMatchObject({ formatVersion: 2, seat: 1, seen: 9 });
    expect(migrated.messages).toHaveLength(2);
    expect(migrated.messages[1]).toEqual({ role: 'tool', callId: 'legacy', content: '已采纳' });
    const dir = mkdtempSync(join(tmpdir(), 'werewolf-protocol-store-'));
    try {
      const config: AdapterConfig = { apiProtocol: 'responses', baseUrl: 'https://example.com/v1', model: 'test', apiKey: 'unit-key', temperature: .7, timeoutSec: 90, toolMode: 'tools' };
      const items = [{ type: 'reasoning', id: 'r', encrypted_content: 'opaque-data', summary: [] }, { type: 'function_call', call_id: 'new', name: 'vote', arguments: '{"target":5}' }];
      const thread: SeatThread = { seat: 1, seen: 9, formatVersion: 2, messages: [{ role: 'assistant', content: null, calls: [{ id: 'new', name: 'vote', arguments: '{"target":5}' }], native: { protocol: 'responses', binding: protocolBinding(config), items } }, { role: 'tool', callId: 'new', content: '已采纳' }] };
      const store = new FileStore(dir);
      store.save({ id: 'protocol-room', threads: [thread], events: [], actions: [] } as unknown as RoomRecord);
      const restored = new FileStore(dir).loadAll()[0].threads![0];
      expect(responsesInput(restored.messages, config).slice(0, 2)).toEqual(items);
      expect(responsesInput(restored.messages, config).at(-1)?.call_id).toBe('new');
      // 原始旧座位文件在读取后迁移，但不会重新执行或增加历史行动。
      writeFileSync(join(dir, 'rooms', 'protocol-room', 's1.json'), JSON.stringify(legacy));
      const loaded = new FileStore(dir).loadAll()[0];
      expect(loaded.threads![0].formatVersion).toBe(2); expect(loaded.actions).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
