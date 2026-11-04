import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DEFAULT_GAME_LOCALE, LocalizedError, THINKING_MODES, apiProtocol, apiUrl, avatarDefaultName, defaultGameTiming, defaultThinkingMode, gameText, isAvatarStyleId, isGameLocale, parseGameTiming, thinkingOptions } from '@werewolf/protocol';
import type { AvatarStyleId, Catalog, ParticipantInput, RoomSetupInput, RuleValue, Seat, SeatConfigInput, SeatConfigView, SeatTestResult } from '@werewolf/protocol';
import { DEFAULT_PRESET, allOptions, buildRuleCard, buildRules, engineCatalog, getPreset, validateRules } from '@werewolf/engine';
import { STYLES, redact, testConnection } from '@werewolf/llm';
import { ApiFailure } from './room-failure';
import { adapterConfig } from './room-model';
import { sameModelRoute, type ModelLibrary } from './model-library';
import { maskKey, type SecretBox } from './secret';
import type { OwnedRoomFields, RoomLobbyRecord, RoomReadRecord, Viewer } from './room-types';
import type { RoomRecord, SeatRecord } from './store';

const token = () => randomBytes(18).toString('base64url');
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const validationFailure = (error: unknown) => new ApiFailure(400, 'BAD_REQUEST', (error as Error).message,
  error instanceof LocalizedError ? { key: error.localization.key, ...(error.localization.values ? { values: [...error.localization.values] } : {}) } : undefined);

function defaultSeat(seat: Seat, avatarStyle: AvatarStyleId = 'storybook'): SeatRecord {
  return {
    seat,
    name: avatarDefaultName(avatarStyle, seat),
    nameSource: 'avatar',
    controller: 'ai',
    adapter: 'mock',
    baseUrl: '',
    model: '',
    apiKeyEnc: null,
    apiKeyMask: null,
    modelId: null,
    temperature: 0.7,
    style: STYLES[(seat - 1) % STYLES.length].id,
    persona: '',
    toolMode: 'tools',
    timeoutSec: 90,
  };
}

/** 候场、配置与凭证；不持有调度状态、连接集合或 RoomManager。 */
export class RoomLobbyService {
  constructor(private readonly now: () => number, private readonly secrets: SecretBox, private readonly models: ModelLibrary) {}

  catalog(): Catalog {
    return { ...engineCatalog(), styles: STYLES };
  }

  createRoom(input: Pick<RoomSetupInput, 'avatarStyle' | 'locale'> = {}): RoomRecord {
    const avatarStyle = input.avatarStyle === undefined ? 'storybook' : input.avatarStyle;
    if (!isAvatarStyleId(avatarStyle)) throw new ApiFailure(400, 'BAD_REQUEST', '没有这个人物风格', { key: '没有这个人物风格' });
    const locale = input.locale ?? DEFAULT_GAME_LOCALE;
    if (!isGameLocale(locale)) throw new ApiFailure(400, 'BAD_REQUEST', '不支持的对局语言', { key: '不支持的对局语言' });
    const preset = getPreset(DEFAULT_PRESET);
    const rec: RoomRecord = {
      id: randomBytes(5).toString('hex'),
      avatarStyle,
      locale,
      createdAt: this.now(),
      hostToken: token(),
      spectatorToken: token(),
      seatTokens: preset.roles.map(() => token()),
      participants: {},
      status: 'setup',
      paused: false,
      presetId: preset.id,
      ruleValues: {},
      timing: defaultGameTiming(),
      humanTimeoutSec: 90,
      aiPacingMs: 1200,
      seats: preset.roles.map((_, i) => defaultSeat(i + 1, avatarStyle)),
      seed: null,
      rules: null,
      state: null,
      events: [],
      actions: [],
      deadlines: {},
      thoughts: [],
    };
    return rec;
  }

  cloneSetup(src: RoomReadRecord, rec: RoomLobbyRecord): void {
    Object.assign(rec, {
      avatarStyle: src.avatarStyle,
      locale: src.rules?.locale ?? src.locale ?? DEFAULT_GAME_LOCALE,
      presetId: src.presetId,
      ruleValues: { ...src.ruleValues },
      timing: src.timing ? structuredClone(src.timing) : undefined,
      humanTimeoutSec: src.humanTimeoutSec,
      aiPacingMs: src.aiPacingMs,
      seats: structuredClone(src.seats),
      seatTokens: src.seats.map(() => token()),
      participants: {},
    } satisfies Partial<Pick<RoomRecord, OwnedRoomFields<'lobby'>>>);
  }

