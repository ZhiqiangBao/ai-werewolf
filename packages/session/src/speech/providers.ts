import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { synthesizeQwen } from './qwen';
import { MIMO_MODEL, mimoConnection, mimoRequest, synthesizeMimo, type MimoOptions } from './mimo';
import type { VoiceProfile } from './types';

export interface SpeechAudio { bytes: Uint8Array; mimeType: string }
/** 只接收已授权的原文；地址、认证与模型配置由服务端确定。 */
export interface SpeechProvider {
  id: string;
  label: string;
  cacheIdentity: unknown;
  synthesize(text: string, signal: AbortSignal): Promise<SpeechAudio>;
}
interface CommonConfig { id: string; label: string; cacheVersion?: string }
interface QwenConfig extends CommonConfig { type: 'qwen-token-plan'; model?: string; voice?: string; rate?: number; instruction?: string }
interface QwenHttpConfig extends Omit<QwenConfig, 'type'> { type: 'qwen-http'; endpoint: string }
interface MimoConfig extends CommonConfig, Omit<MimoOptions, 'signal'> { type: 'xiaomi-mimo'; model?: string; voice?: string; rate?: number; instruction?: string }
interface HttpConfig extends CommonConfig {
  type: 'http-audio'; endpoint: string; body: unknown; headers?: Record<string, string>;
  apiKeyEnv?: string; apiKeyHeader?: string; apiKeyPrefix?: string; mimeType?: string;
}
interface HttpJsonConfig extends Omit<HttpConfig, 'type'> {
  type: 'http-json-audio'; audioPath: string; encoding: 'base64' | 'hex'; mimeType: string;
  statusPath?: string; statusValue?: string | number;
  completionPath?: string; completionValue?: string | number;
}
interface ModuleConfig extends CommonConfig { type: 'module'; module: string; options?: Record<string, unknown> }
export type SpeechProviderConfig = QwenConfig | QwenHttpConfig | MimoConfig | HttpConfig | HttpJsonConfig | ModuleConfig;
export interface SpeechConfig { providers: SpeechProviderConfig[]; defaultProviderId?: string }
export const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
  providers: [{ id: 'qwen-token-plan', label: 'Token Plan Qwen', type: 'qwen-token-plan' }], defaultProviderId: 'qwen-token-plan',
};
/** Configured MiMo routes are offered as choices; the existing default stays Qwen. */
export function defaultSpeechConfig(): SpeechConfig {
  const providers = [...DEFAULT_SPEECH_CONFIG.providers];
  if (process.env.XIAOMI_MIMO_API_KEY?.trim()) providers.push({ id: 'xiaomi-mimo', label: '小米 MiMo', type: 'xiaomi-mimo' });
  if (process.env.XIAOMI_MIMO_TOKEN_PLAN_KEY?.trim() && process.env.XIAOMI_MIMO_TOKEN_PLAN_URL?.trim()) {
    providers.push({ id: 'xiaomi-mimo-token-plan', label: '小米 MiMo Token Plan', type: 'xiaomi-mimo', billing: 'token-plan' });
  }
  return { providers, defaultProviderId: DEFAULT_SPEECH_CONFIG.defaultProviderId };
}

