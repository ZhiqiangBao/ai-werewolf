import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SPEECH_CONNECTION_TEMPLATES, type SpeechConnectionDraft, type SpeechConnectionView } from '@werewolf/protocol';
import type { SecretBox } from '../secret';
import { mimoRequest, MIMO_MODEL } from './mimo';
import { speechProvider, type SpeechProviderConfig } from './providers';

interface SavedConnection extends Omit<SpeechConnectionView, 'hasKey'> { apiKeyEnc: string }
type Rooms = Record<string, SavedConnection[]>;
const GLOBAL = '@global';
const MIME_TYPES = new Set(['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/flac']);
function optional(value: unknown, limit = 500): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > limit) throw Error('TTS 配置字段格式不正确');
  return value.trim() || undefined;
}
export function connectionConfig(draft: Omit<SpeechConnectionView, 'hasKey'>): SpeechProviderConfig {
  const common = { id: draft.id, label: draft.name, endpoint: draft.url, apiKeyHeader: draft.apiKeyHeader ?? 'Authorization', apiKeyPrefix: draft.apiKeyPrefix ?? 'Bearer ' };
  if (draft.kind === 'speech-compatible') return { ...common, type: 'http-audio', mimeType: 'audio/wav', body: { input: '{{text}}', ...(draft.model ? { model: draft.model } : {}), ...(draft.voice ? { voice: draft.voice } : {}), response_format: 'wav' } };
  if (draft.kind === 'qwen') return { id: draft.id, label: draft.name, type: 'qwen-http', endpoint: draft.url, model: draft.model || 'qwen-audio-3.0-tts-plus', voice: draft.voice || 'qwen-audio-3.0-tts-plus-longshuojizhu' };
  if (draft.kind === 'mimo') return { ...common, type: 'http-json-audio', audioPath: 'choices.0.message.audio.data', encoding: 'base64', mimeType: 'audio/wav', statusPath: 'choices.0.finish_reason', statusValue: 'stop',
    body: mimoRequest('{{text}}', { voice: draft.voice || '苏打', label: draft.name, rate: 1, instruction: '请用自然清楚的普通话朗读。' }, draft.model || MIMO_MODEL) };
  if (draft.kind === 'minimax') return { ...common, type: 'http-json-audio', audioPath: 'data.audio', encoding: 'hex', mimeType: 'audio/mpeg', statusPath: 'base_resp.status_code', statusValue: 0, completionPath: 'data.status', completionValue: 2,
    body: { model: draft.model || 'speech-2.8-hd', text: '{{text}}', stream: false, output_format: 'hex', voice_setting: { voice_id: draft.voice || 'male-qn-qingse' }, audio_setting: { format: 'mp3', sample_rate: 24000, channel: 1 } } };
  let body: unknown;
  try { body = JSON.parse(draft.bodyJson ?? ''); } catch { throw Error('请求模板必须是有效 JSON'); }
  if (draft.kind === 'http-audio') return { ...common, type: 'http-audio', body, ...(draft.mimeType ? { mimeType: draft.mimeType } : {}) };
  return { ...common, type: 'http-json-audio', body, audioPath: draft.audioPath || 'audio', encoding: draft.encoding || 'base64', mimeType: draft.mimeType || 'audio/wav' };
}

