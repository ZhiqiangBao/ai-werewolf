import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { apiBase, apiUrl, type ApiProtocol, type ModelPresetView } from '@werewolf/protocol';
import { loadQwenPresets } from './qwen-presets';
import type { SecretBox } from './secret';
import { isScopeBinding, type EvidenceScopeBinding, type RetirementEvidence } from './model-retirement';

interface SavedModel {
  lifecycle?: ModelLifecycle;
  evidence?: RetirementEvidence[];
  maintenanceScope?: EvidenceScopeBinding;
  mergedInto?: string;
  mergeEvidence?: unknown;
  apiProtocol?: ApiProtocol;
  id: string;
  name: string;
  model?: string;
  source?: 'imported' | 'added';
  baseUrl: string;
  apiKeyEnc: string | null;
}

export type ModelLifecycle = 'active' | 'disabled' | 'archived';

export function sameModelRoute(a: string, b: string, protocol: ApiProtocol): boolean {
  try { return new URL(apiUrl(a, protocol)).href === new URL(apiUrl(b, protocol)).href; } catch { return false; }
}

export interface ResolvedModel {
  lifecycle: ModelLifecycle;
  evidence: RetirementEvidence[];
  maintenanceScope?: EvidenceScopeBinding;
  mergedInto?: string;
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
    if ((parsed.version !== undefined && parsed.version !== 2) || !Array.isArray(parsed.models) || parsed.models.some((m) => !m || !m.id || !m.name || !m.baseUrl || (m.apiKeyEnc !== null && typeof m.apiKeyEnc !== 'string') || (m.lifecycle !== undefined && !['active', 'disabled', 'archived'].includes(m.lifecycle)))) throw Error('项目模型库格式无效，请检查 models.json；原文件未被覆盖');
    const models = parsed.models;
    if (models.some((m) => m.maintenanceScope !== undefined && (!isScopeBinding(m.maintenanceScope) || 'routeId' in m.maintenanceScope))) throw Error('项目模型库维护作用域无效；原文件未被覆盖');
    const ids = new Set(models.map((m) => m.id));
    if (ids.size !== models.length || models.some((m) => m.mergedInto !== undefined && (typeof m.mergedInto !== 'string' || m.mergedInto === m.id || !ids.has(m.mergedInto) || models.find((target) => target.id === m.mergedInto)?.mergedInto !== undefined))) throw Error('项目模型库别名关系无效；原文件未被覆盖');
    this.added = models;
    this.legacyImported = parsed.legacyImported === true;
    for (const model of models.filter((m) => m.mergedInto)) {
      const source = this.findRaw(model.id)!, target = this.findRaw(model.mergedInto!)!;
      const evidence = model.mergeEvidence as Record<string, unknown> | undefined;
      try {
        if (source.lifecycle !== 'active' || !source.apiKey || source.apiKey !== target.apiKey || source.apiProtocol !== target.apiProtocol || new URL(apiUrl(source.baseUrl, source.apiProtocol)).href !== new URL(apiUrl(target.baseUrl, target.apiProtocol)).href) throw Error();
        if (source.model === target.model) {
          if (evidence?.kind !== 'identical_model' && evidence?.kind !== 'official_same_model') throw Error();
        } else {
          const route = new URL(source.baseUrl);
          const routeId = createHash('sha256').update(route.origin.toLowerCase() + route.pathname).digest('hex');
          const url = new URL(String(evidence?.sourceUrl ?? ''));
          if (evidence?.kind !== 'official_same_model' || evidence.sourceModel !== source.model || evidence.targetModel !== target.model || evidence.protocol !== source.apiProtocol || evidence.providerId !== route.hostname.toLowerCase() || evidence.routeId !== routeId || !/^[a-f0-9]{64}$/i.test(String(evidence.sourceDigest ?? '')) || !Number.isFinite(Date.parse(String(evidence.checkedAt ?? ''))) || Date.parse(String(evidence.checkedAt)) > Date.now() || typeof evidence.summary !== 'string' || !evidence.summary || evidence.summary.length > 500 || /(?:sk-[\w-]{8,}|bearer\s+\S+|https?:\/\/\S+)/i.test(evidence.summary) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error();
        }
      } catch { throw Error('项目模型库别名配置不一致；原文件未被覆盖'); }
    }
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
      lifecycle: m.lifecycle ?? 'active',
      evidence: m.evidence ?? [],
      ...(m.maintenanceScope ? { maintenanceScope: structuredClone(m.maintenanceScope) } : {}),
      ...(m.mergedInto ? { mergedInto: m.mergedInto } : {}),
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
    return this.list().filter((m) => !m.mergedInto).map((m) => ({
      id: m.id,
      label: m.label,
      model: m.model,
      baseUrl: m.baseUrl,
      apiProtocol: m.apiProtocol,
      hasKey: !!m.apiKey,
      source: m.source,
      lifecycle: m.lifecycle,
    }));
  }