  updateSetup(rec: RoomLobbyRecord, input: RoomSetupInput): void {
    if (rec.status !== 'setup') throw new ApiFailure(409, 'ALREADY_STARTED', '对局已经开始，不能再修改配置', { key: '对局已经开始，不能再修改配置' });
    if (input.avatarStyle !== undefined && !isAvatarStyleId(input.avatarStyle)) throw new ApiFailure(400, 'BAD_REQUEST', '没有这个人物风格', { key: '没有这个人物风格' });
    let timing: RoomRecord['timing'];
    try { timing = input.timing === undefined ? undefined : parseGameTiming(input.timing); }
    catch (error) { throw validationFailure(error); }
    if (input.locale !== undefined && !isGameLocale(input.locale)) throw new ApiFailure(400, 'BAD_REQUEST', '不支持的对局语言', { key: '不支持的对局语言' });
    const previousRules = buildRuleCard(buildRules(rec.presetId, rec.ruleValues, { locale: rec.locale }));
    if (input.locale !== undefined) rec.locale = input.locale;
    if (input.presetId !== undefined && input.presetId !== rec.presetId) {
      let roles: string[];
      try {
        roles = getPreset(input.presetId).roles;
      } catch {
        throw new ApiFailure(400, 'BAD_REQUEST', `没有这个版型：${input.presetId}`, { key: '没有这个版型：{0}', values: [input.presetId] });
      }
      rec.presetId = input.presetId;
      rec.ruleValues = {};
      rec.seats = roles.map((_, i) => rec.seats[i] ?? defaultSeat(i + 1, rec.avatarStyle));
      rec.seatTokens = roles.map((_, i) => rec.seatTokens[i] ?? token());
    }
    if (input.avatarStyle !== undefined) {
      rec.avatarStyle = input.avatarStyle;
      for (const seat of rec.seats) {
        if (seat.nameSource !== 'avatar' && !(seat.nameSource === undefined && seat.name === `${seat.seat}号`)) continue;
        const name = avatarDefaultName(input.avatarStyle, seat.seat);
        if (name !== seat.name && rec.participants?.[seat.seat]) rec.participants[seat.seat].ready = false;
        seat.name = name;
        seat.nameSource = 'avatar';
      }
    }
    if (input.ruleValues) {
      const editable = new Map(allOptions().filter((o) => o.editable).map((o) => [o.key, o]));
      for (const [key, value] of Object.entries(input.ruleValues)) {
        const o = editable.get(key);
        if (!o) continue;
        const ok =
          o.type === 'choice'
            ? o.choices?.some((c) => String(c.value) === String(value))
            : o.type === 'boolean'
              ? typeof value === 'boolean'
              : Number.isFinite(Number(value));
        if (!ok) throw new ApiFailure(400, 'BAD_REQUEST', `规则选项 ${key} 的值不合法`, { key: '规则选项 {0} 的值不合法', values: [key] });
        rec.ruleValues[key] = o.type === 'choice' ? (o.choices!.find((c) => String(c.value) === String(value))!.value as RuleValue) : (value as RuleValue);
      }
    }
    if (timing) rec.timing = timing;
    else if (input.humanTimeoutSec !== undefined || input.aiPacingMs !== undefined) delete rec.timing; // 旧客户端保留旧计时策略。
    if (input.humanTimeoutSec !== undefined) rec.humanTimeoutSec = Math.round(clamp(input.humanTimeoutSec, 0, 3600, 90));
    if (input.aiPacingMs !== undefined) rec.aiPacingMs = Math.round(clamp(input.aiPacingMs, 0, 10000, 1200));
    for (const s of input.seats ?? []) this.applySeat(rec, s);
    if (previousRules !== buildRuleCard(buildRules(rec.presetId, rec.ruleValues, { locale: rec.locale }))) {
      for (const p of Object.values(rec.participants ?? {})) p.ready = false;
    }
    for (const s of input.seats ?? []) {
      if (s.controller !== undefined && rec.participants) delete rec.participants[s.seat];
    }
  }

