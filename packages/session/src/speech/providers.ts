import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { synthesizeQwen } from './qwen';
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
interface HttpConfig extends CommonConfig {
  type: 'http-audio'; endpoint: string; body: unknown; headers?: Record<string, string>;
  apiKeyEnv?: string; apiKeyHeader?: string; apiKeyPrefix?: string; mimeType?: string;
}
interface ModuleConfig extends CommonConfig { type: 'module'; module: string; options?: Record<string, unknown> }
export type SpeechProviderConfig = QwenConfig | HttpConfig | ModuleConfig;
export interface SpeechConfig { providers: SpeechProviderConfig[]; defaultProviderId?: string }
export const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
  providers: [{ id: 'qwen-token-plan', label: 'Token Plan Qwen', type: 'qwen-token-plan' }], defaultProviderId: 'qwen-token-plan',
};

function interpolate(value: unknown, text: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{{text}}', () => text);
  if (Array.isArray(value)) return value.map((item) => interpolate(item, text));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, text)]));
  return value;
}
async function boundedAudio(response: Response): Promise<Buffer> {
  const limit = 40 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw Error('Audio is too large');
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw Error('Missing audio');
  for await (const chunk of response.body) {
    size += chunk.length; if (size > limit) throw Error('Audio is too large'); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function speechProvider(config: SpeechProviderConfig, directory: string, configDirectory: string): SpeechProvider {
  if (!config || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.id) || config.id === 'browser' || typeof config.label !== 'string' || !config.label.trim()) throw Error('Invalid speech provider identity');
  const base = { id: config.id, label: config.label, cacheIdentity: config };
  if (config.type === 'qwen-token-plan') {
    const model = config.model ?? 'qwen-audio-3.0-tts-plus';
    const profile: VoiceProfile = {
      voice: config.voice ?? 'qwen-audio-3.0-tts-plus-longshuojizhu', label: '公开发言朗读', rate: config.rate ?? 1.08,
      instruction: config.instruction ?? '请用普通话自然清楚地朗读给定原文，准确读出玩家号码。只读原文，不添加或改写内容。',
    };
    if (!Number.isFinite(profile.rate) || profile.rate <= 0) throw Error('Invalid speech rate');
    return { ...base, cacheIdentity: { ...config, model, profile }, async synthesize(text, signal) {
      const key = createHash('sha256').update(JSON.stringify({ model, profile, text })).digest('hex');
      const output = join(directory, key + '.wav');
      await synthesizeQwen(text, profile, model, output, { signal });
      return { bytes: await readFile(output), mimeType: 'audio/wav' };
    } };
  }
  if (config.type === 'http-audio') {
    const endpoint = new URL(config.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw Error('Invalid speech endpoint');
    if (!config.body || typeof config.body !== 'object' || !JSON.stringify(config.body).includes('{{text}}')) throw Error('Speech request body must contain {{text}}');
    const credential = config.apiKeyEnv ? createHash('sha256').update(process.env[config.apiKeyEnv] ?? '').digest('hex') : undefined;
    return { ...base, cacheIdentity: { ...config, credential }, async synthesize(text, signal) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...config.headers };
      if (config.apiKeyEnv) {
        const key = process.env[config.apiKeyEnv];
        if (!key) throw Error('Speech credential is not configured');
        headers[config.apiKeyHeader ?? 'Authorization'] = `${config.apiKeyPrefix ?? 'Bearer '}${key}`;
      }
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(interpolate(config.body, text)), signal, redirect: 'error' });
      if (!response.ok) throw Error(`Speech provider HTTP ${response.status}`);
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
