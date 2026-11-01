import { randomBytes, timingSafeEqual } from 'node:crypto';
import { THINKING_MODES, thinkingOptions, defaultThinkingMode, apiProtocol, apiUrl, actionMenu } from '@werewolf/protocol';
import type {
  AdapterKind,
  AuditEntry,
  Catalog,
  ControlAction,
  CreateRoomResult,
  GodProjection,
  Projection,
  ModelPresetView,
  ModelRequestInfo,
  RoomBrief,
  RoomSetupInput,
  RoomSetupView,
  RuleValue,
  Seat,
  SeatConfigInput,
  SeatConfigView,
  SeatTestResult,
  ToolCall,
  ToolSpec,
  ParticipantInput,
  HumanParticipant,
  ViewResponse,
} from '@werewolf/protocol';
import {
  DEFAULT_PRESET,
  allOptions,
  buildRuleCard,
  buildRules,
  abandonGame,
  createGame,
  engineCatalog,
  getPreset,
  projectGod,
  projectSeat,
  projectSpectator,
  seatTools,
  submit,
  validateRules,
  waitingSeats,
  type EngineResult,
  type SubmitInput,
} from '@werewolf/engine';
import {
  STYLES,
  buildMessages,
  feedbackMessages,
  getAdapter,
  redact,
  styleText,
  testConnection,
  type Adapter,
  type AdapterConfig,
  type TranscriptMessage,
  type DecideResult,
} from '@werewolf/llm';
import {
  NOT_TOOL_TURN,
  migrateThread,
  ensureCue,
  ownLine,
  readyToAct,
  syncThread,
  type ActionCue,
  type TurnHint,
  type SeatThread,
} from './agent';
import { ModelLibrary } from './model-library';
import { maskKey, type SecretBox } from './secret';
import type { RoomRecord, RoomStore, SeatRecord } from './store';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Viewer = { role: 'host' } | { role: 'seat'; seat: Seat } | { role: 'spectator' };

interface Subscriber {
  viewer: Viewer;
  send: (n: number) => void;
  sig: string;
  count: number;
}

interface Live {
  rec: RoomRecord;
  running: Promise<void> | null;
  again: boolean;
  stepBudget: number;
  /** 终结时加一。还在飞的请求和推进循环看到代数变了就立刻退出，不能再提交。 */
  gen: number;
  inflight: Map<string, AbortController>;
  subscribers: Set<Subscriber>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  thoughtTimer: ReturnType<typeof setTimeout> | null;
  thoughtNotifiedAt: number;
  auditId: number;
}

export interface ManagerOptions {
  store: RoomStore;
  secrets: SecretBox;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 测试时替换适配器。 */
  adapters?: Partial<Record<AdapterKind, Adapter>>;
  /** 行动超时检查间隔，0 表示不启动定时器。 */
  tickMs?: number;
  /** 页面里添加的模型。不传则只留在内存里。 */
  modelsPath?: string;
}

const MAX_ATTEMPTS = 5;
const SPEECH_LIMIT_SEC = 180;
const VOTE_LIMIT_SEC = 90;
const MIN_EVENT_SEC = 90;

/** 发言（含遗言、狼队密谈）3 分钟，放逐和警长投票 90 秒，其余用座位或真人时限。 */
export function actionLimitSec(stepType: string, fallback: number): number {
  if (stepType === 'speech' || stepType === 'wolf.discuss') return SPEECH_LIMIT_SEC;
  if (stepType === 'exile.vote' || stepType === 'sheriff.vote') return VOTE_LIMIT_SEC;
  return fallback;
}

/** 模型请求时限。发言 180，投票 90，其余至少 90 秒。 */
function aiTimeoutSec(stepType: string, configured: number): number {
  return Math.max(MIN_EVENT_SEC, actionLimitSec(stepType, configured));
}
const AUTO: ToolCall = { tool: '', args: {} };

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