/** 首页共享库与旧房间私有配置分开保存，不改写对局事实或环境配置。 */
export class SpeechConnections {
  private rooms: Rooms = {};
  readonly error?: string;
  constructor(private readonly file: string, private readonly secrets: SecretBox, private readonly directory: string) {
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (![1, 2].includes(data.version) || !data.rooms || typeof data.rooms !== 'object' || Array.isArray(data.rooms) || (data.version === 2 && !Array.isArray(data.connections))) throw Error('Invalid saved TTS connections');
      const scopes = { ...data.rooms, [GLOBAL]: data.version === 2 ? data.connections : [] };
      for (const entries of Object.values(scopes)) {
        if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.apiKeyEnc !== 'string')) throw Error('Invalid saved TTS connections');
        for (const entry of entries) speechProvider(connectionConfig(entry), directory, dirname(file), { apiKey: 'validation-only' });
      }
      this.rooms = scopes;
    } catch { this.error = '网页 TTS 配置文件损坏或版本不支持，请检查 speech-connections.json；原文件未被覆盖。'; }
  }
  views(roomId: string): SpeechConnectionView[] {
    return (this.rooms[roomId] ?? []).map(({ apiKeyEnc, ...view }) => ({ ...view, hasKey: !!this.key(apiKeyEnc) }));
  }
  providers(roomId: string) {
    return (this.rooms[roomId] ?? []).map(({ apiKeyEnc, ...view }) => speechProvider(connectionConfig(view), this.directory, dirname(this.file), { apiKey: this.key(apiKeyEnc) }));
  }
  sharedViews() { return this.views(GLOBAL); }
  sharedProviders() { return this.providers(GLOBAL); }
  saveShared(raw: Record<string, unknown>, id?: string) { return this.save(GLOBAL, raw, id); }
  removeShared(id: string) { this.remove(GLOBAL, id); }
  share(roomId: string, id: string): SpeechConnectionView {
    if (this.error) throw Error(this.error);
    const entry = this.rooms[roomId]?.find((item) => item.id === id);
    if (!entry) throw Error('没有这个旧房间 TTS 来源');
    if ((this.rooms[GLOBAL]?.length ?? 0) >= 20 || this.rooms[GLOBAL]?.some((item) => item.id === id)) throw Error('首页 TTS 库已满或已有此来源');
    this.persist({ ...this.rooms, [GLOBAL]: [...(this.rooms[GLOBAL] ?? []), entry], [roomId]: this.rooms[roomId].filter((item) => item.id !== id) });
    return this.sharedViews().find((item) => item.id === id)!;
  }
  save(roomId: string, raw: Record<string, unknown>, id?: string): SpeechConnectionView {
    if (this.error) throw Error(this.error);
    const previous = id ? this.rooms[roomId]?.find((item) => item.id === id) : undefined;
    if (id && !previous) throw Error('没有这个 TTS 来源');
    if (!id && (this.rooms[roomId]?.length ?? 0) >= 20) throw Error('当前 TTS 库最多配置 20 个来源');
    const name = optional(raw.name, 120), address = optional(raw.url, 2000);
    if (!name || !address || !SPEECH_CONNECTION_TEMPLATES.some((item) => item.kind === raw.kind)) throw Error('请填写名称、接口地址并选择接入类型');
    let url: URL;
    try { url = new URL(address); } catch { throw Error('请输入完整的 HTTP 或 HTTPS 接口地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw Error('接口地址不能包含密码、查询凭证或片段，请把 Key 填在密钥栏');
    const header = optional(raw.apiKeyHeader, 100);
    if (header && (!/^[a-zA-Z0-9-]+$/.test(header) || /^(host|content-length|content-type|cookie|proxy-authorization|connection)$/i.test(header))) throw Error('密钥请求头名称无效');
    if (raw.apiKeyPrefix !== undefined && (typeof raw.apiKeyPrefix !== 'string' || raw.apiKeyPrefix.length > 100 || /[\r\n]/.test(raw.apiKeyPrefix))) throw Error('密钥前缀无效');
    if (raw.encoding !== undefined && !['base64', 'hex'].includes(String(raw.encoding))) throw Error('音频编码无效');
    const mimeType = optional(raw.mimeType, 100);
    if (mimeType && !MIME_TYPES.has(mimeType)) throw Error('音频 MIME 类型无效');
    const apiKey = optional(raw.apiKey, 8000);
    if (apiKey && /[\r\n]/.test(apiKey)) throw Error('API Key 不能包含换行');
    if (!apiKey && !previous) throw Error('请填写 API Key');
    const saved: SavedConnection = { id: previous?.id ?? `tts_${randomBytes(12).toString('hex')}`, name, url: url.href, kind: raw.kind as SpeechConnectionDraft['kind'],
      model: optional(raw.model), voice: optional(raw.voice), bodyJson: optional(raw.bodyJson, 64000), audioPath: optional(raw.audioPath),
      apiKeyHeader: header, apiKeyPrefix: raw.apiKeyPrefix as string | undefined, encoding: raw.encoding as SpeechConnectionDraft['encoding'], mimeType,
      apiKeyEnc: apiKey ? this.secrets.encrypt(apiKey) : previous!.apiKeyEnc };
    const { apiKeyEnc: _secret, ...draft } = saved;
    // Validate without making a request. No arbitrary JS/module paths from the UI.
    speechProvider(connectionConfig(draft), this.directory, dirname(this.file), { apiKey: 'validation-only' });
    this.persist({ ...this.rooms, [roomId]: [...(this.rooms[roomId] ?? []).filter((item) => item.id !== saved.id), saved] });
    return this.views(roomId).find((item) => item.id === saved.id)!;
  }
  remove(roomId: string, id: string): void {
    if (this.error) throw Error(this.error);
    const items = this.rooms[roomId] ?? [];
    if (!items.some((item) => item.id === id)) throw Error('没有这个 TTS 来源');
    this.persist({ ...this.rooms, [roomId]: items.filter((item) => item.id !== id) });
  }
  private key(encrypted: string) { try { return this.secrets.decrypt(encrypted); } catch { return ''; } }
  private persist(rooms: Rooms) {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    const { [GLOBAL]: connections = [], ...legacyRooms } = rooms;
    writeFileSync(temporary, JSON.stringify({ version: 2, connections, rooms: legacyRooms }), { mode: 0o600 });
    renameSync(temporary, this.file); this.rooms = rooms;
  }
}
