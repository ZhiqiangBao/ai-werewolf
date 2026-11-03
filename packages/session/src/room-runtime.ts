import { randomBytes } from 'node:crypto';
import { actionKind, actionMenu, DEFAULT_GAME_LOCALE, gameText } from '@werewolf/protocol';
import type { AdapterKind, AuditEntry, ControlAction, ModelRequestInfo, Projection, Seat, SeatTestResult, ToolCall, ToolSpec } from '@werewolf/protocol';
import { abandonGame, buildRules, createGame, migrateGameState, UnsupportedRoleDataVersion, projectSeat, seatTools, seatTasksComplete, submit, waitingSeats, type EngineResult, type SubmitInput } from '@werewolf/engine';
import { buildMessages, feedbackMessages, getAdapter, redact, styleText, type Adapter, type AdapterConfig, type DecideRequest, type DecideResult, type TranscriptMessage } from '@werewolf/llm';
import { NOT_TOOL_TURN, migrateThread, ensureCue, ownLine, readyToAct, syncThread, type ActionCue, type TurnHint, type SeatThread } from './agent';
import { ApiFailure } from './room-failure';
import { adapterConfig } from './room-model';
import type { OwnedRoomFields, RoomReadRecord, RoomRuntimeRecord, RoomRuntimeState, Viewer } from './room-types';
import type { SecretBox } from './secret';
import type { RoomRecord } from './store';
import { measured, missing, type ObservationSpan, type RoomObservability } from './observability/collector';
import type { CancelReason, ObservationOutcome, ObservationRef } from '@werewolf/protocol';

interface RuntimePorts {
  scheduleSave(rec: RoomReadRecord): void;
  writeAudit(rec: RoomReadRecord, entry: Omit<AuditEntry, 'id' | 'at'>): void;
  notify(rec: RoomReadRecord): void;
  publishThoughts(rec: RoomReadRecord, immediate: boolean): void;
  attachDeadline(rec: RoomReadRecord, seat: Seat, projection: Projection): Projection;
}

interface WorkObservation {
  ref: ObservationRef;
  work?: ObservationSpan;
  segment?: ObservationSpan;
  call?: ObservationSpan;
  endedAt?: number;
  firstDeltaMs?: number;
  outcome?: ObservationOutcome;
  adapterOutcome?: ObservationOutcome;
  markAskedMs?: number;
}

interface SeatActionIds {
  decisionId: string | undefined;
  normal?: string;
  interrupt?: string;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Request cancelled')); };
    if (signal.aborted) { work.catch(() => {}); return abort(); }
    signal.addEventListener('abort', abort, { once: true });
    work.then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
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

/** 每房间唯一的运行协调器；保持原推进流程和整波旁听等待。 */
export class RoomRuntimeService {
  private readonly rooms = new Map<string, RoomRuntimeState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly cancelReasons = new WeakMap<AbortSignal, CancelReason>();
  /** Per room and seat, retain only IDs for that seat's most recent decision. */
  private readonly actionIds = new Map<string, Map<Seat, SeatActionIds>>();
  private readonly connectionTests = new Map<string, Set<{ controller: AbortController; task: Promise<SeatTestResult> }>>();

  constructor(
    private readonly now: () => number,
    sleep: ((ms: number) => Promise<void>) | undefined,
    private readonly secrets: SecretBox,
    private readonly adapters: Partial<Record<AdapterKind, Adapter>>,
    private readonly ports: RuntimePorts,
    private readonly observability?: RoomObservability,
    private readonly isActive: () => boolean = () => true,
  ) {
    this.sleep = sleep;
  }

  startTimer(tickMs: number): void {
    if (this.timer) return;
    this.timer = tickMs > 0 ? setInterval(() => this.tick(), tickMs) : null;
    this.timer?.unref?.();
  }

  register(rec: RoomRuntimeRecord, restored: boolean): void {
    if (rec.state) {
      try { rec.state = migrateGameState(rec.state); }
      catch (error) {
        if (!(error instanceof UnsupportedRoleDataVersion)) throw error;
        rec.paused = true;
      }
    }
    this.observability?.room(rec);
    if (restored) {
      if (rec.heardSeq === undefined) rec.heardSeq = rec.events.reduce((m, e) => Math.max(m, e.seq), 0);
      rec.threads ??= [];
    }
    this.rooms.set(rec.id, this.live(rec));
  }

  private state(rec: RoomRuntimeRecord): RoomRuntimeState {
    return this.rooms.get(rec.id)!;
  }

