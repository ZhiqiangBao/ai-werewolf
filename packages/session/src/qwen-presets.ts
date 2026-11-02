import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apiBase, apiProtocol, type ApiProtocol, type ModelPresetView } from '@werewolf/protocol';

/** 读到的一条模型配置。apiKey 只在服务端内存里使用，不能放进接口响应或仓库。 */
export interface QwenPreset {
  apiProtocol?: ApiProtocol;
  id: string;
  label: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
}

const IMAGE = /image|wan\d|z-image|cogview|flux/i;

function resolveEnv(template: string, env: Record<string, string>): string {
  return template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name: string) => env[name] ?? '');
}

/** OpenAI SDK 会自己补 /v1，这里的适配器不会，所以把裸域名补成兼容地址。 */
export function chatBase(url: string): string {
  return apiBase(url, 'chat_completions');
}

function mergedEnv(raw: Record<string, unknown>, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string' && value) out[key] = value;
  const fileEnv = raw.env;
  if (!fileEnv || typeof fileEnv !== 'object') return out;
  for (const [key, value] of Object.entries(fileEnv as Record<string, unknown>)) {
    if (typeof value === 'string' && value && /API_KEY|BASE_URL|TOKEN/i.test(key)) out[key] = value;
  }
  return out;
}

/** 从 Qwen Code 的 settings 对象抽出对话模型。密钥来自 envKey 指向的环境变量或 settings.env。 */
export function presetsFromQwenSettings(raw: unknown, env: Record<string, string | undefined> = {}): QwenPreset[] {
  if (!raw || typeof raw !== 'object') return [];
  const doc = raw as Record<string, unknown>;
  const values = mergedEnv(doc, env);
  const groups = doc.modelProviders as Record<string, unknown> | undefined;
  const providers = [['openai', 'chat_completions'], ['responses', 'responses'], ['anthropic', 'anthropic_messages']].flatMap(([key, protocol]) =>
    Array.isArray(groups?.[key]) ? (groups[key] as unknown[]).map((item) => ({ item, protocol })) : []);
  const out: QwenPreset[] = [];
  const seen = new Set<string>();
  for (const { item, protocol: groupProtocol } of providers) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const model = typeof row.id === 'string' ? row.id.trim() : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!model || IMAGE.test(model) || IMAGE.test(name)) continue;
    let protocol: ApiProtocol; let baseUrl: string;
    try {
      protocol = apiProtocol(row.apiProtocol ?? groupProtocol);
      baseUrl = apiBase(resolveEnv(typeof row.baseUrl === 'string' ? row.baseUrl : '', values), protocol);
    } catch { continue; }
    if (!baseUrl) continue;
    const dedupe = `${baseUrl}\n${model}${protocol === 'chat_completions' ? '' : `\n${protocol}`}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const envKey = typeof row.envKey === 'string' ? row.envKey : '';
    const apiKey = envKey && values[envKey] ? values[envKey].trim() : '';
    out.push({
      id: createHash('sha256').update(dedupe).digest('base64url').slice(0, 16),
      label: name || model,
      model,
      baseUrl,
      apiProtocol: protocol,
      apiKey: apiKey || null,
    });
  }
  const counts = new Map<string, number>();
  for (const preset of out) counts.set(preset.label, (counts.get(preset.label) ?? 0) + 1);
  for (const preset of out) {
    if ((counts.get(preset.label) ?? 0) < 2) continue;
    try {
      preset.label = `${preset.label} · ${new URL(preset.baseUrl).host}`;
    } catch {
      preset.label = `${preset.label} · ${preset.baseUrl}`;
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  return out;
}

export function presetView(preset: QwenPreset): ModelPresetView {
  return { id: preset.id, label: preset.label, model: preset.model, baseUrl: preset.baseUrl, apiProtocol: preset.apiProtocol ?? 'chat_completions', hasKey: !!preset.apiKey, source: 'settings' };
}

/** 仅供显式迁移读取旧配置；运行时模型库和 TTS 不调用此函数。 */
export function loadQwenPresets(): QwenPreset[] {
  const file = process.env.WEREWOLF_QWEN_SETTINGS || join(homedir(), '.qwen', 'settings.json');
  if (!existsSync(file)) return [];
  try {
    return presetsFromQwenSettings(JSON.parse(readFileSync(file, 'utf8')) as unknown, process.env);
  } catch {
    return [];
  }
}
