import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AdapterKind,
  AuditEntry,
  Catalog,
  ControlAction,
  CreateRoomResult,
  GodProjection,
  Projection,
  ModelPresetView,
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
  type ChatMessage,
} from '@werewolf/llm';
import {
  NOT_TOOL_TURN,
  notToolTurnMessages,
  ownLine,
  syncThread,
  taskMessage,
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
  /** 真人超时检查间隔，0 表示不启动定时器。 */
  tickMs?: number;
  /** 页面里添加的模型。不传则只留在内存里。 */
  modelsPath?: string;
}

const MAX_ATTEMPTS = 5;
const SPEECH_LIMIT_SEC = 180;
const VOTE_LIMIT_SEC = 90;

/** 发言（含遗言、狼队密谈）3 分钟，放逐和警长投票 90 秒，其余用座位或真人时限。 */
export function actionLimitSec(stepType: string, fallback: number): number {
  if (stepType === 'speech' || stepType === 'wolf.discuss') return SPEECH_LIMIT_SEC;
  if (stepType === 'exile.vote' || stepType === 'sheriff.vote') return VOTE_LIMIT_SEC;
  return fallback;
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
    timeoutSec: 60,
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
      if (chars.length > p.maxLength) args[p.name] = chars.slice(0, p.maxLength).join('');
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

  addModel(body: { name?: unknown; baseUrl?: unknown; apiKey?: unknown }): ModelPresetView {
    try {
      return this.models.add(String(body.name ?? ''), String(body.baseUrl ?? ''), String(body.apiKey ?? ''));
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
    this.changed(live);
    return this.setupView(rec);
  }

  private applySeat(rec: RoomRecord, s: SeatConfigInput): void {
    const seat = rec.seats.find((x) => x.seat === s.seat);
    if (!seat) throw new ApiFailure(400, 'BAD_REQUEST', `没有 ${s.seat} 号座位`);
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
    if (s.timeoutSec !== undefined) seat.timeoutSec = Math.round(clamp(s.timeoutSec, 5, 300, 60));
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
      seat.modelId = preset.id;
      seat.model = preset.model;
      seat.baseUrl = preset.baseUrl;
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
  }

  private seatView(s: SeatRecord): SeatConfigView {
    const { apiKeyEnc: _enc, apiKeyMask, ...rest } = s;
    return { ...rest, apiKeyMasked: apiKeyMask, modelId: s.modelId ?? null };
  }

  private setupErrors(rec: RoomRecord): string[] {
    const errors = validateRules(buildRules(rec.presetId, rec.ruleValues));
    for (const s of rec.seats) {
      if (s.controller !== 'ai' || s.adapter !== 'openai_compatible') continue;
      if (!s.baseUrl) errors.push(`${s.seat}号：没有填写接口地址`);
      if (!s.model) errors.push(`${s.seat}号：没有填写模型名`);
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

  /** 视角只由凭证决定。请求里的任何「视角」参数都不会提升权限。 */
  view(roomId: string, tok: string): ViewResponse {
    const { live, viewer } = this.resolve(roomId, tok);
    const rec = live.rec;
    return { room: this.brief(rec, viewer), projection: rec.state ? this.project(rec, viewer) : null };
  }

  act(roomId: string, tok: string, body: { decisionId?: unknown; tool?: unknown; args?: unknown }) {
    const { live, viewer } = this.resolve(roomId, tok);
    if (viewer.role !== 'seat') throw new ApiFailure(403, 'FORBIDDEN', '只有座位凭证可以提交行动');
    const rec = live.rec;
    if (rec.status !== 'running' || !rec.state) throw new ApiFailure(409, 'NOT_RUNNING', '对局不在进行中');
    if (rec.seats[viewer.seat - 1].controller !== 'human') throw new ApiFailure(409, 'NOT_HUMAN_SEAT', '这个座位由模型控制');
    if (rec.paused) throw new ApiFailure(409, 'PAUSED', '对局已暂停');
    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
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
    return () => live.subscribers.delete(sub);
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
    };
  }

  private visibleThoughts(rec: RoomRecord, viewer: Viewer) {
    const all = rec.thoughts ?? [];
    if (viewer.role === 'host') return all;
    if (viewer.role === 'seat') return all.filter((t) => t.seat === viewer.seat);
    return [];
  }

  private project(rec: RoomRecord, viewer: Viewer): Projection | GodProjection {
    const state = rec.state!;
    if (viewer.role === 'spectator') return projectSpectator(state, rec.events);
    const p = viewer.role === 'host' ? projectGod(state, rec.events) : projectSeat(state, rec.events, viewer.seat);
    if (viewer.role === 'seat') {
      const deadline = p.task && !p.task.submitted ? rec.deadlines[`${p.task.decisionId}:${viewer.seat}`] : undefined;
      if (p.task && deadline) p.task.deadline = deadline;
    }
    const thoughts = this.visibleThoughts(rec, viewer);
    if (thoughts.length) p.thoughts = thoughts;
    return p;
  }

  private signature(rec: RoomRecord, viewer: Viewer): string {
    if (!rec.state) return JSON.stringify([rec.status]);
    const p = this.project(rec, viewer);
    return JSON.stringify([
      rec.status,
      rec.paused,
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
      if (!current || !key.startsWith(`${current}:`)) {
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

  /** 为当前决策里还没提交的真人座位设置截止时间；reset 时全部重新计时（例如恢复暂停后）。 */
  private armDeadlines(live: Live, reset: boolean): void {
    const rec = live.rec;
    const d = rec.state?.pending;
    const next: Record<string, number> = {};
    if (d && rec.status === 'running' && rec.humanTimeoutSec > 0) {
      for (const seat of waitingSeats(rec.state!)) {
        if (!this.isHuman(rec, seat)) continue;
        const key = `${d.id}:${seat}`;
        const limit = actionLimitSec(d.step.type, rec.humanTimeoutSec);
        next[key] = !reset && rec.deadlines[key] ? rec.deadlines[key] : this.now() + limit * 1000;
      }
    }
    rec.deadlines = next;
  }

  /** 真人超时托管。暂停期间不计时。 */
  tick(): void {
    for (const live of this.rooms.values()) {
      const rec = live.rec;
      const d = rec.state?.pending;
      if (rec.status !== 'running' || rec.paused || !d) continue;
      const expired = waitingSeats(rec.state!).find((seat) => {
        const dl = rec.deadlines[`${d.id}:${seat}`];
        return this.isHuman(rec, seat) && dl !== undefined && this.now() >= dl;
      });
      if (expired === undefined) continue;
      this.apply(live, { seat: expired, call: AUTO, auto: true, decisionId: d.id });
      void this.pump(live);
    }
  }

  private adapterConfig(s: SeatRecord): AdapterConfig {
    const live = s.modelId ? this.models.find(s.modelId) : undefined;
    return {
      baseUrl: live?.baseUrl || s.baseUrl,
      model: live?.model || s.model,
      apiKey: live ? live.apiKey : s.apiKeyEnc ? this.secrets.decrypt(s.apiKeyEnc) : null,
      temperature: s.temperature,
      toolMode: s.toolMode,
      timeoutSec: s.timeoutSec,
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
      const state = rec.state;
      if (live.gen !== gen || rec.status !== 'running' || !state?.pending) return;
      const stepping = rec.paused && live.stepBudget > 0;
      if (rec.paused && !stepping) return;
      if (stepping) live.stepBudget -= 1;
      await this.reactToSpeeches(live);
      if (live.gen !== gen || rec.status !== 'running' || !rec.state?.pending) return;
      if (!stepping && rec.paused) return;
      if (!waitingSeats(rec.state).some((s) => !this.isHuman(rec, s))) return;
      const decision = rec.state.pending.id;
      if (!stepping && rec.aiPacingMs > 0) await this.sleep(rec.aiPacingMs);
      if (live.gen !== gen || rec.status !== 'running') return;
      if (rec.state?.pending?.id !== decision || (!stepping && rec.paused)) continue;
      const seats = waitingSeats(rec.state).filter((s) => !this.isHuman(rec, s) && !live.inflight.has(`${decision}:${s}`));
      if (!seats.length) return;
      await Promise.all(seats.map((seat) => this.runAi(live, seat, decision)));
      if (live.gen !== gen || rec.status !== 'running') return;
      const stuck = rec.state?.pending?.id === decision && seats.every((s) => waitingSeats(rec.state!).includes(s));
      if (stuck) throw new Error(`决策 ${decision} 没有推进`);
    }
  }

  private syncThread(live: Live, seat: Seat): SeatThread {
    const rec = live.rec;
    rec.threads ??= [];
    let thread = rec.threads.find((t) => t.seat === seat);
    if (!thread) {
      thread = { seat, seen: 0, messages: [] };
      rec.threads.push(thread);
    }
    const projection = projectSeat(rec.state!, rec.events, seat);
    const cfg = rec.seats[seat - 1];
    const system = buildMessages(projection, styleText(cfg.style, cfg.persona), {
      speechSec: SPEECH_LIMIT_SEC,
      skillSec: cfg.timeoutSec,
    })[0];
    syncThread(thread, rec.events, system);
    return thread;
  }

  /** 一段发言落地后，广播给其他座位。工具列表不变。调用了工具就退回，不执行。 */
  private async reactToSpeeches(live: Live): Promise<void> {
    const rec = live.rec;
    const gen = live.gen;
    rec.heardSeq ??= 0;
    const fresh = rec.events.filter((e) => (e.type === 'speech' || e.type === 'wolf.chat') && e.seq > rec.heardSeq!);
    if (!fresh.length) return;
    try {
      for (const e of fresh) {
        if (live.gen !== gen || rec.status !== 'running') return;
        for (const s of rec.seats) if (!this.isHuman(rec, s.seat)) this.syncThread(live, s.seat);
        const speaker = e.payload.seat;
        const listeners = rec.seats
          .map((s) => s.seat)
          .filter((seat) => {
            if (this.isHuman(rec, seat) || seat === speaker) return false;
            return e.audience === 'public' || (Array.isArray(e.audience) && e.audience.includes(seat));
          });
        await Promise.all(listeners.map((seat) => this.reactOnce(live, seat, e.seq)));
        if (live.gen !== gen || rec.status !== 'running') return;
        rec.heardSeq = e.seq;
      }
    } finally {
      this.scheduleSave(live);
    }
  }

  private async reactOnce(live: Live, seat: Seat, speechSeq: number): Promise<void> {
    const rec = live.rec;
    const cfg = rec.seats[seat - 1];
    const adapter = this.adapters[cfg.adapter] ?? getAdapter(cfg.adapter);
    const projection = projectSeat(rec.state!, rec.events, seat);
    const tools = seatTools(rec.state!, seat);
    const decision = rec.state?.pending?.id ?? `hear:${speechSeq}`;
    const key = `${decision}:hear:${seat}`;
    const ctrl = new AbortController();
    live.inflight.set(key, ctrl);
    const gen = live.gen;
    const model = cfg.adapter === 'mock' ? 'mock' : cfg.model;
    const thread = this.syncThread(live, seat);
    let messages: ChatMessage[] = [
      ...thread.messages,
      { role: 'user', name: 'judge', content: '现在没有轮到你发言。这不是工具调用轮次，请勿调用。' },
    ];
    try {
      let config: AdapterConfig;
      try {
        config = { ...this.adapterConfig(cfg), timeoutSec: cfg.timeoutSec };
      } catch {
        this.writeAudit(live, { seat, model, decisionId: decision, projectionVersion: projection.version, ok: false, error: '密钥无法解密（主密钥可能已更换）' });
        return;
      }
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (live.gen !== gen || ctrl.signal.aborted || rec.status !== 'running') return;
        let result;
        try {
          result = await adapter.decide({
            seat,
            projection,
            messages,
            tools,
            config,
            signal: ctrl.signal,
            stream: false,
            toolChoice: 'auto',
          });
        } catch (e) {
          if (live.gen !== gen || ctrl.signal.aborted || rec.status !== 'running') return;
          throw e;
        }
        if (live.gen !== gen || rec.status !== 'running') return;
        if (result.call) {
          const error = NOT_TOOL_TURN;
          this.writeAudit(live, {
            seat,
            model,
            decisionId: decision,
            projectionVersion: projection.version,
            ok: false,
            messages,
            response: result.raw ?? result.call,
            toolCall: result.call,
            error,
            latencyMs: result.latencyMs,
          });
          if (result.fatal) return;
          messages = [...messages, ...notToolTurnMessages(result)];
          continue;
        }
        const text = (result.reply || (typeof result.assistant?.content === 'string' ? result.assistant.content : '')).trim();
        if (result.ok && text) {
          thread.messages.push(
            { role: 'user', name: 'judge', content: '现在没有轮到你发言。这不是工具调用轮次，请勿调用。' },
            { role: 'assistant', content: text },
          );
        }
        if (!result.ok && !result.fatal && attempt < MAX_ATTEMPTS) {
          messages = [...messages, ...feedbackMessages(result, result.error ?? '')];
          continue;
        }
        this.writeAudit(live, {
          seat,
          model,
          decisionId: decision,
          projectionVersion: projection.version,
          ok: result.ok,
          messages,
          ...(result.raw ? { response: result.raw } : {}),
          ...(result.ok ? {} : { error: result.error }),
          latencyMs: result.latencyMs,
        });
        return;
      }
    } finally {
      live.inflight.delete(key);
    }
  }

  private async runAi(live: Live, seat: Seat, decision: string): Promise<void> {
    const rec = live.rec;
    const cfg = rec.seats[seat - 1];
    const adapter = this.adapters[cfg.adapter] ?? getAdapter(cfg.adapter);
    const projection = projectSeat(rec.state!, rec.events, seat);
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
      const limit = actionLimitSec(rec.state?.pending?.step.type ?? '', cfg.timeoutSec);
      const thread = this.syncThread(live, seat);
      const task = taskMessage(projection);
      let messages: ChatMessage[] = [...thread.messages, task];
      let config: AdapterConfig;
      try {
        config = { ...this.adapterConfig(cfg), timeoutSec: limit };
      } catch {
        this.writeAudit(live, { seat, model, decisionId: decision, projectionVersion: projection.version, ok: false, error: '密钥无法解密（主密钥可能已更换），已托管' });
        if (stillWaiting()) this.apply(live, { seat, call: AUTO, auto: true, decisionId: decision });
        return;
      }
      const onDelta = (delta: { thinking?: string; reply?: string }) => {
        if (live.gen !== gen || rec.status !== 'running') return;
        this.pushThought(live, seat, decision, delta);
      };
      if (cfg.adapter !== 'mock') this.pushThought(live, seat, decision, {});
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let result;
        try {
          result = await adapter.decide({
            seat,
            projection,
            messages,
            tools,
            config,
            signal: ctrl.signal,
            stream: cfg.adapter !== 'mock',
            onDelta,
          });
          last = result;
        } catch (e) {
          if (live.gen !== gen || ctrl.signal.aborted || rec.status !== 'running') return;
          throw e;
        }
        if (!stillWaiting()) {
          this.writeAudit(live, { seat, model, decisionId: decision, projectionVersion: projection.version, ok: false, messages, error: '决策已经结束，这次结果作废', latencyMs: result.latencyMs });
          return;
        }
        let error = result.ok ? undefined : result.error;
        if (result.ok && result.call) {
          const res = this.apply(live, { seat, call: clampTexts(result.call, tools), decisionId: decision });
          if (res.error) error = res.error.reason;
          else {
            thread.messages.push(task, { role: 'assistant', content: ownLine(result.call.tool, result.call.args) });
          }
        }
        this.writeAudit(live, {
          seat,
          model,
          decisionId: decision,
          projectionVersion: projection.version,
          ok: !error,
          messages,
          response: result.raw ?? result.call,
          ...(result.call ? { toolCall: result.call } : {}),
          ...(error ? { error: redact(error, config.apiKey) } : {}),
          latencyMs: result.latencyMs,
        });
        if (!error || result.fatal) break;
        messages = [...messages, ...feedbackMessages(result, error)];
      }
      if (stillWaiting()) this.apply(live, { seat, call: AUTO, auto: true, decisionId: decision });
    } finally {
      this.finishThought(live, seat, decision, last);
      live.inflight.delete(key);
    }
  }
}