  /** 服务启动后继续推进进行中的对局。 */
  resumeAll(): void {
    if (!this.isActive()) return;
    for (const live of this.rooms.values()) {
      if (live.rec.status === 'running') {
        this.armDeadlines(live, true);
        void this.pump(live);
      }
    }
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 由兼容入口逐房间调用，保留取消该房间后立即落盘的退出顺序。 */
  disposeRoom(rec: RoomRuntimeRecord): { pending: number; auditFailures: number } {
    const live = this.state(rec);
    live.gen += 1; live.again = false; live.stepBudget = 0;
    live.disposeController.abort();
    const tests = this.connectionTests.get(rec.id);
    const pending = live.inflight.size + live.externalWaits + (tests?.size ?? 0);
    let auditFailures = 0;
    for (const call of live.pendingCalls.values()) {
      try { this.ports.writeAudit(rec, { ...call.entry, latencyMs: Math.max(0, Math.round(performance.now() - call.startedAt)) }); }
      catch { auditFailures++; }
    }
    live.pendingCalls.clear();
    for (const c of live.inflight.values()) this.cancel(c, 'dispose');
    for (const test of tests ?? []) test.controller.abort();
    live.inflight.clear();
    for (const thought of rec.thoughts ?? []) thought.live = false;
    this.actionIds.delete(rec.id);
    return { pending, auditFailures };
  }

  private actionId(roomId: string, seat: Seat, decisionId: string | undefined, interrupt = false): string {
    let seats = this.actionIds.get(roomId);
    if (!seats) { seats = new Map(); this.actionIds.set(roomId, seats); }
    let ids = seats.get(seat);
    if (!ids || ids.decisionId !== decisionId) { ids = { decisionId }; seats.set(seat, ids); }
    const key = interrupt ? 'interrupt' : 'normal';
    return ids[key] ??= this.observability!.id('action');
  }

  private cancel(controller: AbortController, reason: CancelReason): void {
    this.cancelReasons.set(controller.signal, reason);
    controller.abort();
  }

  /** 配置、候场和引擎事实变更共用既有的截止时间→取消→保存→通知顺序。 */
  changed(rec: RoomRuntimeRecord): void {
    this.changedState(this.state(rec));
  }

  start(rec: RoomRuntimeRecord): void {
    const live = this.state(rec);
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
    } satisfies Pick<RoomRecord, OwnedRoomFields<'runtime'>>);
    this.changedState(live);
    void this.pump(live);
  }