function interpolate(value: unknown, text: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{{text}}', () => text);
  if (Array.isArray(value)) return value.map((item) => interpolate(item, text));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, text)]));
  return value;
}
async function boundedAudio(response: Response, limit = 40 * 1024 * 1024): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) throw Error('Audio is too large');
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw Error('Missing audio');
  for await (const chunk of response.body) {
    size += chunk.length; if (size > limit) throw Error('Audio is too large'); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function field(value: unknown, path: string): unknown {
  if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(path)) throw Error('Invalid audio response path');
  return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' && Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined, value);
}
export function speechProvider(config: SpeechProviderConfig, directory: string, configDirectory: string, credentials?: { apiKey: string }): SpeechProvider {
  if (!config || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.id) || config.id === 'browser' || typeof config.label !== 'string' || !config.label.trim()) throw Error('Invalid speech provider identity');
  const base = { id: config.id, label: config.label, cacheIdentity: config };
  if (config.type === 'xiaomi-mimo') {
    const model = config.model ?? MIMO_MODEL;
    const profile: VoiceProfile = { voice: config.voice ?? '苏打', label: '公开发言朗读', rate: config.rate ?? 1,
      instruction: config.instruction ?? '请用自然清晰的普通话朗读，准确读出玩家号码。' };
    const connection = mimoConnection(config);
    mimoRequest('配置检查', profile, model);
    return { ...base, cacheIdentity: { ...config, connection, model, profile, version: 1 },
      async synthesize(text, signal) { return { bytes: await synthesizeMimo(text, profile, model, { ...config, signal }), mimeType: 'audio/wav' }; } };
  }
  if (config.type === 'qwen-token-plan' || config.type === 'qwen-http') {
    if (config.type === 'qwen-http') {
      const url = new URL(config.endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !credentials) throw Error('Invalid explicit Qwen speech configuration');
    }
    const model = config.model ?? 'qwen-audio-3.0-tts-plus';
    const profile: VoiceProfile = {
      voice: config.voice ?? 'qwen-audio-3.0-tts-plus-longshuojizhu', label: '公开发言朗读', rate: config.rate ?? 1.08,
      instruction: config.instruction ?? '请用普通话自然清楚地朗读给定原文，准确读出玩家号码。只读原文，不添加或改写内容。',
    };
    if (!Number.isFinite(profile.rate) || profile.rate <= 0) throw Error('Invalid speech rate');
    const route = config.type === 'qwen-http' ? { endpoint: config.endpoint, credential: createHash('sha256').update(credentials!.apiKey).digest('hex') } : {};
    return { ...base, cacheIdentity: { ...config, model, profile, ...route }, async synthesize(text, signal) {
      const key = createHash('sha256').update(JSON.stringify({ ...route, model, profile, text })).digest('hex');
      const output = join(directory, key + '.wav');
      await synthesizeQwen(text, profile, model, output, { signal, ...(config.type === 'qwen-http' ? { endpoint: config.endpoint, apiKey: credentials!.apiKey } : {}) });
      return { bytes: await readFile(output), mimeType: 'audio/wav' };
    } };
  }
  if (config.type === 'http-audio' || config.type === 'http-json-audio') {
    const endpoint = new URL(config.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw Error('Invalid speech endpoint');
    if (!config.body || typeof config.body !== 'object' || !JSON.stringify(config.body).includes('{{text}}')) throw Error('Speech request body must contain {{text}}');
    if (config.type === 'http-json-audio') {
      field({}, config.audioPath);
      if (!['base64', 'hex'].includes(config.encoding)) throw Error('Invalid audio encoding');
      if (config.statusPath) field({}, config.statusPath);
      if (config.completionPath) field({}, config.completionPath);
    }
    const credential = credentials || config.apiKeyEnv ? createHash('sha256').update(credentials?.apiKey ?? process.env[config.apiKeyEnv!] ?? '').digest('hex') : undefined;
    return { ...base, cacheIdentity: { ...config, credential }, async synthesize(text, signal) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...config.headers };
      if (credentials || config.apiKeyEnv) {
        const key = credentials?.apiKey ?? process.env[config.apiKeyEnv!];
        if (!key) throw Error('Speech credential is not configured');
        headers[config.apiKeyHeader ?? 'Authorization'] = `${config.apiKeyPrefix ?? 'Bearer '}${key}`;
      }
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(interpolate(config.body, text)), signal, redirect: 'error' });
      if (!response.ok) throw Error(`Speech provider HTTP ${response.status}`);
      if (config.type === 'http-json-audio') {
        let body: unknown;
        try { body = JSON.parse((await boundedAudio(response, 60 * 1024 * 1024)).toString('utf8')); }
        catch { throw Error('Invalid speech JSON audio response'); }
        if (config.statusPath && field(body, config.statusPath) !== config.statusValue) throw Error('Speech provider did not complete successfully');
        if (config.completionPath && field(body, config.completionPath) !== config.completionValue) throw Error('Speech provider returned incomplete audio');
        const encoded = field(body, config.audioPath);
        if (typeof encoded !== 'string' || !encoded.length || (config.encoding === 'base64' ? encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) : encoded.length % 2 || !/^[a-fA-F0-9]+$/.test(encoded))) throw Error('Invalid encoded speech audio');
        return { bytes: Buffer.from(encoded, config.encoding), mimeType: config.mimeType };
      }
      return { bytes: await boundedAudio(response), mimeType: config.mimeType ?? response.headers.get('content-type')?.split(';')[0].trim() ?? '' };
    } };
  }
  if (config.type === 'module') {
    if (typeof config.module !== 'string' || !config.module) throw Error('Missing speech adapter module');
    const url = pathToFileURL(resolve(configDirectory, config.module)).href;
    let adapter: Promise<(input: { text: string; options: Record<string, unknown>; signal: AbortSignal }) => Promise<SpeechAudio>> | undefined;
    return { ...base, async synthesize(text, signal) {
      adapter ??= import(url).then((module) => {
        if (typeof module.synthesize !== 'function') throw Error('Speech adapter must export synthesize');
        return module.synthesize;
      });
      return (await adapter)({ text, options: config.options ?? {}, signal });
    } };
  }
  throw Error('Unknown speech provider type');
}