  private applySeat(rec: RoomLobbyRecord, s: SeatConfigInput): void {
    const current = rec.seats.find((x) => x.seat === s.seat);
    if (!current) throw new ApiFailure(400, 'BAD_REQUEST', `没有 ${s.seat} 号座位`, { key: '没有 {0} 号座位', values: [s.seat] });
    const seat = { ...current };
    // 兼容旧房间遗留的空昵称；切换控制者时保留已有自定义昵称。
    if (!seat.name?.trim()) {
      seat.name = avatarDefaultName(rec.avatarStyle ?? 'storybook', seat.seat);
      seat.nameSource = 'avatar';
    }
    if (s.apiProtocol !== undefined) {
      try { seat.apiProtocol = apiProtocol(s.apiProtocol); } catch (error) { throw validationFailure(error); }
    }
    if (s.maxOutputTokens !== undefined) {
      if (!Number.isInteger(s.maxOutputTokens) || s.maxOutputTokens < 1024 || s.maxOutputTokens > 128000) throw new ApiFailure(400, 'BAD_REQUEST', '单次输出上限须为 1024–128000 的整数', { key: '单次输出上限须为 1024–128000 的整数' });
      seat.maxOutputTokens = s.maxOutputTokens;
    }
    if (s.controller !== undefined) {
      if (s.controller !== 'human' && s.controller !== 'ai') throw new ApiFailure(400, 'BAD_REQUEST', '控制者只能是 human 或 ai', { key: '控制者只能是 human 或 ai' });
      seat.controller = s.controller;
    }
    if (s.adapter !== undefined) {
      if (s.adapter !== 'mock' && s.adapter !== 'openai_compatible') throw new ApiFailure(400, 'BAD_REQUEST', '适配器只能是 mock 或 openai_compatible', { key: '适配器只能是 mock 或 openai_compatible' });
      seat.adapter = s.adapter;
    }
    if (s.toolMode !== undefined) {
      if (s.toolMode !== 'tools' && s.toolMode !== 'json') throw new ApiFailure(400, 'BAD_REQUEST', '输出模式只能是 tools 或 json', { key: '输出模式只能是 tools 或 json' });
      seat.toolMode = s.toolMode;
    }
    if (s.name !== undefined) {
      const name = text(s.name, 12);
      seat.name = name || avatarDefaultName(rec.avatarStyle ?? 'storybook', seat.seat);
      seat.nameSource = name ? 'custom' : 'avatar';
      if (seat.name !== current.name && rec.participants?.[seat.seat]) rec.participants[seat.seat].ready = false;
    }
    if (s.baseUrl !== undefined) seat.baseUrl = text(s.baseUrl, 300);
    if (s.model !== undefined) seat.model = text(s.model, 120);
    if (!s.presetId && ((s.baseUrl !== undefined && seat.baseUrl !== current.baseUrl) || (s.model !== undefined && seat.model !== current.model) || (s.apiProtocol !== undefined && seat.apiProtocol !== current.apiProtocol))) seat.modelId = null;
    if (s.temperature !== undefined) seat.temperature = clamp(s.temperature, 0, 2, 0.7);
    if (s.timeoutSec !== undefined) seat.timeoutSec = Math.round(clamp(s.timeoutSec, 90, 300, 90));
    if (s.thinkingMode !== undefined) {
      if (!THINKING_MODES.includes(s.thinkingMode)) throw new ApiFailure(400, 'BAD_REQUEST', '无效的思考强度', { key: '无效的思考强度' });
      seat.thinkingMode = s.thinkingMode;
    }
    if (s.style !== undefined) seat.style = STYLES.some((x) => x.id === s.style) ? s.style : STYLES[0].id;
    if (s.persona !== undefined) seat.persona = text(s.persona, 300);
    if (s.apiKey === null || s.apiKey === '') {
      seat.apiKeyEnc = null;
      seat.apiKeyMask = null;
    } else if (typeof s.apiKey === 'string') {
      seat.apiKeyEnc = this.secrets.encrypt(s.apiKey.trim());
      seat.apiKeyMask = maskKey(s.apiKey);
    }
    if (s.presetId) {
      const preset = this.models.find(s.presetId);
      if (!preset) throw new ApiFailure(400, 'BAD_REQUEST', '没有这个模型', { key: '没有这个模型' });
      if (preset.lifecycle !== 'active') throw new ApiFailure(409, 'MODEL_DISABLED', '模型已停用，请选择其他模型', { key: '模型已停用，请选择其他模型' });
      if (preset.apiKeyEnv && !preset.apiKey && typeof s.apiKey !== 'string') throw new ApiFailure(409, 'MODEL_KEY_UNAVAILABLE', '模型环境变量未设置，请在服务进程中配置后重试。', { key: '模型环境变量未设置，请在服务进程中配置后重试。' });
      seat.modelId = s.modelId === null ? null : preset.id;
      seat.model = preset.model;
      seat.baseUrl = preset.baseUrl;
      seat.apiProtocol = s.apiProtocol ?? preset.apiProtocol ?? 'chat_completions';
      seat.adapter = 'openai_compatible';
      if (typeof s.apiKey !== 'string') {
        if (preset.apiKey) {
          seat.apiKeyEnc = this.secrets.encrypt(preset.apiKey);
          seat.apiKeyMask = maskKey(preset.apiKey);
        } else {
          seat.apiKeyEnc = null;
          seat.apiKeyMask = null;
        }
      }
    } else if (s.modelId === null) {
      seat.modelId = null;
    }
    const preferred = defaultThinkingMode(seat.baseUrl, seat.model, seat.apiProtocol);
    const option = thinkingOptions(seat.baseUrl, seat.model, seat.apiProtocol).find((o) => o.value === (seat.thinkingMode ?? preferred));
    if (!option?.supported) {
      if (s.thinkingMode !== undefined) throw new ApiFailure(400, 'BAD_REQUEST', option?.hint ?? '无效的思考强度', option ? { key: option.hintKey, values: option.hintValues } : { key: '无效的思考强度' });
      seat.thinkingMode = preferred;
    }
    if (seat.adapter === 'openai_compatible' && seat.thinkingMode === undefined) seat.thinkingMode = preferred;
    Object.assign(current, seat);
  }

