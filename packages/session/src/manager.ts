import { actionKind, defaultGameTiming, parseGameTiming, deathCauses } from '@werewolf/protocol';
import { DEFAULT_GAME_LOCALE, gameText, isGameLocale } from '@werewolf/protocol';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { THINKING_MODES, thinkingOptions, defaultThinkingMode, apiProtocol, apiUrl, actionMenu, avatarDefaultName, isAvatarStyleId } from '@werewolf/protocol';
import type {
  AdapterKind,
  AvatarStyleId,
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

import { ApiFailure } from './room-failure';
import { RoomPersistence } from './room-persistence';
import { RoomViewService } from './room-view';
import { RoomLobbyService } from './room-lobby';
import { adapterConfig } from './room-model';
import type { ManagerOptions, RoomRuntimeState, RoomViewState, Subscriber, Viewer } from './room-types';
export { ApiFailure } from './room-failure';
export type { ManagerOptions } from './room-types';

type Live = RoomRuntimeState;

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Request cancelled'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
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
  private readonly persistence: RoomPersistence;
  private readonly views: RoomViewService;
  private readonly lobby: RoomLobbyService;
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
    this.persistence = new RoomPersistence(o.store, this.now);
    this.lobby = new RoomLobbyService(this.now, o.secrets, this.models);
    this.views = new RoomViewService(this.now, {
      seatView: this.lobby.seatView.bind(this.lobby),
      setupErrors: this.lobby.setupErrors.bind(this.lobby),
      scheduleSave: this.persistence.scheduleSave.bind(this.persistence),
    });
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
      this.views.dispose(live.rec);
      this.flush(live);
    }
  }

  // -------------------------------------------------------------------------
  // 房间与开局配置
  // -------------------------------------------------------------------------

  catalog(): Catalog {
    return this.lobby.catalog();
  }

  /** 统一项目模型库，包含已迁移和网页新增的条目；没有密钥明文。 */
  modelPresets(): ModelPresetView[] {
    return this.models.views();
  }

  importLegacyModels(): number { return this.models.importLegacySettings(); }

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

  createRoom(input: Pick<RoomSetupInput, 'avatarStyle' | 'locale'> = {}): CreateRoomResult {
    const rec = this.lobby.createRoom(input);
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
    this.lobby.cloneSetup(src, live.rec);
    this.flush(live);
    return created;
  }

  getSetup(roomId: string, tok: string): RoomSetupView {
    return this.views.setupView(this.host(roomId, tok).rec);
  }

  updateSetup(roomId: string, tok: string, input: RoomSetupInput): RoomSetupView {
    const live = this.host(roomId, tok);
    this.lobby.updateSetup(live.rec, input);
    this.changed(live);
    return this.views.setupView(live.rec);
  }





  async testSeat(roomId: string, tok: string, seat: Seat): Promise<SeatTestResult> {
    return this.lobby.testSeat(this.host(roomId, tok).rec, seat);
  }

  start(roomId: string, tok: string): RoomSetupView {
    const live = this.host(roomId, tok);
    const rec = live.rec;
    this.lobby.validateStart(rec);
    const rules = buildRules(rec.presetId, rec.ruleValues, { locale: rec.locale });
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
    return this.views.setupView(rec);
  }

  control(roomId: string, tok: string, action: ControlAction): RoomBrief {
    const live = this.host(roomId, tok);
    const rec = live.rec;
    if (rec.status !== 'running') throw new ApiFailure(409, 'NOT_RUNNING', '对局不在进行中');
    if (action === 'pause') {
      if (!rec.paused && rec.timing && rec.actionAvailableAt) {
        live.gatePausedAt = this.now();
        rec.actionGateRemainingMs = Math.max(0, rec.actionAvailableAt - live.gatePausedAt);
      }
      if (!rec.paused) {
        if (rec.timing) rec.deadlineRemainingMs = Object.fromEntries(Object.entries(rec.deadlines).map(([key, deadline]) => [key, Math.max(0, deadline - this.now())]));
        live.gen += 1;
        for (const ctrl of live.inflight.values()) ctrl.abort();
        live.inflight.clear();
      }
      rec.paused = true;
      live.stepBudget = 0;
    } else if (action === 'resume') {
      if (rec.paused && rec.timing && rec.actionAvailableAt && live.gatePausedAt !== undefined) {
        const remaining = rec.actionGateRemainingMs ?? Math.max(0, rec.actionAvailableAt - live.gatePausedAt);
        rec.actionAvailableAt = remaining ? this.now() + remaining : undefined;
      }
      delete rec.actionGateRemainingMs;
      live.gatePausedAt = undefined;
      rec.paused = false;
      live.stepBudget = 0;
      if (rec.timing && rec.deadlineRemainingMs) {
        rec.deadlines = Object.fromEntries(Object.entries(rec.deadlineRemainingMs).map(([key, remaining]) => [key, this.now() + remaining]));
        delete rec.deadlineRemainingMs;
        this.armDeadlines(live, false);
      } else this.armDeadlines(live, true);
    } else if (action === 'step') {
      if (!rec.paused) throw new ApiFailure(409, 'NOT_PAUSED', '单步只在暂停时可用');
      if (rec.timing && rec.actionAvailableAt && (rec.actionGateRemainingMs ?? Math.max(0, rec.actionAvailableAt - (live.gatePausedAt ?? this.now()))) > 0) {
        throw new ApiFailure(409, 'ACTION_NOT_OPEN', '推进间隔尚未结束，请恢复对局后继续');
      }
      if (rec.timing && rec.deadlineRemainingMs) rec.deadlines = Object.fromEntries(Object.entries(rec.deadlineRemainingMs).map(([key, remaining]) => [key, this.now() + remaining]));
      live.stepBudget += 1;
    } else if (action === 'end') {
      this.stopMatch(live);
    } else throw new ApiFailure(400, 'BAD_REQUEST', `未知操作：${String(action)}`);
    this.changed(live);
    if (action !== 'end') void this.pump(live);
    return this.views.brief(rec, { role: 'host' });
  }

  // -------------------------------------------------------------------------
  // 投影、行动、订阅
  // -------------------------------------------------------------------------

  /** 座位凭证只能修改本人昵称和准备状态。运行中可重新接入，不改变任何对局事实。 */
  participate(roomId: string, tok: string, input: ParticipantInput): ViewResponse {
    const { live, viewer } = this.resolve(roomId, tok);
    this.lobby.participate(live.rec, viewer, input);
    this.changed(live);
    return this.view(roomId, tok);
  }

  /** 视角只由凭证决定。请求里的任何「视角」参数都不会提升权限。 */
  view(roomId: string, tok: string): ViewResponse {
    const { live, viewer } = this.resolve(roomId, tok);
    return this.views.view(live.rec, viewer);
  }

  speechLocale(roomId: string, tok: string): string {
    return this.views.speechLocale(this.resolve(roomId, tok).live.rec);
  }

  speechText(roomId: string, tok: string, seq: unknown): string {
    const { live, viewer } = this.resolve(roomId, tok);
    return this.views.speechText(live.rec, viewer, seq);
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
    return this.views.subscribe(live.rec, viewer, send);
  }

  audit(roomId: string, tok: string): AuditEntry[] {
    this.host(roomId, tok);
    return this.persistence.audit(roomId);
  }

  exportRecord(roomId: string, tok: string, kind: 'public' | 'god'): unknown {
    const { live, viewer } = this.resolve(roomId, tok);
    return this.views.exportRecord(live.rec, viewer, kind);
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
      gatePausedAt: rec.paused && rec.timing && rec.actionAvailableAt ? this.now() : undefined,
      gen: 0,
      inflight: new Map(),
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
    delete rec.actionAvailableAt;
    delete rec.actionGateRemainingMs;
    delete rec.deadlineRemainingMs;
    live.gatePausedAt = undefined;
    rec.status = 'ended';
  }

  private resolve(roomId: string, tok: string): { live: Live; viewer: Viewer } {
    const live = this.rooms.get(roomId);
    const { viewer } = this.lobby.resolve(live?.rec, tok);
    return { live: live!, viewer };
  }

  private host(roomId: string, tok: string): Live {
    const live = this.rooms.get(roomId);
    this.lobby.host(live?.rec, tok);
    return live!;
  }




  /** 模型和座位页面看到同一份投影，包括这一步还剩多少时间。 */



  private apply(live: Live, input: SubmitInput): EngineResult {
    const rec = live.rec;
    if (rec.status !== 'running' || rec.state?.result) {
      return { state: rec.state!, events: [], error: { code: 'GAME_ENDED', reason: '对局已经结束' } };
    }
    if (rec.timing && rec.actionAvailableAt && this.now() < rec.actionAvailableAt) throw new ApiFailure(409, 'ACTION_NOT_OPEN', '推进间隔尚未结束，请稍后行动');
    const previous = rec.state?.pending;
    const res = submit(rec.state!, input);
    rec.state = res.state;
    rec.events.push(...res.events);
    rec.actions.push(input);
    if (rec.state.result) rec.status = 'ended';
    if (!res.error && rec.timing && previous && previous.id !== rec.state.pending?.id && rec.status === 'running') {
      const interval = rec.timing[actionKind(previous.step.type)].intervalMs;
      rec.actionAvailableAt = interval > 0 ? this.now() + interval : undefined;
      if (rec.paused && rec.actionAvailableAt) {
        live.gatePausedAt = this.now();
        rec.actionGateRemainingMs = interval;
      }
    }
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
        if (live.inflight.get(key) === ctrl) live.inflight.delete(key);
      }
    }
    this.scheduleSave(live);
    this.views.notify(live.rec);
  }

  /** 只通知视角有变化的订阅者。思考的流式更新走这里，不重新武装截止时间，也不取消请求。 */


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
    this.views.publishThoughts(live.rec, false);
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
    this.views.publishThoughts(live.rec, true);
  }

  private scheduleSave(live: Live): void {
    this.persistence.scheduleSave(live.rec);
  }

  private flush(live: Live): void {
    this.persistence.flush(live.rec);
  }

  private isHuman(rec: RoomRecord, seat: Seat): boolean {
    return rec.seats[seat - 1]?.controller === 'human';
  }

  /** 真人从这一步开始计时。模型要等法官这句话进了自己的上下文，才开始计时。 */
  private armDeadlines(live: Live, reset: boolean): void {
    const rec = live.rec;
    const d = rec.state?.pending;
    if (rec.paused) return;
    const next: Record<string, number> = {};
    if (rec.timing && rec.actionAvailableAt && this.now() < rec.actionAvailableAt) { rec.deadlines = {}; return; }
    if (d && rec.status === 'running') {
      for (const seat of waitingSeats(rec.state!)) {
        const key = `${d.id}:${seat}`;
        const human = this.isHuman(rec, seat);
        if (human) {
          if (!rec.timing && rec.humanTimeoutSec <= 0) continue;
          const limit = rec.timing?.[actionKind(d.step.type)].limitSec ?? actionLimitSec(d.step.type, rec.humanTimeoutSec);
          next[key] = !reset && rec.deadlines[key] ? rec.deadlines[key] : this.now() + limit * 1000;
          continue;
        }
        if (!rec.deadlines[key] || !readyToAct(this.threadFor(live, seat), this.actionCue(rec))) continue;
        const limit = rec.timing?.[actionKind(d.step.type)].limitSec ?? aiTimeoutSec(d.step.type, rec.seats[seat - 1].timeoutSec);
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
    const limit = rec.timing?.[actionKind(d.step.type)].limitSec ?? aiTimeoutSec(d.step.type, rec.seats[seat - 1].timeoutSec);
    rec.deadlines[key] = this.now() + limit * 1000;
  }

  /** 到点还没提交的座位按该步骤的托管行动结算。上警托管就是不上警。暂停期间不计时。 */
  tick(): void {
    for (const live of this.rooms.values()) {
      const rec = live.rec;
      const d = rec.state?.pending;
      if (rec.status !== 'running' || rec.paused || !d) continue;
      if (rec.actionAvailableAt) {
        if (this.now() < rec.actionAvailableAt) continue;
        delete rec.actionAvailableAt;
        this.changed(live);
        void this.pump(live);
      }
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


  private writeAudit(live: Live, entry: Omit<AuditEntry, 'id' | 'at'>): void {
    this.persistence.writeAudit(live.rec, entry);
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
        if (live.again && live.rec.status === 'running') void this.pump(live);
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
      if (rec.timing && rec.actionAvailableAt) {
        const availableAt = rec.actionAvailableAt;
        const decision = rec.state?.pending?.id;
        if (stepping && live.gatePausedAt !== undefined && (rec.actionGateRemainingMs ?? availableAt - live.gatePausedAt) > 0) return;
        if (!stepping && availableAt > this.now()) await this.sleep(availableAt - this.now());
        if (live.gen !== gen || rec.paused && !stepping) return;
        if (rec.state?.pending?.id !== decision) continue;
        if (rec.actionAvailableAt !== availableAt || !stepping && availableAt > this.now()) continue;
        if (rec.actionAvailableAt === availableAt) { delete rec.actionAvailableAt; this.changed(live); }
      }
      const wave = this.prepareWave(live);
      if (!wave) {
        if (rec.status !== 'running' || !rec.state?.pending) return;
        if (!waitingSeats(rec.state).some((s) => !this.isHuman(rec, s))) return;
        throw new Error(`决策 ${rec.state.pending.id} 没有推进`);
      }
      if (!wave.length) continue;
      if (stepping) live.stepBudget -= 1;
      const decision = rec.state?.pending?.id ?? 'end';
      if (!rec.timing && !stepping && rec.aiPacingMs > 0) await this.sleep(rec.aiPacingMs);
      if (live.gen !== gen || (rec.paused && !stepping) || (rec.status !== 'running' && rec.status !== 'ended')) return;
      const actions = wave.filter((w) => w.action).map((w) => w.seat);
      await Promise.all(wave.map((w) => (w.action ? this.runAi(live, w.seat, decision) : this.receive(live, w.seat, decision))));
      if (stepping && rec.paused && rec.timing && live.gen === gen) rec.deadlineRemainingMs = Object.fromEntries(Object.entries(rec.deadlines).map(([key, deadline]) => [key, Math.max(0, deadline - this.now())]));
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
    thread.locale = rec.state?.rules.locale ?? rec.locale ?? DEFAULT_GAME_LOCALE;
    return migrateThread(thread);
  }

  private syncThread(live: Live, seat: Seat, maxSeq = Number.POSITIVE_INFINITY): SeatThread {
    const thread = this.threadFor(live, seat);
    const rec = live.rec;
    const projection = projectSeat(rec.state!, rec.events, seat);
    const cfg = rec.seats[seat - 1];
    const system = buildMessages(projection, styleText(cfg.style, cfg.persona, rec.state!.rules.locale), {
      speechSec: rec.timing?.speech.limitSec ?? SPEECH_LIMIT_SEC,
      skillSec: rec.timing?.skill.limitSec ?? Math.max(MIN_EVENT_SEC, cfg.timeoutSec),
      voteSec: rec.timing?.vote.limitSec ?? VOTE_LIMIT_SEC,
    })[0];
    syncThread(thread, rec.events, system, { ...this.turnHint(rec), locale: rec.state!.rules.locale, cue: rec.status === 'running' ? this.actionCue(rec) : null }, maxSeq);
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
      locale: rec.state!.rules.locale,
      id: d.id,
      // 老存档没有边界时，先收齐已有事件，再补本轮问话。
      afterSeq: d.openedAtSeq ?? rec.events.at(-1)?.seq ?? 0,
      step: d.step.type,
      kind: typeof d.step.kind === 'string' ? d.step.kind : null,
      actors,
      prompts: d.prompts,
      allowedTools: d.tools,
      ...(rec.state!.rules.electionVersion === 3 && d.step.type === 'speech' && d.step.kind === 'campaign' ? {
        interruptTools: Object.fromEntries(rec.state!.players.map((p) => {
          const tools = projectSeat(rec.state!, rec.events, p.seat).interrupts;
          return [p.seat, tools.some((t) => t.name === 'sheriff_withdraw') ? tools : []];
        })),
      } : {}),
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
    const locale = thread.locale;
    if (error && result.fatal && !result.toolCallIds.length) {
      if (result.assistant?.content) thread.messages.push(result.assistant);
      thread.messages.push({ role: 'user', name: 'judge', content: gameText(locale, '本次模型请求未完成：{0}', error) });
      return;
    }
    if (error) {
      thread.messages.push(...feedbackMessages(result, `${error}${legalTools?.length ? `\n${actionMenu(legalTools, locale)}` : ''}`, locale));
      return;
    }
    const call = result.call;
    const reply = result.assistant ?? { role: 'assistant' as const, content: call ? ownLine(call.tool, call.args, locale) : result.reply ?? '' };
    if (reply.content || (reply.role === 'assistant' && (reply.calls?.length || reply.native?.items.length))) thread.messages.push(reply);
    if (reply.role === 'assistant' && reply.calls?.length) {
      for (const c of reply.calls) thread.messages.push({ role: 'tool', callId: c.id, content: call ? ownLine(call.tool, call.args, locale) : gameText(locale, '已收到。') });
    }
  }

  /** 旁听失败只影响这次旁听，不消耗当前行动，也不触发托管。 */
  private async receive(live: Live, seat: Seat, decision: string): Promise<void> {
    const rec = live.rec;
    const cfg = rec.seats[seat - 1];
    const adapter = this.adapters[cfg.adapter] ?? getAdapter(cfg.adapter, cfg.apiProtocol);
    const projection = this.views.attachDeadline(rec, seat, projectSeat(rec.state!, rec.events, seat));
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
        config = { ...adapterConfig(cfg, this.secrets), timeoutSec: aiTimeoutSec('', cfg.timeoutSec) };
      } catch {
        this.writeAudit(live, { seat, model, decisionId: decision, projectionVersion: projection.version, purpose: 'listen', ok: false, error: '密钥无法解密（主密钥可能已更换）' });
        return;
      }
      if (live.gen !== gen || ctrl.signal.aborted) return;
      let result: DecideResult;
      try {
        result = await abortable(adapter.decide({
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
        }), ctrl.signal);
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
        error = !allowed ? gameText(rec.state!.rules.locale, NOT_TOOL_TURN)
          : rec.timing && rec.actionAvailableAt && this.now() < rec.actionAvailableAt ? gameText(rec.state!.rules.locale, '推进间隔尚未结束，请稍后行动')
            : this.apply(live, { seat, call }).error?.reason;
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
      if (live.inflight.get(key) === ctrl) live.inflight.delete(key);
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
    this.views.notify(live.rec);
    const projection = this.views.attachDeadline(rec, seat, projectSeat(rec.state!, rec.events, seat));
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
      const limit = rec.timing?.[actionKind(rec.state?.pending?.step.type ?? '')].limitSec ?? aiTimeoutSec(rec.state?.pending?.step.type ?? '', cfg.timeoutSec);
      let config: AdapterConfig;
      try {
        config = { ...adapterConfig(cfg, this.secrets), timeoutSec: limit };
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
          result = await abortable(adapter.decide({
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
          }), ctrl.signal);
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
      if (live.inflight.get(key) === ctrl) live.inflight.delete(key);
    }
  }
}
