import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { apiBase, type ApiProtocol, type ModelPresetView } from '@werewolf/protocol';
import { loadQwenPresets } from './qwen-presets';
import type { SecretBox } from './secret';

interface SavedModel {
  apiProtocol?: ApiProtocol;
  id: string;
  name: string;
  model?: string;
  source?: 'imported' | 'added';
  baseUrl: string;
  apiKeyEnc: string | null;
}

export interface ResolvedModel {
  apiProtocol: ApiProtocol;
  id: string;
  label: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
  source: 'imported' | 'added';
}

/** 运行时只读取项目模型库；外部配置仅由显式的一次性迁移读取。 */
export class ModelLibrary {
  private added: SavedModel[] = [];
  private legacyImported = false;

  constructor(
    private readonly secrets: SecretBox,
    private readonly file?: string,
  ) {
    if (!file || !existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; legacyImported?: boolean; models?: SavedModel[] };
    if ((parsed.version !== undefined && parsed.version !== 2) || !Array.isArray(parsed.models) || parsed.models.some((m) => !m || !m.id || !m.name || !m.baseUrl || (m.apiKeyEnc !== null && typeof m.apiKeyEnc !== 'string'))) throw Error('项目模型库格式无效，请检查 models.json；原文件未被覆盖');
    this.added = parsed.models;
    this.legacyImported = parsed.legacyImported === true;
  }

  list(): ResolvedModel[] {
    return this.added.map((m) => ({
      id: m.id,
      label: m.name,
      model: m.model ?? m.name,
      baseUrl: m.baseUrl,
      apiProtocol: m.apiProtocol ?? 'chat_completions',
      apiKey: this.keyOf(m),
      source: m.source ?? 'added',
    }));
  }

  /** 显式迁移一次，保留旧 ID、实际模型名、协议及现有密文；删除后不会重新导入。 */
  importLegacySettings(): number {
    if (this.legacyImported) return 0;
    const presets = loadQwenPresets();
    if (!presets.length) return 0;
    const imported = presets.filter((preset) => !this.added.some((model) => model.id === preset.id)).map((preset): SavedModel => ({
      id: preset.id, name: preset.label, model: preset.model, baseUrl: preset.baseUrl,
      apiProtocol: preset.apiProtocol ?? 'chat_completions', source: 'imported', apiKeyEnc: preset.apiKey ? this.secrets.encrypt(preset.apiKey) : null,
    }));
    const previous = this.added; this.added = [...this.added, ...imported]; this.legacyImported = true;
    try { this.persist(); } catch (error) { this.added = previous; this.legacyImported = false; throw error; }
    return imported.length;
  }

  views(): ModelPresetView[] {
    return this.list().map((m) => ({
      id: m.id,
      label: m.label,
      model: m.model,
      baseUrl: m.baseUrl,
      apiProtocol: m.apiProtocol,
      hasKey: !!m.apiKey,
      source: m.source,
    }));
  }

  find(id: string): ResolvedModel | undefined {
    return this.list().find((m) => m.id === id);
  }

  add(name: string, baseUrl: string, apiKey: string, protocol: ApiProtocol = 'chat_completions'): ModelPresetView {
    const model = name.trim();
    const url = apiBase(baseUrl, protocol);
    const key = apiKey.trim();
    if (!model) throw new Error('请填写模型名称');
    if (!url) throw new Error('请填写接口地址');
    if (!key) throw new Error('请填写密钥');
    if (this.added.some((m) => (m.model ?? m.name) === model && m.baseUrl === url && (m.apiProtocol ?? 'chat_completions') === protocol)) throw new Error('这个名称、地址和协议已经添加过了');
    const saved: SavedModel = {
      id: `m_${randomBytes(8).toString('hex')}`,
      name: model.slice(0, 120),
      apiProtocol: protocol,
      baseUrl: url.slice(0, 300),
      apiKeyEnc: this.secrets.encrypt(key),
    };
    const previous = this.added; this.added = [saved, ...this.added];
    try { this.persist(); } catch (error) { this.added = previous; throw error; }
    return {
      id: saved.id,
      label: saved.name,
      model: saved.name,
      baseUrl: saved.baseUrl,
      apiProtocol: protocol,
      hasKey: true,
      source: 'added',
    };
  }

  remove(id: string): void {
    const next = this.added.filter((m) => m.id !== id);
    if (next.length === this.added.length) throw new Error('没有这个模型');
    const previous = this.added; this.added = next;
    try { this.persist(); } catch (error) { this.added = previous; throw error; }
  }

  private keyOf(m: SavedModel): string | null {
    try {
      const key = m.apiKeyEnc ? this.secrets.decrypt(m.apiKeyEnc) : null;
      return key || null;
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 2, legacyImported: this.legacyImported, models: this.added }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