  seatView(s: SeatRecord): SeatConfigView {
    const { apiKeyEnc: _enc, apiKeyMask, nameSource: _nameSource, ...rest } = s;
    return { ...rest, apiProtocol: s.apiProtocol ?? 'chat_completions', ...(s.adapter === 'openai_compatible' ? { thinkingMode: s.thinkingMode ?? defaultThinkingMode(s.baseUrl, s.model, s.apiProtocol) } : {}), apiKeyMasked: apiKeyMask, modelId: s.modelId ? this.models.find(s.modelId)?.id ?? s.modelId : null };
  }

  setupErrors(rec: RoomReadRecord, locale = rec.locale ?? DEFAULT_GAME_LOCALE): string[] {
    const errors = validateRules(buildRules(rec.presetId, rec.ruleValues, { locale: rec.locale }), locale);
    for (const s of rec.seats) {
      if (this.unavailableModel(s)) errors.push(gameText(locale, '{0}号：模型已停用或不存在，请选择其他模型', s.seat));
      if (s.controller === 'human' && rec.participants && !rec.participants[s.seat]?.ready) errors.push(gameText(locale, '{0}号：等待真人进入座位并确认准备', s.seat));
      if (s.controller !== 'ai' || s.adapter !== 'openai_compatible') continue;
      if (!s.baseUrl) errors.push(gameText(locale, '{0}号：没有填写接口地址', s.seat));
      if (!s.model) errors.push(gameText(locale, '{0}号：没有填写模型名', s.seat));
      if (s.baseUrl) { try { apiUrl(s.baseUrl, s.apiProtocol, locale); } catch (error) { errors.push(gameText(locale, '{0}号：{1}', s.seat, (error as Error).message)); } }
      const thinking = thinkingOptions(s.baseUrl, s.model, s.apiProtocol, locale).find((o) => o.value === (s.thinkingMode ?? defaultThinkingMode(s.baseUrl, s.model, s.apiProtocol)));
      if (!thinking?.supported) errors.push(thinking?.hint
        ? gameText(locale, '{0}号：{1}', s.seat, thinking.hint)
        : gameText(locale, '{0}号：无效的思考强度', s.seat));
    }
    return errors;
  }

  async testSeat(rec: RoomReadRecord, seat: Seat, signal?: AbortSignal, uiLocale = rec.locale ?? DEFAULT_GAME_LOCALE): Promise<SeatTestResult> {
    const s = rec.seats.find((x) => x.seat === seat);
    if (!s) throw new ApiFailure(404, 'NOT_FOUND', `没有 ${seat} 号座位`, { key: '没有 {0} 号座位', values: [seat] });
    if (s.adapter === 'mock') return { ok: true, message: gameText(uiLocale, '模拟玩家不需要联网。'), latencyMs: 0 };
    const config = adapterConfig(s, this.secrets);
    if (!config.baseUrl || !config.model) return { ok: false, message: gameText(uiLocale, '请先为这个座位选择模型。'), latencyMs: 0 };
    const r = await testConnection(config, signal, uiLocale);
    return { ...r, message: redact(r.message, config.apiKey) };
  }

