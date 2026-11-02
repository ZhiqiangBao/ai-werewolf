import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, RoomManager, SecretBox } from '../src/index';
import { ModelLibrary } from '../src/model-library';
import { loadQwenPresets, presetsFromQwenSettings } from '../src/qwen-presets';

const SECRET = 'sk-fixture-secret-value';

describe('Qwen Code 模型列表', () => {
  it('展开地址占位符，补上 /v1，跳过图像模型', () => {
    const list = presetsFromQwenSettings(
      {
        modelProviders: {
          openai: [
            { id: 'a', name: 'A', baseUrl: '${TOKEN_PLAN_OPENAI_BASE_URL}', envKey: 'PLAN_KEY' },
            { id: 'b', name: 'B', baseUrl: 'https://api.deepseek.com', envKey: 'MISSING' },
            { id: 'pic', name: '演示 image', baseUrl: 'https://example.com/v1', envKey: 'PLAN_KEY' },
          ],
        },
      },
      { TOKEN_PLAN_OPENAI_BASE_URL: 'https://plan.example/compatible-mode/v1', PLAN_KEY: SECRET },
    );
    expect(list.map((p) => p.model)).toEqual(['a', 'b']);
    expect(list[0].baseUrl).toBe('https://plan.example/compatible-mode/v1');
    expect(list[0].apiKey).toBe(SECRET);
    expect(list[1].baseUrl).toBe('https://api.deepseek.com/v1');
    expect(list[1].apiKey).toBeNull();
  });

  it('选用配置时写入密钥，列表和房间接口都不返回明文', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-presets-'));
    const file = join(dir, 'settings.json');
    writeFileSync(
      file,
      JSON.stringify({
        env: { DEMO_API_KEY: SECRET },
        modelProviders: {
          openai: [{ id: 'demo-chat', name: '演示模型', baseUrl: 'https://example.com/v1', envKey: 'DEMO_API_KEY' }],
        },
      }),
    );
    const prev = process.env.WEREWOLF_QWEN_SETTINGS;
    process.env.WEREWOLF_QWEN_SETTINGS = file;
    const manager = new RoomManager({ store: new MemoryStore(), secrets: SecretBox.ephemeral(), tickMs: 0 });
    try {
      expect(manager.modelPresets()).toEqual([]);
      expect(manager.importLegacyModels()).toBe(1);
      const presets = manager.modelPresets();
      expect(presets).toHaveLength(1);
      expect(presets[0].hasKey).toBe(true);
      expect(JSON.stringify(presets)).not.toContain(SECRET);
      const { roomId, hostToken } = manager.createRoom();
      const view = manager.updateSetup(roomId, hostToken, {
        seats: [
          {
            seat: 1,
            controller: 'ai',
            adapter: 'openai_compatible',
            baseUrl: presets[0].baseUrl,
            model: presets[0].model,
            presetId: presets[0].id,
          },
        ],
      });
      expect(view.seats[0].model).toBe('demo-chat');
      expect(view.seats[0].apiKeyMasked).toBeTruthy();
      expect(JSON.stringify(view)).not.toContain(SECRET);
      expect(loadQwenPresets().some((p) => p.apiKey === SECRET)).toBe(true);
    } finally {
      manager.dispose();
      if (prev === undefined) delete process.env.WEREWOLF_QWEN_SETTINGS;
      else process.env.WEREWOLF_QWEN_SETTINGS = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('手动添加名称、地址和密钥，座位从名单里选，测通仍可用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-models-'));
    const settings = join(dir, 'settings.json');
    const modelsPath = join(dir, 'models.json');
    writeFileSync(
      settings,
      JSON.stringify({
        env: { DEMO_API_KEY: SECRET },
        modelProviders: {
          openai: [{ id: 'from-settings', name: '来自 settings', baseUrl: 'https://settings.example/v1', envKey: 'DEMO_API_KEY' }],
        },
      }),
    );
    const prev = process.env.WEREWOLF_QWEN_SETTINGS;
    process.env.WEREWOLF_QWEN_SETTINGS = settings;
    const secrets = SecretBox.ephemeral();
    const manager = new RoomManager({ store: new MemoryStore(), secrets, tickMs: 0, modelsPath });
    try {
      expect(manager.importLegacyModels()).toBe(1);
      const added = manager.addModel({ name: 'my-chat', baseUrl: 'https://example.com', apiKey: SECRET });
      expect(added).toMatchObject({ source: 'added', model: 'my-chat', baseUrl: 'https://example.com/v1', hasKey: true });
      const raw = readFileSync(modelsPath, 'utf8');
      expect(raw).not.toContain(SECRET);
      expect(raw).toContain('"apiKeyEnc":"v1.');
      const fromSettings = manager.modelPresets().find((p) => p.source === 'imported');
      expect(fromSettings?.label).toBe('来自 settings');
      expect(fromSettings?.model).toBe('from-settings');
      const { roomId, hostToken } = manager.createRoom();
      const view = manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, presetId: added.id }] });
      expect(view.seats[0]).toMatchObject({ modelId: added.id, model: 'my-chat', adapter: 'openai_compatible' });
      expect(JSON.stringify(manager.modelPresets())).not.toContain(SECRET);
      expect(JSON.stringify(view)).not.toContain(SECRET);
      await expect(manager.testSeat(roomId, hostToken, 2)).resolves.toMatchObject({ ok: true, message: '模拟玩家不需要联网。' });
      const again = new RoomManager({ store: new MemoryStore(), secrets, tickMs: 0, modelsPath });
      expect(again.modelPresets().some((p) => p.id === added.id)).toBe(true);
      again.dispose();
      manager.deleteModel(added.id);
      expect(manager.modelPresets().some((p) => p.id === added.id)).toBe(false);
      manager.deleteModel(fromSettings!.id);
      expect(manager.importLegacyModels()).toBe(0);
      expect(manager.modelPresets()).toEqual([]);
    } finally {
      manager.dispose();
      if (prev === undefined) delete process.env.WEREWOLF_QWEN_SETTINGS;
      else process.env.WEREWOLF_QWEN_SETTINGS = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('迁移保留旧 ID 和已有模型；重启、修改或移除全局配置都不改变项目模型库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-model-migration-'));
    const settings = join(dir, 'settings.json'), file = join(dir, 'models.json'), secrets = SecretBox.ephemeral();
    const raw = { env: { OLD_API_KEY: SECRET }, modelProviders: { openai: [{ id: 'actual-model', name: '显示名称', baseUrl: 'https://old.example/v1', envKey: 'OLD_API_KEY' }] } };
    writeFileSync(settings, JSON.stringify(raw));
    const previous = process.env.WEREWOLF_QWEN_SETTINGS; process.env.WEREWOLF_QWEN_SETTINGS = settings;
    try {
      const encrypted = secrets.encrypt('existing-project-secret');
      writeFileSync(file, JSON.stringify({ models: [{ id: 'old-added-id', name: 'old-added-model', baseUrl: 'https://added.example/v1', apiKeyEnc: encrypted }] }));
      const library = new ModelLibrary(secrets, file);
      expect(library.list()).toHaveLength(1);
      const oldId = presetsFromQwenSettings(raw)[0].id;
      expect(library.importLegacySettings()).toBe(1);
      expect(library.find(oldId)).toMatchObject({ label: '显示名称', model: 'actual-model', source: 'imported', apiKey: SECRET });
      const persisted = JSON.parse(readFileSync(file, 'utf8'));
      expect(persisted.models[0]).toMatchObject({ id: 'old-added-id', apiKeyEnc: encrypted });
      expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
      expect(readFileSync(settings, 'utf8')).toBe(JSON.stringify(raw));
      writeFileSync(settings, '{broken');
      const restored = new ModelLibrary(secrets, file);
      expect(restored.find(oldId)?.apiKey).toBe(SECRET);
      expect(restored.importLegacySettings()).toBe(0);
      restored.remove(oldId);
      expect(new ModelLibrary(secrets, file).list().map((model) => model.id)).toEqual(['old-added-id']);
    } finally {
      if (previous === undefined) delete process.env.WEREWOLF_QWEN_SETTINGS; else process.env.WEREWOLF_QWEN_SETTINGS = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
