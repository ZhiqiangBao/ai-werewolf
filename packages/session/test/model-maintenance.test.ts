import { closeSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDataLease } from '../src/data-lease';
import { ModelLibrary } from '../src/model-library';
import { ModelMaintenance, type ModelAliasEvidence } from '../src/model-maintenance';
import { classifyEvidence, classifyEvidenceSet, type RetirementEvidence } from '../src/model-retirement';
import { SecretBox } from '../src/secret';
import { RoomManager } from '../src/manager';
import { MemoryStore } from '../src/store';
import { projectQwenTokenPlanKey } from '../src/project-models';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ww-maintenance-')); dirs.push(dir);
  const secrets = SecretBox.ephemeral(), library = new ModelLibrary(secrets, join(dir, 'models.json'));
  const model = library.add('model-a', 'https://example.com/v1', 'secret');
  return { dir, secrets, library, model, maintenance: new ModelMaintenance(dir, secrets) };
}
const evidence: RetirementEvidence = { kind: 'official_retirement', providerId: 'p', model: 'm', protocol: 'chat', checkedAt: '2025-01-01T00:00:00Z', effectiveAt: '2025-01-01T00:00:00Z', expiresAt: '2999-01-01T00:00:00Z', sourceUrl: 'https://example.com', sourceDigest: 'a'.repeat(64), reasonCode: 'documented', summary: '官方公告确认此范围停供', scope: { routeId: 'r' } };
describe('模型维护', () => {
  it('分类七类证据，范围、未来日期及无归因证据不能判成停供', () => {
    const expected = { official_retirement: 'retired_confirmed', verified_available: 'available', authentication: 'credential_invalid', authorization: 'access_denied', transport: 'network_error', temporary: 'temporary_unavailable', unattributed: 'unknown' } as const;
    for (const [kind, status] of Object.entries(expected)) expect(classifyEvidence({ ...evidence, kind: kind as RetirementEvidence['kind'] }, evidence)).toBe(status);
    expect(classifyEvidence({ ...evidence, effectiveAt: '2999-01-01' }, evidence)).toBe('unknown');
    expect(classifyEvidence(evidence, { ...evidence, scope: { routeId: 'other' } })).toBe('unknown');
    expect(classifyEvidence({ ...evidence, sourceUrl: undefined }, evidence)).toBe('unknown');
    expect(classifyEvidenceSet([evidence, { ...evidence, kind: 'verified_available' }], evidence)).toBe('unknown');
    expect(classifyEvidenceSet([evidence, { ...evidence, expiresAt: '2025-01-02' }], evidence)).toBe('unknown');
  });
  it('精确及可能引用分开，活动引用阻止归档；过期预览拒绝', () => {
    const { dir, model, maintenance } = fixture(); mkdirSync(join(dir, 'rooms'));
    const room = { id: 'room1', status: 'setup', paused: false, seats: [{ seat: 1, controller: 'ai', adapter: 'openai_compatible', modelId: model.id, model: model.model, baseUrl: model.baseUrl }, { seat: 2, controller: 'ai', adapter: 'openai_compatible', modelId: null, model: model.model, baseUrl: model.baseUrl }] };
    writeFileSync(join(dir, 'rooms', 'room1.json'), JSON.stringify(room));
    const impact = maintenance.preview(model.id);
    expect(impact.exactRefs).toHaveLength(1); expect(impact.possibleRefs).toHaveLength(1); expect(impact.canArchive).toBe(false);
    expect(() => maintenance.apply({ modelId: model.id, operation: 'archive', expectedRevision: impact.revision, expectedInventoryDigest: impact.inventoryDigest })).toThrow('MODEL_IN_USE');
    writeFileSync(join(dir, 'rooms', 'room1.json'), JSON.stringify({ ...room, status: 'ended' }));
    expect(() => maintenance.apply({ modelId: model.id, operation: 'disable', expectedRevision: impact.revision, expectedInventoryDigest: impact.inventoryDigest })).toThrow('MODEL_PREVIEW_STALE');
  });
  it('停用、归档、恢复和启用均保留 ID 与密钥；损坏房间拒绝盘点', () => {
    const { dir, model, maintenance, secrets } = fixture();
    for (const [operation, lifecycle] of [['disable', 'disabled'], ['archive', 'archived'], ['restore', 'disabled'], ['enable', 'active']] as const) {
      const impact = maintenance.preview(model.id);
      expect(maintenance.apply({ modelId: model.id, operation, expectedRevision: impact.revision, expectedInventoryDigest: impact.inventoryDigest }).lifecycle).toBe(lifecycle);
    }
    expect(new ModelLibrary(secrets, join(dir, 'models.json')).find(model.id)?.apiKey).toBe('secret');
    mkdirSync(join(dir, 'rooms')); writeFileSync(join(dir, 'rooms', 'bad.json'), '{');
    expect(() => maintenance.preview(model.id)).toThrow();
  });
  it('租约互斥，旧删除路径拒绝，写入失败回滚内存', () => {
    const { dir, model, library } = fixture();
    const release = acquireDataLease(dir); expect(() => acquireDataLease(dir)).toThrow('MODEL_STORE_BUSY'); release();
    expect(() => library.remove(model.id)).toThrow('MODEL_MAINTENANCE_REQUIRED');
    const before = readFileSync(join(dir, 'models.json'), 'utf8');
    mkdirSync(join(dir, 'models.json.tmp'));
    expect(() => library.setLifecycle(model.id, 'disabled')).toThrow();
    expect(library.find(model.id)?.lifecycle).toBe('active'); expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe(before);
  });
  it('租约初始化写入或关闭失败时仅清理自己创建的文件', () => {
    const { dir } = fixture(), path = join(dir, '.writer-lease');
    expect(() => acquireDataLease(dir, { write: (() => { throw new Error('write failed'); }) as typeof writeFileSync, close: closeSync })).toThrow('write failed');
    expect(existsSync(path)).toBe(false);
    expect(() => acquireDataLease(dir, { write: writeFileSync, close: ((fd: number) => { closeSync(fd); throw new Error('close failed'); }) as typeof closeSync })).toThrow('close failed');
    expect(existsSync(path)).toBe(false);
    const release = acquireDataLease(dir); expect(() => acquireDataLease(dir)).toThrow('MODEL_STORE_BUSY'); release();
  });
  it('无法判定的座位字段拒绝盘点，正常旧真人及模拟座位允许缺省模型字段', () => {
    const { dir, model, maintenance } = fixture(); mkdirSync(join(dir, 'rooms'));
    const path = join(dir, 'rooms', 'one.json');
    const save = (seat: object) => writeFileSync(path, JSON.stringify({ id: 'one', status: 'setup', paused: false, seats: [seat] }));
    for (const seat of [
      { seat: 1, controller: 'ai', adapter: 'openai_compatible', modelId: {}, model: 'x', baseUrl: 'https://x' },
      { seat: 1, controller: 'ai', adapter: 'openai_compatible', modelId: null, baseUrl: 'https://x' },
      { seat: 1, controller: 'ai', adapter: 'openai_compatible', modelId: null, model: 'x' },
      { seat: 1, controller: 'ai', adapter: 'openai_compatible', modelId: null, model: 'x', baseUrl: 'https://x', apiProtocol: 'bad' },
    ]) { save(seat); expect(() => maintenance.preview(model.id)).toThrow('MODEL_INVENTORY_INVALID'); }
    for (const seat of [{ seat: 1, controller: 'human', adapter: 'mock' }, { seat: 1, controller: 'ai', adapter: 'mock' }]) {
      save(seat); expect(maintenance.preview(model.id).canArchive).toBe(true);
    }
  });
  it('不同 ID 的实际快照也被盘点，单独修改自定义模型会清除旧 ID 并阻止启动和克隆', () => {
    const { dir, secrets, library, model, maintenance } = fixture();
    const other = library.add('disabled-b', 'https://b.example/v1', 'another');
    library.setLifecycle(other.id, 'disabled');
    mkdirSync(join(dir, 'rooms')); const path = join(dir, 'rooms', 'one.json');
    writeFileSync(path, JSON.stringify({ id: 'one', status: 'setup', paused: false, seats: [{ seat: 1, controller: 'ai', adapter: 'openai_compatible', modelId: model.id, model: other.model, baseUrl: other.baseUrl }] }));
    expect(maintenance.preview(other.id).possibleRefs).toHaveLength(1);
    const store = new MemoryStore(), manager = new RoomManager({ store, secrets, modelsPath: join(dir, 'models.json'), tickMs: 0 });
    try {
      const { roomId, hostToken } = manager.createRoom();
      manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, presetId: model.id }] });
      const view = manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, model: other.model, baseUrl: other.baseUrl }] });
      expect(view.seats[0].modelId).toBeNull();
      expect(() => manager.start(roomId, hostToken)).toThrow('模型已停用');
      expect(() => manager.cloneRoom(roomId, hostToken)).toThrow('模型已停用');
    } finally { manager.dispose(); }
  });
  it('证据绑定模型和路由，记录后修改修订号，启用明确提示', () => {
    const { dir, secrets, library, maintenance } = fixture();
    const model = library.add('tts-model', 'https://token-plan.maas.qianwenaiapi.com/v1', 'sk-sp-test');
    const impact = maintenance.preview(model.id);
    expect(impact.credentialDependencies).toHaveLength(1);
    expect(impact.canArchive).toBe(true);
    expect(() => maintenance.recordEvidence(model.id, { ...evidence, model: model.model, protocol: 'chat_completions' }, impact.revision)).toThrow('MODEL_EVIDENCE_INVALID');
    maintenance.recordEvidence(model.id, { ...evidence, ...impact.evidenceTarget }, impact.revision);
    expect(new ModelLibrary(secrets, join(dir, 'models.json')).find(model.id)?.evidence).toHaveLength(1);
    expect(() => maintenance.apply({ modelId: model.id, operation: 'disable', expectedRevision: impact.revision, expectedInventoryDigest: impact.inventoryDigest })).toThrow('MODEL_PREVIEW_STALE');
    const checked = maintenance.preview(model.id); expect(checked.evidenceStatus).toBe('retired_confirmed');
    maintenance.apply({ modelId: model.id, operation: 'disable', expectedRevision: checked.revision, expectedInventoryDigest: checked.inventoryDigest });
    const disabled = maintenance.preview(model.id);
    expect(maintenance.apply({ modelId: model.id, operation: 'enable', expectedRevision: disabled.revision, expectedInventoryDigest: disabled.inventoryDigest }).warnings).toHaveLength(1);
  });
  it('TTS 优先读取的密钥和多个后备密钥在停用与归档后仍可读取，包括最后可用条目', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ww-tts-maintenance-')); dirs.push(dir);
    const oldData = process.env.WEREWOLF_DATA, oldSecret = process.env.WEREWOLF_SECRET;
    process.env.WEREWOLF_DATA = dir; delete process.env.WEREWOLF_SECRET;
    try {
      const secrets = SecretBox.fromEnvOrFile(dir), library = new ModelLibrary(secrets, join(dir, 'models.json'));
      const first = library.add('first', 'https://token-plan.maas.qianwenaiapi.com/v1', 'sk-sp-one');
      const same = library.add('same', 'https://token-plan.maas.qianwenaiapi.com/v1', 'sk-sp-one');
      const other = library.add('other', 'https://token-plan.maas.qianwenaiapi.com/v1', 'sk-sp-two');
      const maintenance = new ModelMaintenance(dir, secrets);
      expect(projectQwenTokenPlanKey()).toBe('sk-sp-two');
      for (const id of [other.id, same.id, first.id]) {
        let impact = maintenance.preview(id); expect(impact.credentialDependencies).toHaveLength(1);
        maintenance.apply({ modelId: id, operation: 'disable', expectedRevision: impact.revision, expectedInventoryDigest: impact.inventoryDigest });
        impact = maintenance.preview(id); expect(impact.canArchive).toBe(true);
        maintenance.apply({ modelId: id, operation: 'archive', expectedRevision: impact.revision, expectedInventoryDigest: impact.inventoryDigest });
        expect(projectQwenTokenPlanKey()).toBe('sk-sp-two');
      }
    } finally {
      if (oldData === undefined) delete process.env.WEREWOLF_DATA; else process.env.WEREWOLF_DATA = oldData;
      if (oldSecret === undefined) delete process.env.WEREWOLF_SECRET; else process.env.WEREWOLF_SECRET = oldSecret;
    }
  });
  it('已停用模型不可选择、启动或复制；既有座位快照不改写', () => {
    const { dir, secrets, library, model } = fixture();
    const store = new MemoryStore();
    let manager = new RoomManager({ store, secrets, modelsPath: join(dir, 'models.json'), tickMs: 0 });
    const { roomId, hostToken } = manager.createRoom();
    manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, presetId: model.id }] });
    const before = manager.getSetup(roomId, hostToken).seats[0]; manager.dispose();
    library.setLifecycle(model.id, 'disabled');
    manager = new RoomManager({ store, secrets, modelsPath: join(dir, 'models.json'), tickMs: 0 });
    try {
      expect(manager.getSetup(roomId, hostToken).seats[0]).toEqual(before);
      expect(() => manager.updateSetup(roomId, hostToken, { seats: [{ seat: 2, presetId: model.id }] })).toThrow('模型已停用');
      expect(() => manager.start(roomId, hostToken)).toThrow('模型已停用');
      expect(() => manager.cloneRoom(roomId, hostToken)).toThrow('模型已停用');
    } finally { manager.dispose(); }
  });
  it('重复停用与归档幂等，库变化使预览过期，恢复配置冲突不覆盖', () => {
    const { dir, secrets, model, maintenance } = fixture();
    let preview = maintenance.preview(model.id);
    new ModelLibrary(secrets, join(dir, 'models.json')).add('other', 'https://other.example/v1', 'another');
    expect(() => maintenance.apply({ modelId: model.id, operation: 'disable', expectedRevision: preview.revision, expectedInventoryDigest: preview.inventoryDigest })).toThrow('MODEL_PREVIEW_STALE');
    for (const operation of ['disable', 'disable', 'archive', 'archive'] as const) {
      preview = maintenance.preview(model.id);
      expect(maintenance.apply({ modelId: model.id, operation, expectedRevision: preview.revision, expectedInventoryDigest: preview.inventoryDigest }).lifecycle).toBe(operation === 'archive' ? 'archived' : 'disabled');
    }
    const file = join(dir, 'models.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
    const archived = saved.models.find((m: { id: string }) => m.id === model.id);
    saved.models.push({ ...archived, id: 'conflict', lifecycle: 'active' }); writeFileSync(file, JSON.stringify(saved));
    preview = maintenance.preview(model.id); const before = readFileSync(file, 'utf8');
    expect(() => maintenance.apply({ modelId: model.id, operation: 'restore', expectedRevision: preview.revision, expectedInventoryDigest: preview.inventoryDigest })).toThrow('MODEL_RESTORE_CONFLICT');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('无 ID 的可能引用阻止归档及克隆，运行与暂停快照保持原样', () => {
    const { dir, secrets, model, maintenance, library } = fixture();
    const store = new MemoryStore(); let manager = new RoomManager({ store, secrets, modelsPath: join(dir, 'models.json'), tickMs: 0 });
    const { roomId, hostToken } = manager.createRoom();
    manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, presetId: model.id, modelId: null }] });
    manager.dispose(); const saved = store.rooms.get(roomId)!;
    expect(saved.seats[0].modelId).toBeNull();
    mkdirSync(join(dir, 'rooms')); const file = join(dir, 'rooms', `${roomId}.json`);
    for (const paused of [false, true]) {
      const running = { ...saved, status: 'running', paused }; writeFileSync(file, JSON.stringify(running));
      const before = readFileSync(file, 'utf8'), impact = maintenance.preview(model.id);
      expect(impact.possibleRefs).toHaveLength(1); expect(impact.canArchive).toBe(false);
      expect(() => maintenance.apply({ modelId: model.id, operation: 'archive', expectedRevision: impact.revision, expectedInventoryDigest: impact.inventoryDigest })).toThrow('MODEL_IN_USE');
      expect(readFileSync(file, 'utf8')).toBe(before);
    }
    library.setLifecycle(model.id, 'disabled');
    manager = new RoomManager({ store, secrets, modelsPath: join(dir, 'models.json'), tickMs: 0 });
    try { expect(() => manager.cloneRoom(roomId, hostToken)).toThrow('模型已停用'); }
    finally { manager.dispose(); }
  });
  it('有官方映射的别名可归并，旧房间 ID 解析到规范项并保留原快照及密钥', () => {
    const { dir, secrets, library, model: target, maintenance } = fixture();
    const source = library.add('old-preview', target.baseUrl, 'secret');
    const store = new MemoryStore(); let manager = new RoomManager({ store, secrets, modelsPath: join(dir, 'models.json'), tickMs: 0 });
    const { roomId, hostToken } = manager.createRoom();
    manager.updateSetup(roomId, hostToken, { seats: [{ seat: 1, presetId: source.id }] }); manager.dispose();
    const original = structuredClone(store.rooms.get(roomId)!.seats[0]);
    const sourceTarget = maintenance.preview(source.id).evidenceTarget;
    const mapping: ModelAliasEvidence = { kind: 'official_same_model', sourceModel: source.model, targetModel: target.model, protocol: sourceTarget.protocol!, providerId: sourceTarget.providerId, routeId: sourceTarget.scope.routeId, checkedAt: '2025-01-01', sourceUrl: 'https://example.com/announcement', sourceDigest: 'a'.repeat(64), summary: '官方声明预览名称路由到正式模型' };
    expect(() => maintenance.previewMerge(source.id, target.id)).toThrow('MODEL_ALIAS_EVIDENCE_INVALID');
    let impact = maintenance.previewMerge(source.id, target.id, mapping);
    expect(impact.equivalence).toBe('official_alias');
    maintenance.merge(source.id, target.id, impact.revision, impact.inventoryDigest, mapping);
    const loaded = new ModelLibrary(secrets, join(dir, 'models.json'));
    expect(loaded.findRaw(source.id)?.apiKey).toBe('secret'); expect(loaded.find(source.id)?.id).toBe(target.id);
    expect(loaded.views().some((m) => m.id === source.id)).toBe(false);
    expect(store.rooms.get(roomId)!.seats[0]).toEqual(original);
    mkdirSync(join(dir, 'rooms'));
    writeFileSync(join(dir, 'rooms', 'possible.json'), JSON.stringify({ id: 'possible', status: 'setup', paused: false, seats: [{ seat: 1, controller: 'ai', adapter: 'openai_compatible', modelId: null, model: source.model, baseUrl: source.baseUrl }] }));
    expect(maintenance.preview(target.id).possibleRefs).toHaveLength(1);
    impact = maintenance.previewMerge(source.id, target.id, mapping);
    expect(impact.alreadyMerged).toBe(true);
    expect(maintenance.merge(source.id, target.id, impact.revision, impact.inventoryDigest, mapping).alreadyMerged).toBe(true);
    const file = join(dir, 'models.json'), originalLibrary = readFileSync(file, 'utf8'), corrupt = JSON.parse(originalLibrary);
    corrupt.models.find((m: { id: string }) => m.id === target.id).apiKeyEnc = secrets.encrypt('other');
    writeFileSync(file, JSON.stringify(corrupt));
    expect(() => new ModelLibrary(secrets, file)).toThrow('别名配置不一致');
    writeFileSync(file, originalLibrary);
    manager = new RoomManager({ store, secrets, modelsPath: join(dir, 'models.json'), tickMs: 0, adapters: { openai_compatible: { decide: () => new Promise(() => {}) } }, sleep: async () => {} });
    try {
      expect(manager.getSetup(roomId, hostToken).seats[0].modelId).toBe(target.id);
      expect(() => manager.cloneRoom(roomId, hostToken)).not.toThrow();
      expect(() => manager.start(roomId, hostToken)).not.toThrow();
    } finally { manager.dispose(); }
  });
  it('相同模型重复配置可无公告合并；密钥、地址、协议、状态、陈旧盘点及链不符均拒绝', () => {
    const { dir, secrets, library, model, maintenance } = fixture();
    const file = join(dir, 'models.json'), raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.models.push({ ...raw.models[0], id: 'duplicate' }); writeFileSync(file, JSON.stringify(raw));
    const preview = maintenance.previewMerge('duplicate', model.id);
    expect(preview.equivalence).toBe('identical_model');
    mkdirSync(join(dir, 'rooms')); writeFileSync(join(dir, 'rooms', 'one.json'), JSON.stringify({ id: 'one', status: 'setup', paused: false, seats: [{ seat: 1, controller: 'ai', adapter: 'mock' }] }));
    expect(() => maintenance.merge('duplicate', model.id, preview.revision, preview.inventoryDigest)).toThrow('MODEL_PREVIEW_STALE');
    const changed = JSON.parse(readFileSync(file, 'utf8'));
    changed.models.find((m: { id: string }) => m.id === 'duplicate').apiKeyEnc = secrets.encrypt('other'); writeFileSync(file, JSON.stringify(changed));
    expect(() => maintenance.previewMerge('duplicate', model.id)).toThrow('MODEL_MERGE_MISMATCH');
    changed.models.find((m: { id: string }) => m.id === 'duplicate').apiKeyEnc = 'v1.bad'; writeFileSync(file, JSON.stringify(changed));
    expect(() => maintenance.previewMerge('duplicate', model.id)).toThrow('MODEL_MERGE_MISMATCH');
    changed.models.find((m: { id: string }) => m.id === 'duplicate').apiKeyEnc = changed.models.find((m: { id: string }) => m.id === model.id).apiKeyEnc;
    changed.models.find((m: { id: string }) => m.id === 'duplicate').baseUrl = 'https://other.example/v1'; writeFileSync(file, JSON.stringify(changed));
    expect(() => maintenance.previewMerge('duplicate', model.id)).toThrow('MODEL_MERGE_MISMATCH');
    changed.models.find((m: { id: string }) => m.id === 'duplicate').baseUrl = model.baseUrl;
    changed.models.find((m: { id: string }) => m.id === 'duplicate').apiProtocol = 'responses'; writeFileSync(file, JSON.stringify(changed));
    expect(() => maintenance.previewMerge('duplicate', model.id)).toThrow('MODEL_MERGE_MISMATCH');
    changed.models.find((m: { id: string }) => m.id === 'duplicate').apiProtocol = 'chat_completions';
    changed.models.find((m: { id: string }) => m.id === 'duplicate').lifecycle = 'disabled'; writeFileSync(file, JSON.stringify(changed));
    expect(() => maintenance.previewMerge('duplicate', model.id)).toThrow('MODEL_MERGE_CONFLICT');
    changed.models.find((m: { id: string }) => m.id === 'duplicate').lifecycle = 'active'; writeFileSync(file, JSON.stringify(changed));
    const ready = maintenance.previewMerge('duplicate', model.id); maintenance.merge('duplicate', model.id, ready.revision, ready.inventoryDigest);
    expect(() => maintenance.previewMerge(model.id, 'duplicate')).toThrow('MODEL_MERGE_CONFLICT');
    expect(() => maintenance.previewMerge(model.id, model.id)).toThrow('MODEL_MERGE_CONFLICT');
    void library;
  });
  it('规范模型归档恢复不与其自身别名冲突；缺失目标或循环的库拒绝加载', () => {
    const { dir, secrets, model, maintenance } = fixture(), file = join(dir, 'models.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')); saved.models.push({ ...saved.models[0], id: 'duplicate' }); writeFileSync(file, JSON.stringify(saved));
    const merge = maintenance.previewMerge('duplicate', model.id); maintenance.merge('duplicate', model.id, merge.revision, merge.inventoryDigest);
    let preview = maintenance.preview(model.id);
    maintenance.apply({ modelId: model.id, operation: 'archive', expectedRevision: preview.revision, expectedInventoryDigest: preview.inventoryDigest });
    preview = maintenance.preview(model.id);
    expect(maintenance.apply({ modelId: model.id, operation: 'restore', expectedRevision: preview.revision, expectedInventoryDigest: preview.inventoryDigest }).lifecycle).toBe('disabled');
    const valid = readFileSync(file, 'utf8'), broken = JSON.parse(valid);
    broken.models.find((m: { id: string }) => m.id === 'duplicate').mergedInto = 'missing'; writeFileSync(file, JSON.stringify(broken));
    expect(() => new ModelLibrary(secrets, file)).toThrow('别名关系无效');
    broken.models.find((m: { id: string }) => m.id === 'duplicate').mergedInto = model.id;
    broken.models.find((m: { id: string }) => m.id === model.id).mergedInto = 'duplicate'; writeFileSync(file, JSON.stringify(broken));
    expect(() => new ModelLibrary(secrets, file)).toThrow('别名关系无效');
  });
});