  participate(rec: RoomLobbyRecord, viewer: Viewer, input: ParticipantInput): void {
    if (viewer.role !== 'seat') throw new ApiFailure(403, 'FORBIDDEN', '只有座位凭证可以接入真人玩家', { key: '只有座位凭证可以接入真人玩家' });
    const seat = rec.seats[viewer.seat - 1];
    if (seat.controller !== 'human') throw new ApiFailure(409, 'NOT_HUMAN_SEAT', '这个座位由模型控制', { key: '这个座位由模型控制' });
    if (input.ready !== undefined && typeof input.ready !== 'boolean') throw new ApiFailure(400, 'BAD_REQUEST', '准备状态必须是布尔值', { key: '准备状态必须是布尔值' });
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || [...input.name.trim()].length > 12)) throw new ApiFailure(400, 'BAD_REQUEST', '昵称须为 1–12 个字符', { key: '昵称须为 1–12 个字符' });
    if (rec.status !== 'setup' && (input.name !== undefined || input.ready !== undefined)) throw new ApiFailure(409, 'ALREADY_STARTED', '开局后不能修改昵称或准备状态', { key: '开局后不能修改昵称或准备状态' });
    if (rec.status === 'setup' && !seat.name?.trim()) {
      seat.name = avatarDefaultName(rec.avatarStyle ?? 'storybook', seat.seat);
      seat.nameSource = 'avatar';
    }
    rec.participants ??= {};
    const participant = rec.participants[viewer.seat] ??= { joined: false, ready: false };
    participant.joined = true;
    if (input.name !== undefined && input.name.trim() !== seat.name) {
      seat.name = input.name.trim();
      seat.nameSource = 'custom';
    }
    if (input.ready !== undefined) participant.ready = input.ready;
  }

  resolve(rec: RoomRecord | undefined, tok: string): { rec: RoomRecord; viewer: Viewer } {
    if (!rec) throw new ApiFailure(404, 'NOT_FOUND', '房间不存在', { key: '房间不存在' });
    if (!tok) throw new ApiFailure(401, 'UNAUTHORIZED', '缺少凭证', { key: '缺少凭证' });
    if (same(tok, rec.hostToken)) return { rec, viewer: { role: 'host' } };
    if (same(tok, rec.spectatorToken)) return { rec, viewer: { role: 'spectator' } };
    const i = rec.seatTokens.findIndex((t) => same(tok, t));
    if (i >= 0) return { rec, viewer: { role: 'seat', seat: i + 1 } };
    throw new ApiFailure(403, 'FORBIDDEN', '凭证无效', { key: '凭证无效' });
  }

  host(rec: RoomRecord | undefined, tok: string): RoomRecord {
    const resolved = this.resolve(rec, tok);
    if (resolved.viewer.role !== 'host') throw new ApiFailure(403, 'FORBIDDEN', '只有房主凭证可以执行这个操作', { key: '只有房主凭证可以执行这个操作' });
    return resolved.rec;
  }

  validateStart(rec: RoomReadRecord, uiLocale?: string): void {
    if (rec.status !== 'setup') throw new ApiFailure(409, 'ALREADY_STARTED', '对局已经开始', { key: '对局已经开始' });
    this.assertModelsAvailable(rec);
    const errors = this.setupErrors(rec);
    if (errors.length) {
      const details = uiLocale ? this.setupErrors(rec, uiLocale) : errors;
      throw new ApiFailure(422, 'INVALID_SETUP', errors.join('；'), { key: '房间配置尚未准备好：{0}', values: [details.join('；')] });
    }
  }

  assertModelsAvailable(rec: RoomReadRecord): void {
    for (const seat of rec.seats) {
      if (this.unavailableModel(seat)) throw new ApiFailure(409, 'MODEL_DISABLED', `${seat.seat}号的模型已停用或不存在，请先替换`, { key: '{0}号的模型已停用或不存在，请先替换', values: [seat.seat] });
    }
  }

  private unavailableModel(seat: SeatRecord): boolean {
    if (seat.controller !== 'ai' || seat.adapter !== 'openai_compatible') return false;
    if (seat.modelId) return this.models.find(seat.modelId)?.lifecycle !== 'active';
    const matches = this.models.list().filter((m) => m.model === seat.model && m.apiProtocol === (seat.apiProtocol ?? 'chat_completions') && sameModelRoute(m.baseUrl, seat.baseUrl, m.apiProtocol));
    return matches.length > 0 && !matches.some((m) => this.models.find(m.id)?.lifecycle === 'active');
  }
}
