import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelPresetView } from '@werewolf/protocol';
import { chatBase, loadQwenPresets } from './qwen-presets';
import type { SecretBox } from './secret';

interface SavedModel {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnc: string;
}

export interface ResolvedModel {
  id: string;
  label: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
  source: 'settings' | 'added';
}

/** 模型名单：页面里添加的保存在 data/，settings.json 里的只读合并进来。密钥不以明文落盘或返回。 */
export class ModelLibrary {
  private added: SavedModel[] = [];

  constructor(
    private readonly secrets: SecretBox,
    private readonly file?: string,
  ) {
    if (!file || !existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { models?: SavedModel[] };
      this.added = (parsed.models ?? []).filter((m) => m && m.id && m.name && m.baseUrl && m.apiKeyEnc);
    } catch {
      this.added = [];
    }
  }

  list(): ResolvedModel[] {
    const settings = loadQwenPresets().map((preset) => ({
      id: preset.id,
      label: preset.label,
      model: preset.model,
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      source: 'settings' as const,
    }));
    const added = this.added.map((m) => ({
      id: m.id,
      label: m.name,
      model: m.name,
      baseUrl: m.baseUrl,
      apiKey: this.keyOf(m),
      source: 'added' as const,
    }));
    return [...added, ...settings];
  }

  views(): ModelPresetView[] {
    return this.list().map((m) => ({
      id: m.id,
      label: m.label,
      model: m.model,
      baseUrl: m.baseUrl,
      hasKey: !!m.apiKey,
      source: m.source,
    }));
  }

  find(id: string): ResolvedModel | undefined {
    return this.list().find((m) => m.id === id);
  }

  add(name: string, baseUrl: string, apiKey: string): ModelPresetView {
    const model = name.trim();
    const url = chatBase(baseUrl);
    const key = apiKey.trim();
    if (!model) throw new Error('请填写模型名称');
    if (!url) throw new Error('请填写接口地址');
    if (!key) throw new Error('请填写密钥');
    if (this.added.some((m) => m.name === model && m.baseUrl === url)) throw new Error('这个名称和地址已经添加过了');
    const saved: SavedModel = {
      id: `m_${randomBytes(8).toString('hex')}`,
      name: model.slice(0, 120),
      baseUrl: url.slice(0, 300),
      apiKeyEnc: this.secrets.encrypt(key),
    };
    this.added.unshift(saved);
    this.persist();
    return {
      id: saved.id,
      label: saved.name,
      model: saved.name,
      baseUrl: saved.baseUrl,
      hasKey: true,
      source: 'added',
    };
  }

  remove(id: string): void {
    if (this.list().some((m) => m.id === id && m.source === 'settings')) throw new Error('settings 里的模型不能在这里删除');
    const next = this.added.filter((m) => m.id !== id);
    if (next.length === this.added.length) throw new Error('没有这个模型');
    this.added = next;
    this.persist();
  }

  private keyOf(m: SavedModel): string | null {
    try {
      const key = this.secrets.decrypt(m.apiKeyEnc);
      return key || null;
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ models: this.added }));
    renameSync(tmp, this.file);
  }
}