  find(id: string): ResolvedModel | undefined {
    const models = this.list();
    const model = models.find((m) => m.id === id);
    return model?.mergedInto ? models.find((m) => m.id === model.mergedInto && !m.mergedInto) : model;
  }

  findRaw(id: string): ResolvedModel | undefined { return this.list().find((m) => m.id === id); }

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
    void id;
    throw new Error('MODEL_MAINTENANCE_REQUIRED');
  }

  revision(): string {
    return createHash('sha256').update(JSON.stringify({ legacyImported: this.legacyImported, models: this.added })).digest('hex');
  }

  setLifecycle(id: string, lifecycle: ModelLifecycle): void {
    const index = this.added.findIndex((m) => m.id === id);
    if (index < 0) throw new Error('MODEL_NOT_FOUND');
    const previous = this.added;
    this.added = previous.map((m, i) => i === index ? { ...m, lifecycle } : m);
    try { this.persist(); } catch (error) { this.added = previous; throw error; }
  }

  addEvidence(id: string, evidence: RetirementEvidence): void {
    const index = this.added.findIndex((m) => m.id === id);
    if (index < 0) throw new Error('MODEL_NOT_FOUND');
    const previous = this.added;
    this.added = previous.map((m, i) => i === index ? { ...m, evidence: [...(m.evidence ?? []), evidence] } : m);
    try { this.persist(); } catch (error) { this.added = previous; throw error; }
  }

  setMaintenanceScope(id: string, scope: EvidenceScopeBinding): void {
    if (!isScopeBinding(scope) || 'routeId' in scope) throw new Error('MODEL_SCOPE_INVALID');
    const index = this.added.findIndex((m) => m.id === id);
    if (index < 0) throw new Error('MODEL_NOT_FOUND');
    const previous = this.added;
    this.added = previous.map((m, i) => i === index ? { ...m, maintenanceScope: structuredClone(scope) } : m);
    try { this.persist(); } catch (error) { this.added = previous; throw error; }
  }

  merge(sourceId: string, targetId: string, evidence: unknown): void {
    const source = this.added.find((m) => m.id === sourceId), target = this.added.find((m) => m.id === targetId);
    if (!source || !target) throw new Error('MODEL_NOT_FOUND');
    if (source.id === target.id || target.mergedInto || this.added.some((m) => m.mergedInto === sourceId)) throw new Error('MODEL_MERGE_CONFLICT');
    if (source.mergedInto) {
      if (source.mergedInto === targetId) return;
      throw new Error('MODEL_MERGE_CONFLICT');
    }
    if ((source.lifecycle ?? 'active') !== 'active' || (target.lifecycle ?? 'active') !== 'active') throw new Error('MODEL_MERGE_CONFLICT');
    const previous = this.added;
    this.added = previous.map((m) => m.id === sourceId ? { ...m, mergedInto: targetId, mergeEvidence: evidence } : m);
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