  control(rec: RoomRuntimeRecord, action: ControlAction): void {
    const live = this.state(rec);
    if (rec.status !== 'running') throw new ApiFailure(409, 'NOT_RUNNING', '对局不在进行中');
    if (action === 'resume' || action === 'step') {
      try { if (rec.state) rec.state = migrateGameState(rec.state); }
      catch (error) {
        if (!(error instanceof UnsupportedRoleDataVersion)) throw error;
        throw new ApiFailure(409, 'UNSUPPORTED_ROLE_DATA', error.message);
      }
    }
    if (action === 'pause') {
      if (!rec.paused && rec.timing && rec.actionAvailableAt) {
        live.gatePausedAt = this.now();
        rec.actionGateRemainingMs = Math.max(0, rec.actionAvailableAt - live.gatePausedAt);
      }
      if (!rec.paused) {
        if (rec.timing) rec.deadlineRemainingMs = Object.fromEntries(Object.entries(rec.deadlines).map(([key, deadline]) => [key, Math.max(0, deadline - this.now())]));
        live.gen += 1;
        for (const ctrl of live.inflight.values()) this.cancel(ctrl, 'pause');
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
    this.changedState(live);
    if (action !== 'end') void this.pump(live);
  }

  act(rec: RoomRuntimeRecord, viewer: Viewer, body: { decisionId?: unknown; tool?: unknown; args?: unknown }) {
    const live = this.state(rec);
    if (viewer.role !== 'seat') throw new ApiFailure(403, 'FORBIDDEN', '只有座位凭证可以提交行动');
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

  private live(rec: RoomRuntimeRecord): RoomRuntimeState {
    return {
      rec,
      running: null,
      again: false,
      stepBudget: 0,
      gatePausedAt: rec.paused && rec.timing && rec.actionAvailableAt ? this.now() : undefined,
      gen: 0,
      inflight: new Map(),
      disposeController: new AbortController(),
      externalWaits: 0,
      pendingCalls: new Map(),
    };
  }

  private stopMatch(live: RoomRuntimeState): void {
    const rec = live.rec;
    if (!rec.state) throw new ApiFailure(409, 'NOT_RUNNING', '对局不在进行中');
    live.gen += 1;
    live.again = false;
    live.stepBudget = 0;
    for (const ctrl of live.inflight.values()) this.cancel(ctrl, 'end');
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

  private apply(live: RoomRuntimeState, input: SubmitInput, causedBy?: ObservationRef): EngineResult {
    const rec = live.rec;
    if (rec.status !== 'running' || rec.state?.result) {
      return { state: rec.state!, events: [], error: { code: 'GAME_ENDED', reason: '对局已经结束' } };
    }
    if (rec.timing && rec.actionAvailableAt && this.now() < rec.actionAvailableAt) throw new ApiFailure(409, 'ACTION_NOT_OPEN', '推进间隔尚未结束，请稍后行动');
    const previous = rec.state?.pending;
    let action: ObservationSpan | undefined;
    if (this.observability) {
      const interrupt = projectSeat(rec.state!, rec.events, input.seat).interrupts.some((tool) => tool.name === input.call.tool);
      const ref = { ...causedBy, ...this.observability.ref(rec, input.seat, previous?.id) };
      const actionId = causedBy?.actionId ?? this.actionId(rec.id, input.seat, previous?.id, interrupt);
      action = this.observability.begin('engine_action', { ...ref, actionId }, {
        actionKind: input.auto ? 'automatic' : interrupt ? 'interrupt' : 'normal',
        ...(causedBy?.callId ? { causedByCallId: causedBy.callId } : {}),
      });
    }
    let res: EngineResult;
    try { res = submit(rec.state!, input); }
    catch (error) { action?.finish('local_error'); throw error; }
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
    this.changedState(live);
    action?.finish(res.error ? 'rejected' : input.auto ? 'fallback' : 'accepted');
    return res;
  }

  private changedState(live: RoomRuntimeState): void {
    this.armDeadlines(live, false);
    const current = live.rec.state?.pending?.id;
    if (live.rec.status !== 'running') this.actionIds.delete(live.rec.id);
    for (const [key, ctrl] of live.inflight) {
      const hearSeat = /:hear:(\d+):/.exec(key)?.[1];
      if (hearSeat && live.rec.state && seatTasksComplete(live.rec.state, Number(hearSeat))) {
        this.cancel(ctrl, 'seat_complete');
        if (live.inflight.get(key) === ctrl) live.inflight.delete(key);
        continue;
      }
      // 旁听属于这条消息，不属于当时碰巧正在等待的行动；换下一位不能取消别人的收听。
      if (!key.includes(':hear:') && (!current || !key.startsWith(`${current}:`))) {
        this.cancel(ctrl, 'decision_changed');
        if (live.inflight.get(key) === ctrl) live.inflight.delete(key);
      }
    }
    this.ports.scheduleSave(live.rec);
    this.ports.notify(live.rec);
  }

  private pushThought(live: RoomRuntimeState, seat: Seat, decision: string, delta: { thinking?: string; reply?: string }): void {
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
    this.ports.publishThoughts(live.rec, false);
  }

  private finishThought(live: RoomRuntimeState, seat: Seat, decision: string, result?: { thinking?: string; reply?: string }): void {
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
    this.ports.publishThoughts(live.rec, true);
  }

  private isHuman(rec: RoomRuntimeRecord, seat: Seat): boolean {
    return rec.seats[seat - 1]?.controller === 'human';
  }

  /** 真人从窗口开放起计时；模型等问话入席并发出正式请求后才计时。 */
  private armDeadlines(live: RoomRuntimeState, reset: boolean): void {
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

  private markAsked(live: RoomRuntimeState, seat: Seat): void {
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

  tick(): void {
    if (!this.isActive()) return;
    for (const live of this.rooms.values()) {
      const rec = live.rec;
      const d = rec.state?.pending;
      if (rec.status !== 'running' || rec.paused || !d) continue;
      if (rec.actionAvailableAt) {
        if (this.now() < rec.actionAvailableAt) continue;
        delete rec.actionAvailableAt;
        this.changedState(live);
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

  /** 每房间复用一个推进任务；重复触发只安排当前任务结束后重新检查。 */
  private pump(live: RoomRuntimeState): Promise<void> {
    if (!this.isActive() || live.rec.status === 'ended') return Promise.resolve();
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
        this.changedState(live);
      } finally {
        live.running = null;
        if (this.isActive() && live.again && live.rec.status === 'running') void this.pump(live);
      }
    })();
    return live.running;
  }

  async whenIdle(roomId: string): Promise<void> {
    const live = this.rooms.get(roomId);
    while (live?.running) await live.running;
  }

  testSeat(rec: RoomRuntimeRecord, run: (signal: AbortSignal) => Promise<SeatTestResult>): Promise<SeatTestResult> {
    const controller = new AbortController();
    const tests = this.connectionTests.get(rec.id) ?? new Set(); this.connectionTests.set(rec.id, tests);
    let cancel!: () => void;
    const cancelled = new Promise<SeatTestResult>((resolve) => { cancel = () => resolve({ ok: false, message: '服务正在关闭，连接检查已取消。', latencyMs: 0 }); controller.signal.addEventListener('abort', cancel, { once: true }); });
    const task = Promise.race([run(controller.signal), cancelled]);
    const entry = { controller, task }; tests.add(entry);
    void task.then(() => { controller.signal.removeEventListener('abort', cancel); tests.delete(entry); }, () => { controller.signal.removeEventListener('abort', cancel); tests.delete(entry); });
    return task;
  }

  async whenStopped(roomId: string): Promise<void> {
    const live = this.rooms.get(roomId);
    const pending: Promise<unknown>[] = [...(this.connectionTests.get(roomId) ?? [])].map((entry) => entry.task);
    if (live?.running) pending.push(live.running);
    await Promise.allSettled(pending);
  }

  private async pumpOnce(live: RoomRuntimeState): Promise<void> {
    const rec = live.rec;
    const gen = live.gen;
    for (;;) {
      const observed = this.observability;
      const waveRef = observed ? { ...observed.ref(rec), waveId: observed.id('wave') } : undefined;
      const waveSpan = waveRef ? observed!.begin('wave', waveRef, {}, waveRef.waveId) : undefined;
      const members: ObservationSpan[] = [];
      let outcome: ObservationOutcome = 'empty';
      let preparedMs: number | undefined;
      let awaitMs: number | undefined;
      try {
      if (live.gen !== gen) return;
      if (rec.status !== 'running' && rec.status !== 'ended') return;
      const stepping = rec.paused && live.stepBudget > 0;
      if (rec.paused && !stepping) return;
      if (rec.timing && rec.actionAvailableAt) {
        const availableAt = rec.actionAvailableAt;
        const decision = rec.state?.pending?.id;
        if (stepping && live.gatePausedAt !== undefined && (rec.actionGateRemainingMs ?? availableAt - live.gatePausedAt) > 0) return;
        if (!stepping && availableAt > this.now()) await this.observedWait(live, 'gate_wait', availableAt - this.now(), waveRef);
        if (live.gen !== gen || rec.paused && !stepping) return;
        if (rec.state?.pending?.id !== decision) continue;
        if (rec.actionAvailableAt !== availableAt || !stepping && availableAt > this.now()) continue;
        if (rec.actionAvailableAt === availableAt) { delete rec.actionAvailableAt; this.changedState(live); }
      }
      const prepareStarted = observed?.clock.monotonicMs();
      const wave = this.prepareWave(live);
      if (prepareStarted !== undefined) preparedMs = observed!.clock.monotonicMs() - prepareStarted;
      if (wave?.length && observed && waveRef) {
        outcome = 'success';
        for (const item of wave) {
          const ref = { ...observed.ref(rec, item.seat, rec.state?.pending?.id), ...waveRef, seatRef: `s${item.seat}` };
          const workId = observed.id('work');
          members.push(observed.begin('work', { ...ref, workId }, { purpose: item.action ? 'action' : 'listen', ...observed.provider(rec.seats[item.seat - 1]) }, workId));
        }
      }
      if (!wave) {
        if (rec.status !== 'running' || !rec.state?.pending) return;
        if (!waitingSeats(rec.state).some((s) => !this.isHuman(rec, s))) return;
        throw new Error(`决策 ${rec.state.pending.id} 没有推进`);
      }
      if (!wave.length) continue;
      if (stepping) live.stepBudget -= 1;
      const decision = rec.state?.pending?.id ?? 'end';
      if (!rec.timing && !stepping && rec.aiPacingMs > 0) await this.observedWait(live, 'pacing_wait', rec.aiPacingMs, waveRef);
      if (live.gen !== gen || (rec.paused && !stepping) || (rec.status !== 'running' && rec.status !== 'ended')) return;
      const actions = wave.filter((w) => w.action).map((w) => w.seat);
      const awaitStarted = observed?.clock.monotonicMs();
      try {
        await Promise.all(wave.map((w, i) => (w.action ? this.runAi(live, w.seat, decision, members[i]) : this.receive(live, w.seat, decision, members[i]))));
      } finally { if (awaitStarted !== undefined) awaitMs = observed!.clock.monotonicMs() - awaitStarted; }
      if (live.gen !== gen || !this.isActive()) return;
      const waveAwaitEnded = awaitStarted === undefined || awaitMs === undefined ? undefined : awaitStarted + awaitMs;
      if (observed && waveAwaitEnded !== undefined) for (const member of members) if (member.endedAt !== undefined) {
        const tail = observed.begin('local_span', member.ref, { parentId: member.id, ...member.fields });
        tail.finish('success', { memberTailWaitMs: measured(waveAwaitEnded - member.endedAt) });
      }
      if (stepping && rec.paused && rec.timing && live.gen === gen) rec.deadlineRemainingMs = Object.fromEntries(Object.entries(rec.deadlines).map(([key, deadline]) => [key, Math.max(0, deadline - this.now())]));
      this.ports.scheduleSave(live.rec);
      if (rec.status !== 'running') continue;
      const stuck = actions.length > 0 && rec.state?.pending?.id === decision && actions.every((s) => waitingSeats(rec.state!).includes(s));
      if (stuck) throw new Error(`决策 ${decision} 没有推进`);
      } catch (error) {
        outcome = 'await_rejected';
        throw error;
      } finally {
        // Promise.all 失败可能早于其余成员；保留它们的真实终态，不提前标成取消。
        if (outcome !== 'await_rejected') for (const member of members) if (member.endedAt === undefined) member.finish(live.gen !== gen || rec.paused ? 'cancelled' : 'skipped');
        waveSpan?.finish(outcome, { waveWallMs: measured(waveSpan.elapsed()),
          ...(preparedMs === undefined ? {} : { wavePrepareMs: measured(preparedMs) }),
          ...(awaitMs === undefined ? {} : { waveAwaitMs: measured(awaitMs) }) }, { members: members.length });
      }
    }
  }

  private threadFor(live: RoomRuntimeState, seat: Seat): SeatThread {
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

  private syncThread(live: RoomRuntimeState, seat: Seat, maxSeq = Number.POSITIVE_INFINITY): SeatThread {
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

  /** 逐事件同步到可见座位；同波次并行请求，全部完成后才推进下一波。 */
  private prepareWave(live: RoomRuntimeState): { seat: Seat; action: boolean }[] | null {
    const rec = live.rec;
    const ai = rec.seats.filter((s) => !this.isHuman(rec, s.seat) && rec.state && !seatTasksComplete(rec.state, s.seat));
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
      this.ports.scheduleSave(live.rec);
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
    if (wave.length) this.ports.scheduleSave(live.rec);
    return wave.length ? wave : null;
  }

  private turnHint(rec: RoomRuntimeRecord): TurnHint {
    const step = rec.state?.pending?.step;
    if (!step) return { nextSeat: null, nextStep: null };
    if (step.type === 'speech' || step.type === 'wolf.discuss') {
      return { nextSeat: rec.state!.pending!.actors[0] ?? null, nextStep: step.type };
    }
    return { nextSeat: null, nextStep: step.type };
  }

  private actionCue(rec: RoomRuntimeRecord): ActionCue | null {
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

  private fallbackIfWaiting(live: RoomRuntimeState, seat: Seat, decision: string, reason: SubmitInput['autoReason']): void {
    const rec = live.rec;
    const d = rec.state?.pending;
    if (rec.status !== 'running' || !d || d.id !== decision) return;
    if (!waitingSeats(rec.state!).includes(seat)) return;
    if (!rec.deadlines[`${decision}:${seat}`]) return;
    if (!readyToAct(this.threadFor(live, seat), this.actionCue(rec))) return;
    this.apply(live, { seat, call: AUTO, auto: true, autoReason: reason, decisionId: decision });
  }

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

  private receive(live: RoomRuntimeState, seat: Seat, decision: string, work?: ObservationSpan): Promise<void> {
    return this.observeWork(live, seat, decision, false, work);
  }

  private runAi(live: RoomRuntimeState, seat: Seat, decision: string, work?: ObservationSpan): Promise<void> {
    return this.observeWork(live, seat, decision, true, work);
  }

  private observeWork(live: RoomRuntimeState, seat: Seat, decision: string, action: boolean, selected?: ObservationSpan): Promise<void> {
    if (!this.observability) return action ? this.runAiWork(live, seat, decision) : this.receiveWork(live, seat, decision);
    const ref = selected?.ref ?? this.observability.ref(live.rec, seat, decision);
    const work = selected ?? this.observability.begin('work', ref, { purpose: action ? 'action' : 'listen', ...this.observability.provider(live.rec.seats[seat - 1]) });
    const context: WorkObservation = { ref: { ...ref, workId: work.id }, work };
    const gen = live.gen;
    return (async () => {
      try {
        await (action ? this.runAiWork(live, seat, decision, context) : this.receiveWork(live, seat, decision, context));
      } catch (error) {
        context.outcome ??= 'local_error';
        throw error;
      } finally {
        const outcome = context.outcome ?? (live.gen !== gen ? 'cancelled' : 'skipped');
        this.finishCall(context, outcome);
        context.segment?.finish(outcome, { actionSegmentMs: measured(context.segment.elapsed()),
          ...(context.markAskedMs === undefined ? {} : { markAskedMs: measured(context.markAskedMs) }) });
        work.finish(outcome);
      }
    })();
  }

  private invokeCall(live: RoomRuntimeState, adapter: Adapter, request: DecideRequest, controller: AbortController,
    context: WorkObservation | undefined, decisionId: string): Promise<DecideResult> {
    const gen = live.gen;
    const valid = () => this.isActive() && live.gen === gen && !controller.signal.aborted;
    const guarded: DecideRequest = { ...request,
      onDelta: request.onDelta ? (delta) => { if (valid()) request.onDelta!(delta); } : undefined,
      onRequest: request.onRequest ? (info) => { if (valid()) request.onRequest!(info); } : undefined };
    const track = (dispatch: () => Promise<DecideResult>): Promise<DecideResult> => {
      const cfg = live.rec.seats[request.seat - 1];
      const item = { startedAt: performance.now(), entry: { seat: request.seat, model: cfg.adapter === 'mock' ? 'mock' : cfg.model,
        decisionId, projectionVersion: request.projection?.version ?? 0, purpose: request.toolChoice === 'auto' ? 'listen' as const : 'action' as const,
        apiProtocol: request.config.apiProtocol, ok: false, failureKind: 'cancelled' as const, error: 'dispose' } };
      live.pendingCalls.set(controller, item);
      let pending: Promise<DecideResult>;
      try { pending = dispatch(); } catch (error) { live.pendingCalls.delete(controller); throw error; }
      return pending.then((result) => { if (live.pendingCalls.get(controller) === item) live.pendingCalls.delete(controller); return result; }, (error) => { if (live.pendingCalls.get(controller) === item) live.pendingCalls.delete(controller); throw error; });
    };
    if (!context || !this.observability) return track(() => abortable(adapter.decide(guarded), controller.signal));
    const callId = this.observability.id('call');
    const ref: ObservationRef = { ...context.ref, callId };
    const metadata = this.observability.provider(live.rec.seats[request.seat - 1]);
    context.call = this.observability.begin('model_call', ref, { ...metadata, purpose: request.toolChoice === 'auto' ? 'listen' : 'action',
      correctionAttempt: request.toolChoice === 'auto' ? undefined : context.call ? (context.call.fields.correctionAttempt ?? 0) + 1 : 1 }, callId);
    context.endedAt = undefined;
    context.firstDeltaMs = undefined;
    context.adapterOutcome = undefined;
    context.outcome = undefined;
    const cancel = () => this.finishCall(context, 'cancelled', this.cancelReasons.get(controller.signal) ?? 'unknown');
    controller.signal.addEventListener('abort', cancel, { once: true });
    const call = context.call;
    const preDispatch = context.work ? measured(call.started - context.work.started) : missing('not_applicable');
    call.fields.metrics = { localPreDispatchMs: preDispatch };
    let pending: Promise<DecideResult>;
    try {
      const port = this.observability.adapter(ref);
      pending = track(() => abortable(adapter.decide({ ...guarded, observation: { ...port, emit: (event) => {
        if (!valid() && !(this.isActive() && controller.signal.aborted && event.phase === 'end')) return;
        if (event.kind === 'adapter_execution' && event.phase === 'end') context.adapterOutcome = event.outcome;
        port.emit(event);
      } } }), controller.signal));
    } catch (error) {
      controller.signal.removeEventListener('abort', cancel);
      context.endedAt = this.observability.clock.monotonicMs();
      this.finishCall(context, 'local_error');
      throw error;
    }
    return pending.then((result) => {
      context.endedAt = this.observability!.clock.monotonicMs();
      controller.signal.removeEventListener('abort', cancel);
      return result;
    }, (error) => {
      context.endedAt = this.observability!.clock.monotonicMs();
      controller.signal.removeEventListener('abort', cancel);
      this.finishCall(context, controller.signal.aborted ? 'cancelled' : 'network_error', controller.signal.aborted ? this.cancelReasons.get(controller.signal) ?? 'unknown' : undefined);
      throw error;
    });
  }

  private resultOutcome(result: DecideResult, error: string | undefined, context?: WorkObservation): ObservationOutcome {
    if (!error) return 'success';
    if (context?.adapterOutcome === 'parse_error' || context?.adapterOutcome === 'local_error') return context.adapterOutcome;
    if (result.failureKind === 'timeout') return 'timeout';
    if (result.failureKind === 'cancelled') return 'cancelled';
    if (result.failureKind === 'http') return 'http_error';
    if (result.failureKind === 'network') return 'network_error';
    return 'invalid_tool';
  }

  private finishCall(context: WorkObservation | undefined, outcome: ObservationOutcome, cancelReason?: CancelReason): void {
    if (!context?.call || !this.observability) return;
    context.outcome = outcome;
    const call = context.call;
    const endedAt = context.endedAt ?? this.observability.clock.monotonicMs();
    call.finish(outcome, { ...call.fields.metrics, modelCallMs: measured(endedAt - call.started), providerQueueMs: missing(),
      legacyFirstDeltaMs: context.firstDeltaMs === undefined ? missing(outcome === 'cancelled' ? 'cancelled_before_point' : 'not_emitted') : measured(context.firstDeltaMs) },
      cancelReason ? { cancelReason } : {}, endedAt);
  }

  private writeObservedAudit(live: RoomRuntimeState, context: WorkObservation | undefined, entry: Omit<AuditEntry, 'id' | 'at'>): void {
    this.ports.writeAudit(live.rec, context ? { ...entry, observation: context.call?.ref ?? context.ref } : entry);
  }

  private observedWait(live: RoomRuntimeState, operation: 'gate_wait' | 'pacing_wait', plannedMs: number, ref?: ObservationRef): Promise<void> {
    const signal = live.disposeController.signal;
    const span = this.observability?.begin('local_span', ref ?? this.observability.ref(live.rec), { operation });
    const gen = live.gen;
    let wait: Promise<void>;
    if (this.sleep) {
      const external = this.sleep(plannedMs);
      live.externalWaits++;
      void external.then(() => { live.externalWaits--; }, () => { live.externalWaits--; });
      wait = abortable(external, signal);
    } else wait = new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error('Request cancelled'));
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, plannedMs);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Request cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
    });
    if (!span) return wait;
    return wait.then(() => span.finish(live.gen === gen ? 'success' : 'cancelled', {
      plannedWaitMs: measured(plannedMs), [operation === 'gate_wait' ? 'gateWaitMs' : 'pacingWaitMs']: measured(span.elapsed())
    }), (error) => { span.finish(live.gen === gen ? 'local_error' : 'cancelled'); throw error; });
  }

  /** 旁听属于消息；阶段变化不直接取消，提交打断前再次校验当前许可。 */
  private async receiveWork(live: RoomRuntimeState, seat: Seat, decision: string, context?: WorkObservation): Promise<void> {
    const rec = live.rec;
    if (!rec.state || seatTasksComplete(rec.state, seat)) return;
    const cfg = rec.seats[seat - 1];
    const adapter = this.adapters[cfg.adapter] ?? getAdapter(cfg.adapter, cfg.apiProtocol);
    const projection = this.ports.attachDeadline(rec, seat, projectSeat(rec.state!, rec.events, seat));
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
        if (context) context.outcome = 'local_error';
        this.writeObservedAudit(live, context, { seat, model, decisionId: decision, projectionVersion: projection.version, purpose: 'listen', ok: false, error: '密钥无法解密（主密钥可能已更换）' });
        return;
      }
      if (live.gen !== gen || ctrl.signal.aborted || seatTasksComplete(rec.state!, seat)) return;
      let result: DecideResult;
      try {
        result = await this.invokeCall(live, adapter, {
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
            if (context) context.firstDeltaMs = firstDeltaMs;
            thinkingChars += delta.thinking?.length ?? 0;
            replyChars += delta.reply?.length ?? 0;
          },
        }, ctrl, context, decision);
      } catch (e) {
        if (live.gen !== gen || ctrl.signal.aborted) return;
        result = { ok: false, fatal: true, error: redact((e as Error).message, config.apiKey), failureKind: 'network', toolCallIds: [], latencyMs: 0 };
      }
      if (live.gen !== gen || ctrl.signal.aborted || seatTasksComplete(rec.state!, seat)) return;
      let error = result.ok ? undefined : result.error ?? '旁听请求失败';
      if (result.ok && result.call) {
        const call = clampTexts(result.call, tools);
        const allowed = projection.interrupts.some((t) => t.name === call.tool) &&
          rec.status === 'running' && projectSeat(rec.state!, rec.events, seat).interrupts.some((t) => t.name === call.tool);
        // 旁听生成的普通行动不能借用随后到来的行动许可；错误只作为本次工具反馈返回。
        error = !allowed ? gameText(rec.state!.rules.locale, NOT_TOOL_TURN)
          : rec.timing && rec.actionAvailableAt && this.now() < rec.actionAvailableAt ? gameText(rec.state!.rules.locale, '推进间隔尚未结束，请稍后行动')
            : this.apply(live, { seat, call }, context?.call?.ref).error?.reason;
      }
      this.finishCall(context, this.resultOutcome(result, error, context));
      this.rememberReply(thread, result, error);
      this.writeObservedAudit(live, context, {
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

  private async runAiWork(live: RoomRuntimeState, seat: Seat, decision: string, context?: WorkObservation): Promise<void> {
    const rec = live.rec;
    const cfg = rec.seats[seat - 1];
    const adapter = this.adapters[cfg.adapter] ?? getAdapter(cfg.adapter, cfg.apiProtocol);
    const thread = this.threadFor(live, seat);
    if (rec.state?.pending?.id !== decision || !readyToAct(thread, this.actionCue(rec))) return;
    ensureCue(thread, this.actionCue(rec));
    // 此刻才真正发出行动请求，排队、旁听和 AI 展示间隔均不占用行动时限。
    if (context && this.observability) {
      const actionId = this.actionId(rec.id, seat, decision);
      const actionSegmentId = this.observability.id('segment');
      context.ref = { ...context.ref, actionId, actionSegmentId };
      context.segment = this.observability.begin('action_segment', context.ref, {}, actionSegmentId);
    }
    this.markAsked(live, seat);
    if (context?.segment) context.markAskedMs = context.segment.elapsed();
    this.ports.scheduleSave(live.rec);
    this.ports.notify(live.rec);
    const projection = this.ports.attachDeadline(rec, seat, projectSeat(rec.state!, rec.events, seat));
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
        if (context) context.outcome = 'local_error';
        this.writeObservedAudit(live, context, { seat, model, decisionId: decision, projectionVersion: projection.version, ok: false, error: '密钥无法解密（主密钥可能已更换），已托管' });
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
          result = await this.invokeCall(live, adapter, {
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
            if (context) context.firstDeltaMs = firstDeltaMs;
              thinkingChars += delta.thinking?.length ?? 0;
              replyChars += delta.reply?.length ?? 0;
              if (stillWaiting() && !ctrl.signal.aborted) this.pushThought(live, seat, decision, delta);
            },
          }, ctrl, context, decision);
          last = result;
        } catch (e) {
          if (live.gen !== gen || ctrl.signal.aborted || rec.status !== 'running') return;
          result = { ok: false, fatal: true, error: redact((e as Error).message, config.apiKey), failureKind: 'network', toolCallIds: [], latencyMs: 0 };
        }
        if (!stillWaiting()) {
          this.finishCall(context, 'stale');
          if (live.gen === gen) this.rememberReply(thread, result, '决策已经结束，这次结果作废，不再执行。');
          this.writeObservedAudit(live, context, { seat, model, decisionId: decision, projectionVersion: projection.version, purpose: 'action', attempt, deadline, failureKind: 'cancelled', ok: false, messages, request, apiProtocol: config.apiProtocol, error: '决策已经结束，这次结果作废', latencyMs: result.latencyMs });
          return;
        }
        let error = result.ok && result.call ? undefined : result.error ?? '没有调用工具';
        if (result.ok && result.call) {
          const res = this.apply(live, { seat, call: clampTexts(result.call, tools), decisionId: decision }, context?.call?.ref);
          if (res.error) error = res.error.reason;
        }
        this.finishCall(context, this.resultOutcome(result, error, context));
        this.rememberReply(thread, result, error, rec.state?.pending?.id === decision ? rec.state.pending.tools[seat] : undefined);
        this.writeObservedAudit(live, context, {
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
      if (live.gen === gen && this.isActive()) this.finishThought(live, seat, decision, last);
      if (live.inflight.get(key) === ctrl) live.inflight.delete(key);
    }
  }
}