function defaultSeat(seat: Seat): SeatRecord {
  return {
    seat,
    name: `${seat}号`,
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

/** 模型写超长时截断文本参数，而不是让整次行动失败。 */
function clampTexts(call: ToolCall, tools: ToolSpec[]): ToolCall {
  const spec = tools.find((t) => t.name === call.tool);
  if (!spec) return call;
  const args = { ...call.args };
  for (const p of spec.params) {
    const v = args[p.name];
    if (p.kind === 'text' && typeof v === 'string') {
      const chars = [...v.trim()];
      if (p.maxLength !== undefined && chars.length > p.maxLength) args[p.name] = chars.slice(0, p.maxLength).join('');
    }
  }
  return { tool: call.tool, args };
}

export class RoomManager {
  private readonly rooms = new Map<string, Live>();
  private readonly store: RoomStore;
  private readonly secrets: SecretBox;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly adapters: Partial<Record<AdapterKind, Adapter>>;
  private readonly models: ModelLibrary;
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(o: ManagerOptions) {
    this.store = o.store;
    this.secrets = o.secrets;
    this.models = new ModelLibrary(o.secrets, o.modelsPath);
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.adapters = o.adapters ?? {};
    for (const rec of this.store.loadAll()) {
      if (rec.heardSeq === undefined) rec.heardSeq = rec.events.reduce((m, e) => Math.max(m, e.seq), 0);
      rec.threads ??= [];
      this.rooms.set(rec.id, this.live(rec));
    }
    const tick = o.tickMs ?? 1000;
    this.timer = tick > 0 ? setInterval(() => this.tick(), tick) : null;
    this.timer?.unref?.();
  }

  /** 服务启动后继续推进进行中的对局。 */
  resumeAll(): void {
    for (const live of this.rooms.values()) {
      if (live.rec.status === 'running') {
        this.armDeadlines(live, true);
        void this.pump(live);
      }
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const live of this.rooms.values()) {
      for (const c of live.inflight.values()) c.abort();
      if (live.thoughtTimer) clearTimeout(live.thoughtTimer);
      this.flush(live);
    }
  }

  // -------------------------------------------------------------------------
  // 房间与开局配置
  // -------------------------------------------------------------------------

  catalog(): Catalog {
    return { ...engineCatalog(), styles: STYLES };
  }

  /** 模型名单：页面里添加的，加上 settings.json 里写好的。没有密钥明文。 */
  modelPresets(): ModelPresetView[] {
    return this.models.views();
  }

  addModel(body: { name?: unknown; baseUrl?: unknown; apiKey?: unknown; apiProtocol?: unknown }): ModelPresetView {
    try {
      return this.models.add(String(body.name ?? ''), String(body.baseUrl ?? ''), String(body.apiKey ?? ''), apiProtocol(body.apiProtocol));
    } catch (e) {
      throw new ApiFailure(400, 'BAD_REQUEST', (e as Error).message);
    }
  }

  deleteModel(id: string): void {
    try {
      this.models.remove(id);
    } catch (e) {
      throw new ApiFailure(400, 'BAD_REQUEST', (e as Error).message);
    }
  }

  createRoom(): CreateRoomResult {
    const preset = getPreset(DEFAULT_PRESET);
    const rec: RoomRecord = {
      id: randomBytes(5).toString('hex'),
      createdAt: this.now(),
      hostToken: token(),
      spectatorToken: token(),
      seatTokens: preset.roles.map(() => token()),
      participants: {},
      status: 'setup',
      paused: false,
      presetId: preset.id,
      ruleValues: {},
      humanTimeoutSec: 90,
      aiPacingMs: 1200,
      seats: preset.roles.map((_, i) => defaultSeat(i + 1)),
      seed: null,
      rules: null,
      state: null,
      events: [],
      actions: [],
      deadlines: {},
      thoughts: [],
    };
    const live = this.live(rec);
    this.rooms.set(rec.id, live);
    this.flush(live);
    return { roomId: rec.id, hostToken: rec.hostToken };
  }

  /** 用同样的配置（含加密密钥）开一个新房间，凭证全部重新生成。 */
  cloneRoom(roomId: string, tok: string): CreateRoomResult {
    const src = this.host(roomId, tok).rec;
    const created = this.createRoom();
    const live = this.rooms.get(created.roomId)!;
    Object.assign(live.rec, {
      presetId: src.presetId,
      ruleValues: { ...src.ruleValues },
      humanTimeoutSec: src.humanTimeoutSec,
      aiPacingMs: src.aiPacingMs,
      seats: structuredClone(src.seats),
      seatTokens: src.seats.map(() => token()),
      participants: {},
    });
    this.flush(live);
    return created;
  }

  getSetup(roomId: string, tok: string): RoomSetupView {
    return this.setupView(this.host(roomId, tok).rec);
  }

  updateSetup(roomId: string, tok: string, input: RoomSetupInput): RoomSetupView {
    const live = this.host(roomId, tok);
    const rec = live.rec;
    if (rec.status !== 'setup') throw new ApiFailure(409, 'ALREADY_STARTED', '对局已经开始，不能再修改配置');
    const previousRules = buildRuleCard(buildRules(rec.presetId, rec.ruleValues));
    if (input.presetId !== undefined && input.presetId !== rec.presetId) {
      let roles: string[];
      try {
        roles = getPreset(input.presetId).roles;
      } catch {
        throw new ApiFailure(400, 'BAD_REQUEST', `没有这个版型：${input.presetId}`);
      }
      rec.presetId = input.presetId;
      rec.ruleValues = {};
      rec.seats = roles.map((_, i) => rec.seats[i] ?? defaultSeat(i + 1));
      rec.seatTokens = roles.map((_, i) => rec.seatTokens[i] ?? token());
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
        if (!ok) throw new ApiFailure(400, 'BAD_REQUEST', `规则选项 ${key} 的值不合法`);
        rec.ruleValues[key] = o.type === 'choice' ? (o.choices!.find((c) => String(c.value) === String(value))!.value as RuleValue) : (value as RuleValue);
      }
    }
    if (input.humanTimeoutSec !== undefined) rec.humanTimeoutSec = Math.round(clamp(input.humanTimeoutSec, 0, 3600, 90));
    if (input.aiPacingMs !== undefined) rec.aiPacingMs = Math.round(clamp(input.aiPacingMs, 0, 10000, 1200));
    for (const s of input.seats ?? []) this.applySeat(rec, s);
    if (previousRules !== buildRuleCard(buildRules(rec.presetId, rec.ruleValues))) {
      for (const p of Object.values(rec.participants ?? {})) p.ready = false;
    }
    for (const s of input.seats ?? []) {
      if (s.controller !== undefined && rec.participants) delete rec.participants[s.seat];
    }
    this.changed(live);
    return this.setupView(rec);
  }

  private applySeat(rec: RoomRecord, s: SeatConfigInput): void {
    const current = rec.seats.find((x) => x.seat === s.seat);
    if (!current) throw new ApiFailure(400, 'BAD_REQUEST', `没有 ${s.seat} 号座位`);
    const seat = { ...current };
    if (s.apiProtocol !== undefined) {
      try { seat.apiProtocol = apiProtocol(s.apiProtocol); } catch (error) { throw new ApiFailure(400, 'BAD_REQUEST', (error as Error).message); }
    }
    if (s.maxOutputTokens !== undefined) {
      if (!Number.isInteger(s.maxOutputTokens) || s.maxOutputTokens < 1024 || s.maxOutputTokens > 128000) throw new ApiFailure(400, 'BAD_REQUEST', '单次输出上限须为 1024–128000 的整数');
      seat.maxOutputTokens = s.maxOutputTokens;
    }
    if (s.controller !== undefined) {
      if (s.controller !== 'human' && s.controller !== 'ai') throw new ApiFailure(400, 'BAD_REQUEST', '控制者只能是 human 或 ai');
      seat.controller = s.controller;
    }
    if (s.adapter !== undefined) {
      if (s.adapter !== 'mock' && s.adapter !== 'openai_compatible') throw new ApiFailure(400, 'BAD_REQUEST', '适配器只能是 mock 或 openai_compatible');
      seat.adapter = s.adapter;
    }
    if (s.toolMode !== undefined) {
      if (s.toolMode !== 'tools' && s.toolMode !== 'json') throw new ApiFailure(400, 'BAD_REQUEST', '输出模式只能是 tools 或 json');
      seat.toolMode = s.toolMode;
    }
    if (s.name !== undefined) seat.name = text(s.name, 12) || `${seat.seat}号`;
    if (s.baseUrl !== undefined) seat.baseUrl = text(s.baseUrl, 300);
    if (s.model !== undefined) seat.model = text(s.model, 120);
    if (s.temperature !== undefined) seat.temperature = clamp(s.temperature, 0, 2, 0.7);
    if (s.timeoutSec !== undefined) seat.timeoutSec = Math.round(clamp(s.timeoutSec, 90, 300, 90));
    if (s.thinkingMode !== undefined) {
      if (!THINKING_MODES.includes(s.thinkingMode)) throw new ApiFailure(400, 'BAD_REQUEST', '无效的思考强度');
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
      if (!preset) throw new ApiFailure(400, 'BAD_REQUEST', '没有这个模型');
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
      if (s.thinkingMode !== undefined) throw new ApiFailure(400, 'BAD_REQUEST', option?.hint ?? '无效的思考强度');
      seat.thinkingMode = preferred;
    }
    if (seat.adapter === 'openai_compatible' && seat.thinkingMode === undefined) seat.thinkingMode = preferred;
    Object.assign(current, seat);
  }

  private seatView(s: SeatRecord): SeatConfigView {
    const { apiKeyEnc: _enc, apiKeyMask, ...rest } = s;
    return { ...rest, apiProtocol: s.apiProtocol ?? 'chat_completions', ...(s.adapter === 'openai_compatible' ? { thinkingMode: s.thinkingMode ?? defaultThinkingMode(s.baseUrl, s.model, s.apiProtocol) } : {}), apiKeyMasked: apiKeyMask, modelId: s.modelId ?? null };
  }

  private setupErrors(rec: RoomRecord): string[] {
    const errors = validateRules(buildRules(rec.presetId, rec.ruleValues));
    for (const s of rec.seats) {
      if (s.controller === 'human' && rec.participants && !rec.participants[s.seat]?.ready) errors.push(`${s.seat}号：等待真人进入座位并确认准备`);
      if (s.controller !== 'ai' || s.adapter !== 'openai_compatible') continue;
      if (!s.baseUrl) errors.push(`${s.seat}号：没有填写接口地址`);
      if (!s.model) errors.push(`${s.seat}号：没有填写模型名`);
      if (s.baseUrl) { try { apiUrl(s.baseUrl, s.apiProtocol); } catch (error) { errors.push(`${s.seat}号：${(error as Error).message}`); } }
      const thinking = thinkingOptions(s.baseUrl, s.model, s.apiProtocol).find((o) => o.value === (s.thinkingMode ?? defaultThinkingMode(s.baseUrl, s.model, s.apiProtocol)));
      if (!thinking?.supported) errors.push(`${s.seat}号：${thinking?.hint ?? '无效的思考强度'}`);
    }
    return errors;
  }

  private setupView(rec: RoomRecord): RoomSetupView {
    const rules = rec.rules ?? buildRules(rec.presetId, rec.ruleValues);
    return {
      roomId: rec.id,
      status: rec.status,
      paused: rec.paused,
      presetId: rec.presetId,
      ruleValues: rules.values,
      humanTimeoutSec: rec.humanTimeoutSec,
      aiPacingMs: rec.aiPacingMs,
      seats: rec.seats.map((s) => this.seatView(s)),
      tokens: {
        host: rec.hostToken,
        spectator: rec.spectatorToken,
        seats: rec.seatTokens.map((t, i) => ({ seat: i + 1, token: t })),
      },
      ruleCardPreview: buildRuleCard(rules),
      validationErrors: rec.status === 'setup' ? this.setupErrors(rec) : [],
      participants: this.participants(rec),
    };
  }

  async testSeat(roomId: string, tok: string, seat: Seat): Promise<SeatTestResult> {
    const rec = this.host(roomId, tok).rec;
    const s = rec.seats.find((x) => x.seat === seat);
    if (!s) throw new ApiFailure(404, 'NOT_FOUND', `没有 ${seat} 号座位`);
    if (s.adapter === 'mock') return { ok: true, message: '模拟玩家不需要联网。', latencyMs: 0 };
    const config = this.adapterConfig(s);
    if (!config.baseUrl || !config.model) return { ok: false, message: '请先为这个座位选择模型。', latencyMs: 0 };
    const r = await testConnection(config);
    return { ...r, message: redact(r.message, config.apiKey) };
  }

  start(roomId: string, tok: string): RoomSetupView {
    const live = this.host(roomId, tok);
    const rec = live.rec;
    if (rec.status !== 'setup') throw new ApiFailure(409, 'ALREADY_STARTED', '对局已经开始');
    const errors = this.setupErrors(rec);
    if (errors.length) throw new ApiFailure(422, 'INVALID_SETUP', errors.join('；'));
    const rules = buildRules(rec.presetId, rec.ruleValues);
    const seed = randomBytes(8).toString('hex');
    const r = createGame({ id: rec.id, rules, seed, names: rec.seats.map((s) => s.name) });
    Object.assign(rec, {
      rules,
      seed,
      state: r.state,
      events: [...r.events],
      actions: [],
      status: 'running',
      paused: false,
      deadlines: {},
      threads: [],
      heardSeq: 0,
    });
    this.changed(live);
    void this.pump(live);
    return this.setupView(rec);
  }

  control(roomId: string, tok: string, action: ControlAction): RoomBrief {
    const live = this.host(roomId, tok);
    const rec = live.rec;
    if (rec.status !== 'running') throw new ApiFailure(409, 'NOT_RUNNING', '对局不在进行中');
    if (action === 'pause') {
      rec.paused = true;
      live.stepBudget = 0;
    } else if (action === 'resume') {
      rec.paused = false;
      live.stepBudget = 0;
      this.armDeadlines(live, true);
    } else if (action === 'step') {
      if (!rec.paused) throw new ApiFailure(409, 'NOT_PAUSED', '单步只在暂停时可用');
      live.stepBudget += 1;
    } else if (action === 'end') {
      this.stopMatch(live);
    } else throw new ApiFailure(400, 'BAD_REQUEST', `未知操作：${String(action)}`);
    this.changed(live);
    if (action !== 'end') void this.pump(live);
    return this.brief(rec, { role: 'host' });
  }

  // -------------------------------------------------------------------------
  // 投影、行动、订阅
  // -------------------------------------------------------------------------

  /** 座位凭证只能修改本人昵称和准备状态。运行中可重新接入，不改变任何对局事实。 */
  participate(roomId: string, tok: string, input: ParticipantInput): ViewResponse {
    const { live, viewer } = this.resolve(roomId, tok);
    if (viewer.role !== 'seat') throw new ApiFailure(403, 'FORBIDDEN', '只有座位凭证可以接入真人玩家');
    const rec = live.rec, seat = rec.seats[viewer.seat - 1];
    if (seat.controller !== 'human') throw new ApiFailure(409, 'NOT_HUMAN_SEAT', '这个座位由模型控制');
    if (input.ready !== undefined && typeof input.ready !== 'boolean') throw new ApiFailure(400, 'BAD_REQUEST', '准备状态必须是布尔值');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || [...input.name.trim()].length > 12)) throw new ApiFailure(400, 'BAD_REQUEST', '昵称须为 1–12 个字符');
    if (rec.status !== 'setup' && (input.name !== undefined || input.ready !== undefined)) throw new ApiFailure(409, 'ALREADY_STARTED', '开局后不能修改昵称或准备状态');
    rec.participants ??= {};
    const participant = rec.participants[viewer.seat] ??= { joined: false, ready: false };
    participant.joined = true;
    if (input.name !== undefined) seat.name = input.name.trim();
    if (input.ready !== undefined) participant.ready = input.ready;
    this.changed(live);
    return this.view(roomId, tok);
  }

  /** 视角只由凭证决定。请求里的任何「视角」参数都不会提升权限。 */
  view(roomId: string, tok: string): ViewResponse {
    const { live, viewer } = this.resolve(roomId, tok);
    const rec = live.rec;
    return { room: this.brief(rec, viewer), projection: rec.state ? this.project(rec, viewer) : null };
  }

  speechText(roomId: string, tok: string, seq: unknown): string {
    const { live, viewer } = this.resolve(roomId, tok);
    if (!Number.isInteger(seq) || Number(seq) < 1) throw new ApiFailure(400, 'BAD_REQUEST', '请选择一条已提交发言');
    if (!live.rec.state) throw new ApiFailure(409, 'NOT_STARTED', '对局还没有开始');
    const event = this.project(live.rec, viewer).events.find((e) => e.seq === seq);
    if (!event || event.type !== 'speech' || typeof event.payload.content !== 'string') {
      throw new ApiFailure(404, 'NOT_FOUND', '这条记录不是当前视角可朗读的已提交发言');
    }
    return `${event.payload.seat}号发言。${event.payload.content}`;
  }

  act(roomId: string, tok: string, body: { decisionId?: unknown; tool?: unknown; args?: unknown }) {
    const { live, viewer } = this.resolve(roomId, tok);
    if (viewer.role !== 'seat') throw new ApiFailure(403, 'FORBIDDEN', '只有座位凭证可以提交行动');
    const rec = live.rec;
    if (rec.status !== 'running' || !rec.state) throw new ApiFailure(409, 'NOT_RUNNING', '对局不在进行中');
    if (rec.seats[viewer.seat - 1].controller !== 'human') throw new ApiFailure(409, 'NOT_HUMAN_SEAT', '这个座位由模型控制');
    if (rec.paused) throw new ApiFailure(409, 'PAUSED', '对局已暂停');
    if (typeof body.decisionId !== 'string' || !body.decisionId) throw new ApiFailure(400, 'BAD_REQUEST', '行动必须带上决策标识，请刷新后再提交');
    if (typeof body.tool !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) throw new ApiFailure(400, 'BAD_REQUEST', '行动须包含工具名称和参数对象');
    const args = body.args as Record<string, unknown>;
    const input: SubmitInput = {
      seat: viewer.seat,
      call: { tool: typeof body.tool === 'string' ? body.tool : '', args },
      ...(typeof body.decisionId === 'string' ? { decisionId: body.decisionId } : {}),
    };
    const res = this.apply(live, input);
    void this.pump(live);
    return res.error ? { ok: false, error: { code: res.error.code, message: res.error.reason } } : { ok: true };
  }

  subscribe(roomId: string, tok: string, send: (n: number) => void): () => void {
    const { live, viewer } = this.resolve(roomId, tok);
    const sub: Subscriber = { viewer, send, sig: this.signature(live.rec, viewer), count: 0 };
    live.subscribers.add(sub);
    // 新订阅的响应头尚未写出；仅向已经建立的其他连接通知在线变化。
    sub.sig = this.signature(live.rec, viewer);
    this.notify(live);
    return () => { live.subscribers.delete(sub); this.notify(live); };
  }

  audit(roomId: string, tok: string): AuditEntry[] {
    this.host(roomId, tok);
    return this.store.readAudit(roomId);
  }

  exportRecord(roomId: string, tok: string, kind: 'public' | 'god'): unknown {
    const { live, viewer } = this.resolve(roomId, tok);
    const rec = live.rec;
    if (!rec.state) throw new ApiFailure(409, 'NOT_STARTED', '对局还没有开始');
    if (kind === 'god') {
      if (viewer.role !== 'host') throw new ApiFailure(403, 'FORBIDDEN', '只有房主可以导出上帝记录');
      return {
        roomId: rec.id,
        rules: rec.rules,
        seed: rec.seed,
        seats: rec.seats.map((s) => ({ seat: s.seat, name: s.name, controller: s.controller, adapter: s.adapter, model: s.model })),
        roles: rec.state.players.map((p) => ({ seat: p.seat, role: p.role })),
        result: rec.state.result,
        events: rec.events,
        actions: rec.actions,
      };
    }
    if (rec.status !== 'ended' && viewer.role !== 'host') throw new ApiFailure(409, 'NOT_ENDED', '终局后才能导出公开记录');
    return projectSpectator(rec.state, rec.events);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private live(rec: RoomRecord): Live {
    return {
      rec,
      running: null,
      again: false,
      stepBudget: 0,
      gen: 0,
      inflight: new Map(),
      subscribers: new Set(),
      saveTimer: null,
      thoughtTimer: null,
      thoughtNotifiedAt: 0,
      auditId: 0,
    };
  }

  /** 掐掉这一局：取消所有在飞请求，推进循环作废，记为流局，不结算、不公开身份。 */
  private stopMatch(live: Live): void {
    const rec = live.rec;
    if (!rec.state) throw new ApiFailure(409, 'NOT_RUNNING', '对局不在进行中');
    live.gen += 1;
    live.again = false;
    live.stepBudget = 0;
    for (const ctrl of live.inflight.values()) ctrl.abort();
    for (const thought of rec.thoughts ?? []) thought.live = false;
    const res = abandonGame(rec.state);
    rec.state = res.state;
    if (res.events.length) rec.events.push(...res.events);
    rec.paused = false;
    rec.deadlines = {};
    rec.status = 'ended';
  }

  private resolve(roomId: string, tok: string): { live: Live; viewer: Viewer } {
    const live = this.rooms.get(roomId);
    if (!live) throw new ApiFailure(404, 'NOT_FOUND', '房间不存在');
    if (!tok) throw new ApiFailure(401, 'UNAUTHORIZED', '缺少凭证');
    const rec = live.rec;
    if (same(tok, rec.hostToken)) return { live, viewer: { role: 'host' } };
    if (same(tok, rec.spectatorToken)) return { live, viewer: { role: 'spectator' } };
    const i = rec.seatTokens.findIndex((t) => same(tok, t));
    if (i >= 0) return { live, viewer: { role: 'seat', seat: i + 1 } };
    throw new ApiFailure(403, 'FORBIDDEN', '凭证无效');
  }

  private host(roomId: string, tok: string): Live {
    const { live, viewer } = this.resolve(roomId, tok);
    if (viewer.role !== 'host') throw new ApiFailure(403, 'FORBIDDEN', '只有房主凭证可以执行这个操作');
    return live;
  }

  private brief(rec: RoomRecord, viewer: Viewer): RoomBrief {
    return {
      roomId: rec.id,
      status: rec.status,
      paused: rec.paused,
      viewer: viewer.role,
      ...(viewer.role === 'seat' ? { seat: viewer.seat } : {}),
      presetName: rec.rules?.presetName ?? getPreset(rec.presetId).name,
      seats: rec.seats.map((s) => ({ seat: s.seat, name: s.name, controller: s.controller })),
      participants: this.participants(rec),
      ...(rec.status === 'setup' ? { ruleCard: buildRuleCard(buildRules(rec.presetId, rec.ruleValues)) } : {}),
    };
  }

  private participants(rec: RoomRecord): HumanParticipant[] {
    const subscribers = this.rooms.get(rec.id)?.subscribers;
    return rec.seats.filter((s) => s.controller === 'human').map((s) => ({
      seat: s.seat, joined: rec.participants?.[s.seat]?.joined ?? false, ready: rec.participants?.[s.seat]?.ready ?? false,
      online: !!subscribers && [...subscribers].some((sub) => sub.viewer.role === 'seat' && sub.viewer.seat === s.seat),
    }));
  }

  private visibleThoughts(rec: RoomRecord, viewer: Viewer) {
    const all = rec.thoughts ?? [];
    if (viewer.role === 'host') return all;
    if (viewer.role === 'seat') return all.filter((t) => t.seat === viewer.seat);
    return [];
  }

  /** 模型和座位页面看到同一份投影，包括这一步还剩多少时间。 */
  private attachDeadline(rec: RoomRecord, seat: Seat, projection: Projection): Projection {
    const deadline = projection.task && !projection.task.submitted ? rec.deadlines[`${projection.task.decisionId}:${seat}`] : undefined;
    if (projection.task && deadline) projection.task.deadline = deadline;
    return projection;
  }

  private project(rec: RoomRecord, viewer: Viewer): Projection | GodProjection {
    const state = rec.state!;
    if (viewer.role === 'spectator') return projectSpectator(state, rec.events);
    const p = viewer.role === 'host' ? projectGod(state, rec.events) : projectSeat(state, rec.events, viewer.seat);
    if (viewer.role === 'seat') this.attachDeadline(rec, viewer.seat, p);
    const thoughts = this.visibleThoughts(rec, viewer);
    if (thoughts.length) p.thoughts = thoughts;
    return p;
  }

  private signature(rec: RoomRecord, viewer: Viewer): string {
    const room = [rec.status, rec.paused, rec.seats.map((s) => [s.seat, s.name, s.controller]), this.participants(rec)];
    if (!rec.state) return JSON.stringify([room, rec.presetId, rec.ruleValues]);
    const p = this.project(rec, viewer);
    return JSON.stringify([
      room,
      p.version,
      p.stage,
      p.task?.decisionId ?? null,
      p.task?.submitted ?? null,
      p.task?.deadline ?? null,
      p.interrupts.map((t) => t.name),
      viewer.role === 'host' ? (p as GodProjection).god.pending : null,
      this.visibleThoughts(rec, viewer).map((t) => [t.decisionId, t.seat, t.thinking.length, t.reply.length, t.live]),
    ]);
  }

  private apply(live: Live, input: SubmitInput): EngineResult {
    const rec = live.rec;
    if (rec.status !== 'running' || rec.state?.result) {
      return { state: rec.state!, events: [], error: { code: 'GAME_ENDED', reason: '对局已经结束' } };
    }
    const res = submit(rec.state!, input);
    rec.state = res.state;
    rec.events.push(...res.events);
    rec.actions.push(input);
    if (rec.state.result) rec.status = 'ended';
    this.changed(live);
    return res;
  }

  private changed(live: Live): void {
    this.armDeadlines(live, false);
    const current = live.rec.state?.pending?.id;
    for (const [key, ctrl] of live.inflight) {
      // 旁听属于这条消息，不属于当时碰巧正在等待的行动；换下一位不能取消别人的收听。
      if (!key.includes(':hear:') && (!current || !key.startsWith(`${current}:`))) {
        ctrl.abort();
        live.inflight.delete(key);
      }
    }
    this.scheduleSave(live);
    this.notify(live);
  }

  /** 只通知视角有变化的订阅者。思考的流式更新走这里，不重新武装截止时间，也不取消请求。 */
  private notify(live: Live): void {
    for (const sub of live.subscribers) {
      const sig = this.signature(live.rec, sub.viewer);
      if (sig === sub.sig) continue;
      sub.sig = sig;
      try {
        sub.send(++sub.count);
      } catch {
        live.subscribers.delete(sub);
      }
    }
  }

  private publishThoughts(live: Live, immediate: boolean): void {
    const send = () => {
      if (live.thoughtTimer) clearTimeout(live.thoughtTimer);
      live.thoughtTimer = null;
      live.thoughtNotifiedAt = this.now();
      this.scheduleSave(live);
      this.notify(live);
    };
    if (immediate) {
      send();
      return;
    }
    const elapsed = this.now() - live.thoughtNotifiedAt;
    if (elapsed >= 80) {
      send();
      return;
    }
    if (live.thoughtTimer) return;
    live.thoughtTimer = setTimeout(send, 80 - elapsed);
  }

  private pushThought(live: Live, seat: Seat, decision: string, delta: { thinking?: string; reply?: string }): void {
    const rec = live.rec;
    rec.thoughts ??= [];
    let thought = rec.thoughts.find((t) => t.seat === seat && t.decisionId === decision);
    if (!thought) {
      thought = { seat, decisionId: decision, at: this.now(), thinking: '', reply: '', live: true };
      rec.thoughts.push(thought);
    }
    if (delta.thinking) thought.thinking += delta.thinking;
    if (delta.reply) thought.reply += delta.reply;
    thought.live = true;
    this.publishThoughts(live, false);
  }

  private finishThought(live: Live, seat: Seat, decision: string, result?: { thinking?: string; reply?: string }): void {
    const rec = live.rec;
    rec.thoughts ??= [];
    let thought = rec.thoughts.find((t) => t.seat === seat && t.decisionId === decision);
    if (!thought && !result?.thinking && !result?.reply) return;
    if (!thought) {
      thought = { seat, decisionId: decision, at: this.now(), thinking: '', reply: '', live: false };
      rec.thoughts.push(thought);
    }
    if (result?.thinking && result.thinking.length >= thought.thinking.length) thought.thinking = result.thinking;
    if (result?.reply && result.reply.length >= thought.reply.length) thought.reply = result.reply;
    thought.live = false;
    if (!thought.thinking && !thought.reply) rec.thoughts = rec.thoughts.filter((t) => t !== thought);
    this.publishThoughts(live, true);
  }

  private scheduleSave(live: Live): void {
    if (live.saveTimer) return;
    live.saveTimer = setTimeout(() => this.flush(live), 300);
  }

  private flush(live: Live): void {
    if (live.saveTimer) clearTimeout(live.saveTimer);
    live.saveTimer = null;
    try {
      this.store.save(live.rec);
    } catch (e) {
      console.error(`房间 ${live.rec.id} 保存失败：`, (e as Error).message);
    }
  }

  private isHuman(rec: RoomRecord, seat: Seat): boolean {
    return rec.seats[seat - 1]?.controller === 'human';
  }

  /** 真人从这一步开始计时。模型要等法官这句话进了自己的上下文，才开始计时。 */
  private armDeadlines(live: Live, reset: boolean): void {
    const rec = live.rec;
    const d = rec.state?.pending;
    const next: Record<string, number> = {};
    if (d && rec.status === 'running') {
      for (const seat of waitingSeats(rec.state!)) {
        const key = `${d.id}:${seat}`;
        const human = this.isHuman(rec, seat);
        if (human) {
          if (rec.humanTimeoutSec <= 0) continue;
          const limit = actionLimitSec(d.step.type, rec.humanTimeoutSec);
          next[key] = !reset && rec.deadlines[key] ? rec.deadlines[key] : this.now() + limit * 1000;
          continue;
        }
        if (!rec.deadlines[key] || !readyToAct(this.threadFor(live, seat), this.actionCue(rec))) continue;
        const limit = aiTimeoutSec(d.step.type, rec.seats[seat - 1].timeoutSec);
        next[key] = reset ? this.now() + limit * 1000 : rec.deadlines[key];
      }
    }
    rec.deadlines = next;
  }

  /** 这个模型座位的上下文里已经有法官的问话。从现在开始算这一步的时限。 */
  private markAsked(live: Live, seat: Seat): void {
    const rec = live.rec;
    const d = rec.state?.pending;
    if (!d || rec.status !== 'running' || this.isHuman(rec, seat)) return;
    if (!waitingSeats(rec.state!).includes(seat)) return;
    if (!readyToAct(this.threadFor(live, seat), this.actionCue(rec))) return;
    const key = `${d.id}:${seat}`;
    if (rec.deadlines[key]) return;
    const limit = aiTimeoutSec(d.step.type, rec.seats[seat - 1].timeoutSec);
    rec.deadlines[key] = this.now() + limit * 1000;
  }

  /** 到点还没提交的座位按该步骤的托管行动结算。上警托管就是不上警。暂停期间不计时。 */
  tick(): void {
    for (const live of this.rooms.values()) {
      const rec = live.rec;
      const d = rec.state?.pending;
      if (rec.status !== 'running' || rec.paused || !d) continue;
      const expired = waitingSeats(rec.state!).find((seat) => {
        if (!this.isHuman(rec, seat) && !readyToAct(this.threadFor(live, seat), this.actionCue(rec))) return false;
        const dl = rec.deadlines[`${d.id}:${seat}`];
        return dl !== undefined && this.now() >= dl;
      });
      if (expired === undefined) continue;
      this.apply(live, { seat: expired, call: AUTO, auto: true, autoReason: 'timeout', decisionId: d.id });
      void this.pump(live);
    }
  }

  private adapterConfig(s: SeatRecord): AdapterConfig {
    return {
      apiProtocol: s.apiProtocol ?? 'chat_completions',
      baseUrl: s.baseUrl,
      model: s.model,
      apiKey: s.apiKeyEnc ? this.secrets.decrypt(s.apiKeyEnc) : null,
      temperature: s.temperature,
      toolMode: s.toolMode,
      timeoutSec: s.timeoutSec,
      thinkingMode: s.thinkingMode ?? defaultThinkingMode(s.baseUrl, s.model, s.apiProtocol),
      maxOutputTokens: s.maxOutputTokens,
    };
  }

  private writeAudit(live: Live, entry: Omit<AuditEntry, 'id' | 'at'>): void {
    if (live.auditId === 0) live.auditId = this.store.readAudit(live.rec.id).length;
    this.store.appendAudit(live.rec.id, { id: ++live.auditId, at: this.now(), ...entry });
  }

  /** 自动推进：轮到模型就请求并提交，轮到真人就等待。同时行动的模型座位并行请求。 */
  private pump(live: Live): Promise<void> {
    if (live.rec.status === 'ended') return Promise.resolve();
    if (live.running) {
      live.again = true;
      return live.running;
    }
    const gen = live.gen;
    live.running = (async () => {
      try {
        do {
          live.again = false;
          if (live.gen !== gen || live.rec.status === 'ended') return;
          await this.pumpOnce(live);
        } while (live.again && live.gen === gen && live.rec.status === 'running');
      } catch (e) {
        if (live.gen !== gen || live.rec.status === 'ended') return;
        console.error(`房间 ${live.rec.id} 推进出错，已暂停：`, e);
        live.rec.paused = true;
        this.changed(live);
      } finally {
        live.running = null;
      }
    })();
    return live.running;
  }

  /** 等到该房间当前没有正在进行的自动推进。 */
  async whenIdle(roomId: string): Promise<void> {
    const live = this.rooms.get(roomId);
    while (live?.running) await live.running;
  }

  private async pumpOnce(live: Live): Promise<void> {
    const rec = live.rec;
    const gen = live.gen;
    for (;;) {
      if (live.gen !== gen) return;
      if (rec.status !== 'running' && rec.status !== 'ended') return;
      const stepping = rec.paused && live.stepBudget > 0;
      if (rec.paused && !stepping) return;
      const wave = this.prepareWave(live);
      if (!wave) {
        if (rec.status !== 'running' || !rec.state?.pending) return;
        if (!waitingSeats(rec.state).some((s) => !this.isHuman(rec, s))) return;
        throw new Error(`决策 ${rec.state.pending.id} 没有推进`);
      }
      if (!wave.length) continue;
      if (stepping) live.stepBudget -= 1;
      const decision = rec.state?.pending?.id ?? 'end';
      if (!stepping && rec.aiPacingMs > 0) await this.sleep(rec.aiPacingMs);
      if (live.gen !== gen || (rec.status !== 'running' && rec.status !== 'ended')) return;
      const actions = wave.filter((w) => w.action).map((w) => w.seat);
      await Promise.all(wave.map((w) => (w.action ? this.runAi(live, w.seat, decision) : this.receive(live, w.seat, decision))));
      this.scheduleSave(live);
      if (rec.status !== 'running') continue;
      const stuck = actions.length > 0 && rec.state?.pending?.id === decision && actions.every((s) => waitingSeats(rec.state!).includes(s));
      if (stuck) throw new Error(`决策 ${decision} 没有推进`);
    }
  }

  /** 打开座位上下文，不写入事件。 */
  private threadFor(live: Live, seat: Seat): SeatThread {
    const rec = live.rec;
    rec.threads ??= [];
    let thread = rec.threads.find((t) => t.seat === seat);
    if (!thread) {
      thread = { seat, seen: 0, messages: [] };
      rec.threads.push(thread);
    }
    return migrateThread(thread);
  }

  private syncThread(live: Live, seat: Seat, maxSeq = Number.POSITIVE_INFINITY): SeatThread {
    const thread = this.threadFor(live, seat);
    const rec = live.rec;
    const projection = projectSeat(rec.state!, rec.events, seat);
    const cfg = rec.seats[seat - 1];
    const system = buildMessages(projection, styleText(cfg.style, cfg.persona), {
      speechSec: SPEECH_LIMIT_SEC,
      skillSec: Math.max(MIN_EVENT_SEC, cfg.timeoutSec),
    })[0];
    syncThread(thread, rec.events, system, { ...this.turnHint(rec), cue: rec.status === 'running' ? this.actionCue(rec) : null }, maxSeq);
    return thread;
  }

  /**
   * 一次只送出一条可见消息。看得到的每个模型座位都调用一次。
   * 结尾允许用工具的，这次就是行动。其余只收听，只接受本次收听时已允许的打断技能。
   */
  /** 有新消息返回调用列表（可能为空，表示这条没有座位看得见）。没有新消息返回 null。 */
  private prepareWave(live: Live): { seat: Seat; action: boolean }[] | null {
    const rec = live.rec;
    const ai = rec.seats.filter((s) => !this.isHuman(rec, s.seat));
    let next = Number.POSITIVE_INFINITY;
    for (const s of ai) {
      const unseen = rec.events.find((e) => e.seq > this.threadFor(live, s.seat).seen);
      if (unseen) next = Math.min(next, unseen.seq);
    }
    if (next !== Number.POSITIVE_INFINITY) {
      const cue = rec.status === 'running' ? this.actionCue(rec) : null;
      // 同一段发言及其行动邀请一起送出。更早的积压发言仍逐条旁听。
      const first = rec.events.find((e) => e.seq === next)!;
      const canJoin = first.type === 'speech' || first.type === 'wolf.chat' ||
        ['sheriff.order', 'speech.order', 'sheriff.pk', 'vote.pk', 'vote.result'].includes(first.type);
      if (canJoin && cue?.afterSeq && next < cue.afterSeq) {
        const rest = rec.events.filter((e) => e.seq > next && e.seq <= cue.afterSeq!);
        if (rest.every((e) => e.payload.announced === true || (Array.isArray(e.audience) && !e.audience.length) ||
          (e.type === 'judge' && e.payload.decisionId === cue.id))) next = cue.afterSeq;
      }
      const wave: { seat: Seat; action: boolean }[] = [];
      for (const s of ai) {
        const thread = this.threadFor(live, s.seat);
        if (thread.seen >= next) continue;
        const before = thread.messages.length;
        this.syncThread(live, s.seat, next);
        if (thread.messages.slice(before).some((m) => m.role !== 'system')) {
          const action = readyToAct(thread, cue);
          if (action) ensureCue(thread, cue);
          wave.push({ seat: s.seat, action });
        }
      }
      rec.heardSeq = next;
      this.scheduleSave(live);
      return wave;
    }
    if (rec.status !== 'running' || !rec.state?.pending) return null;
    const cue = this.actionCue(rec);
    const wave: { seat: Seat; action: boolean }[] = [];
    for (const s of ai) {
      const thread = this.syncThread(live, s.seat);
      const before = thread.messages.length;
      ensureCue(thread, cue);
      const action = readyToAct(thread, cue);
      if (action || thread.messages.length > before) {
        wave.push({ seat: s.seat, action });
      }
    }
    if (wave.length) this.scheduleSave(live);
    return wave.length ? wave : null;
  }

  private turnHint(rec: RoomRecord): TurnHint {
    const step = rec.state?.pending?.step;
    if (!step) return { nextSeat: null, nextStep: null };
    if (step.type === 'speech' || step.type === 'wolf.discuss') {
      return { nextSeat: rec.state!.pending!.actors[0] ?? null, nextStep: step.type };
    }
    return { nextSeat: null, nextStep: step.type };
  }

  private actionCue(rec: RoomRecord): ActionCue | null {
    const d = rec.state?.pending;
    if (!d) return null;
    const actors = waitingSeats(rec.state!).filter((seat) => d.tools[seat]?.length);
    const tool = actors.map((seat) => d.tools[seat]?.[0]?.name).find(Boolean) ?? '';
    return {
      id: d.id,
      // 老存档没有边界时，先收齐已有事件，再补本轮问话。
      afterSeq: d.openedAtSeq ?? rec.events.at(-1)?.seq ?? 0,
      step: d.step.type,
      kind: typeof d.step.kind === 'string' ? d.step.kind : null,
      actors,
      prompts: d.prompts,
      allowedTools: d.tools,
      tool,
      broadcast: d.step.type === 'sheriff.signup' || d.step.type === 'exile.vote' || d.step.type === 'sheriff.vote',
    };
  }

  /** 还没提交的座位到点或放弃时，按引擎的托管行动补上。上警就是不上警。 */
  private fallbackIfWaiting(live: Live, seat: Seat, decision: string, reason: SubmitInput['autoReason']): void {
    const rec = live.rec;
    const d = rec.state?.pending;
    if (rec.status !== 'running' || !d || d.id !== decision) return;
    if (!waitingSeats(rec.state!).includes(seat)) return;
    if (!rec.deadlines[`${decision}:${seat}`]) return;
    if (!readyToAct(this.threadFor(live, seat), this.actionCue(rec))) return;
    this.apply(live, { seat, call: AUTO, auto: true, autoReason: reason, decisionId: decision });
  }

  /** 每次回复立即入座位上下文，包括失败轮次；工具调用始终有对应的工具结果。 */
  private rememberReply(thread: SeatThread, result: DecideResult, error?: string, legalTools?: ToolSpec[]): void {
    if (error && result.fatal && !result.toolCallIds.length) {
      if (result.assistant?.content) thread.messages.push(result.assistant);
      thread.messages.push({ role: 'user', name: 'judge', content: `本次模型请求未完成：${error}` });
      return;
    }
    if (error) {
      thread.messages.push(...feedbackMessages(result, `${error}${legalTools?.length ? `\n${actionMenu(legalTools)}` : ''}`));
      return;
    }
    const call = result.call;
    const reply = result.assistant ?? { role: 'assistant' as const, content: call ? ownLine(call.tool, call.args) : result.reply ?? '' };
    if (reply.content || (reply.role === 'assistant' && (reply.calls?.length || reply.native?.items.length))) thread.messages.push(reply);
    if (reply.role === 'assistant' && reply.calls?.length) {
      for (const c of reply.calls) thread.messages.push({ role: 'tool', callId: c.id, content: call ? ownLine(call.tool, call.args) : '已收到。' });
    }
  }

  /** 旁听失败只影响这次旁听，不消耗当前行动，也不触发托管。 */
  private async receive(live: Live, seat: Seat, decision: string): Promise<void> {
    const rec = live.rec;
    const cfg = rec.seats[seat - 1];
    const adapter = this.adapters[cfg.adapter] ?? getAdapter(cfg.adapter, cfg.apiProtocol);
    const projection = this.attachDeadline(rec, seat, projectSeat(rec.state!, rec.events, seat));
    const tools = seatTools(rec.state!, seat);
    const thread = this.threadFor(live, seat);
    const key = `${decision}:hear:${seat}:${thread.seen}`;
    const ctrl = new AbortController();
    live.inflight.set(key, ctrl);
    const gen = live.gen;
    const model = cfg.adapter === 'mock' ? 'mock' : cfg.model;
    const messages: TranscriptMessage[] = [...thread.messages];
    const started = this.now();
    let firstDeltaMs: number | undefined;
    let thinkingChars = 0;
    let replyChars = 0;
    let request: ModelRequestInfo | undefined;
    try {
      let config: AdapterConfig;
      try {
        config = { ...this.adapterConfig(cfg), timeoutSec: aiTimeoutSec('', cfg.timeoutSec) };
      } catch {
        this.writeAudit(live, { seat, model, decisionId: decision, projectionVersion: projection.version, purpose: 'listen', ok: false, error: '密钥无法解密（主密钥可能已更换）' });
        return;
      }
      if (live.gen !== gen || ctrl.signal.aborted) return;
      let result: DecideResult;
      try {
        result = await adapter.decide({
          seat,
          projection,
          messages,
          tools,
          config,
          cacheKey: `werewolf:${rec.id}:seat:${seat}`,
          signal: ctrl.signal,
          stream: cfg.adapter !== 'mock',
          toolChoice: 'auto',
          onRequest: (info) => { request = info; },
          onDelta: (delta) => {
            firstDeltaMs ??= this.now() - started;
            thinkingChars += delta.thinking?.length ?? 0;
            replyChars += delta.reply?.length ?? 0;
          },
        });
      } catch (e) {
        if (live.gen !== gen || ctrl.signal.aborted) return;
        result = { ok: false, fatal: true, error: redact((e as Error).message, config.apiKey), failureKind: 'network', toolCallIds: [], latencyMs: 0 };
      }
      if (live.gen !== gen) return;
      let error = result.ok ? undefined : result.error ?? '旁听请求失败';
      if (result.ok && result.call) {
        const call = clampTexts(result.call, tools);
        const allowed = projection.interrupts.some((t) => t.name === call.tool) &&
          rec.status === 'running' && projectSeat(rec.state!, rec.events, seat).interrupts.some((t) => t.name === call.tool);
        // 旁听生成的普通行动不能借用随后到来的行动许可；错误只作为本次工具反馈返回。
        error = allowed ? this.apply(live, { seat, call }).error?.reason : NOT_TOOL_TURN;
      }
      this.rememberReply(thread, result, error);
      this.writeAudit(live, {
        seat, model, decisionId: decision, projectionVersion: projection.version, purpose: 'listen',
        ok: !error, messages, request, response: result.raw ?? result.call,
        ...(result.call ? { toolCall: result.call } : {}), ...(error ? { error: redact(error, config.apiKey) } : {}),
        failureKind: result.failureKind ?? (error ? 'invalid_tool' : undefined), latencyMs: result.latencyMs,
        apiProtocol: config.apiProtocol, usage: result.usage, thinkingMode: config.thinkingMode, firstDeltaMs,
        thinkingChars: result.thinking?.length ?? thinkingChars, replyChars: result.reply?.length ?? replyChars,
      });
    } finally {
      live.inflight.delete(key);
    }
  }

  private async runAi(live: Live, seat: Seat, decision: string): Promise<void> {
    const rec = live.rec;
    const cfg = rec.seats[seat - 1];
    const adapter = this.adapters[cfg.adapter] ?? getAdapter(cfg.adapter, cfg.apiProtocol);
    const thread = this.threadFor(live, seat);
    if (rec.state?.pending?.id !== decision || !readyToAct(thread, this.actionCue(rec))) return;
    ensureCue(thread, this.actionCue(rec));
    // 此刻才真正发出行动请求，排队、旁听和 AI 展示间隔均不占用行动时限。
    this.markAsked(live, seat);
    this.scheduleSave(live);
    this.notify(live);
    const projection = this.attachDeadline(rec, seat, projectSeat(rec.state!, rec.events, seat));
    const legal = projection.task?.tools ?? [];
    if (!legal.length) return;
    const tools = seatTools(rec.state!, seat);
    const key = `${decision}:${seat}`;
    const ctrl = new AbortController();
    live.inflight.set(key, ctrl);
    const gen = live.gen;
    const model = cfg.adapter === 'mock' ? 'mock' : cfg.model;
    const stillWaiting = () =>
      live.gen === gen && rec.status === 'running' && rec.state?.pending?.id === decision && waitingSeats(rec.state).includes(seat);
    let last: { thinking?: string; reply?: string } | undefined;
    try {
      const limit = aiTimeoutSec(rec.state?.pending?.step.type ?? '', cfg.timeoutSec);
      let config: AdapterConfig;
      try {
        config = { ...this.adapterConfig(cfg), timeoutSec: limit };
      } catch {
        this.writeAudit(live, { seat, model, decisionId: decision, projectionVersion: projection.version, ok: false, error: '密钥无法解密（主密钥可能已更换），已托管' });
        this.fallbackIfWaiting(live, seat, decision, 'request_failed');
        return;
      }
      if (cfg.adapter !== 'mock') this.pushThought(live, seat, decision, {});
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const deadline = rec.deadlines[`${decision}:${seat}`];
        if (!stillWaiting()) return;
        if (deadline !== undefined && this.now() >= deadline) {
          this.fallbackIfWaiting(live, seat, decision, 'timeout');
          return;
        }
        const messages = [...thread.messages];
        const started = this.now();
        let firstDeltaMs: number | undefined;
        let thinkingChars = 0;
        let replyChars = 0;
        let result: DecideResult;
        let request: ModelRequestInfo | undefined;
        try {
          result = await adapter.decide({
            seat,
            projection,
            messages,
            tools,
            config: { ...config, timeoutSec: deadline === undefined ? limit : Math.max(0.001, Math.min(limit, (deadline - this.now()) / 1000)) },
            cacheKey: `werewolf:${rec.id}:seat:${seat}`,
            signal: ctrl.signal,
            stream: cfg.adapter !== 'mock',
            onRequest: (info) => { request = info; },
            onDelta: (delta) => {
              firstDeltaMs ??= this.now() - started;
              thinkingChars += delta.thinking?.length ?? 0;
              replyChars += delta.reply?.length ?? 0;
              if (stillWaiting() && !ctrl.signal.aborted) this.pushThought(live, seat, decision, delta);
            },
          });
          last = result;
        } catch (e) {
          if (live.gen !== gen || ctrl.signal.aborted || rec.status !== 'running') return;
          result = { ok: false, fatal: true, error: redact((e as Error).message, config.apiKey), failureKind: 'network', toolCallIds: [], latencyMs: 0 };
        }
        if (!stillWaiting()) {
          if (live.gen === gen) this.rememberReply(thread, result, '决策已经结束，这次结果作废，不再执行。');
          this.writeAudit(live, { seat, model, decisionId: decision, projectionVersion: projection.version, purpose: 'action', attempt, deadline, failureKind: 'cancelled', ok: false, messages, request, apiProtocol: config.apiProtocol, error: '决策已经结束，这次结果作废', latencyMs: result.latencyMs });
          return;
        }
        let error = result.ok && result.call ? undefined : result.error ?? '没有调用工具';
        if (result.ok && result.call) {
          const res = this.apply(live, { seat, call: clampTexts(result.call, tools), decisionId: decision });
          if (res.error) error = res.error.reason;
        }
        this.rememberReply(thread, result, error, rec.state?.pending?.id === decision ? rec.state.pending.tools[seat] : undefined);
        this.writeAudit(live, {
          seat,
          model,
          decisionId: decision,
          projectionVersion: projection.version,
          purpose: 'action', attempt, deadline,
          failureKind: result.failureKind ?? (error ? 'invalid_tool' : undefined),
          ok: !error,
          messages,
          request,
          response: result.raw ?? result.call,
          ...(result.call ? { toolCall: result.call } : {}),
          ...(error ? { error: redact(error, config.apiKey) } : {}),
          latencyMs: result.latencyMs,
          apiProtocol: config.apiProtocol, usage: result.usage, thinkingMode: config.thinkingMode, firstDeltaMs,
          thinkingChars: result.thinking?.length ?? thinkingChars, replyChars: result.reply?.length ?? replyChars,
        });
        if (!error) return;
        if (result.fatal) {
          this.fallbackIfWaiting(live, seat, decision, result.failureKind === 'timeout' || /^超过/.test(result.error ?? '') ? 'timeout' : 'request_failed');
          return;
        }
      }
      this.fallbackIfWaiting(live, seat, decision, 'invalid_tool');
    } finally {
      this.finishThought(live, seat, decision, last);
      live.inflight.delete(key);
    }
  }
}
