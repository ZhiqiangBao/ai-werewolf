import { DEFAULT_GAME_LOCALE, deathCauses, gameText } from '@werewolf/protocol';
import type { GodProjection, HumanParticipant, Projection, RoomBrief, RoomSetupView, Seat, SeatConfigView, ViewResponse } from '@werewolf/protocol';
import { buildRuleCard, buildRules, getPreset, projectGod, projectSeat, projectSpectator } from '@werewolf/engine';
import { ApiFailure } from './room-failure';
import type { SeatRecord } from './store';
import type { RoomReadRecord, RoomViewState, Subscriber, Viewer } from './room-types';

export class RoomViewService {
  private readonly states = new Map<string, RoomViewState>();
  private readonly closed = new Set<string>();

  constructor(private readonly now: () => number, private readonly ports: {
    seatView(s: SeatRecord): SeatConfigView;
    setupErrors(rec: RoomReadRecord): string[];
    scheduleSave(rec: RoomReadRecord): void;
  }) {}

  private getState(rec: RoomReadRecord): RoomViewState {
    let state = this.states.get(rec.id);
    if (!state) {
      state = { subscribers: new Set<Subscriber>(), thoughtTimer: null, thoughtNotifiedAt: 0 };
      this.states.set(rec.id, state);
    }
    return state;
  }

  setupView(rec: RoomReadRecord): RoomSetupView {
    const rules = rec.rules ?? buildRules(rec.presetId, rec.ruleValues, { locale: rec.locale });
    return {
      roomId: rec.id,
      locale: rec.rules?.locale ?? rec.locale ?? DEFAULT_GAME_LOCALE,
      avatarStyle: rec.avatarStyle,
      status: rec.status,
      paused: rec.paused,
      presetId: rec.presetId,
      ruleValues: rules.values,
      timing: rec.timing ?? { speech: { limitSec: 180, intervalMs: rec.aiPacingMs }, vote: { limitSec: 90, intervalMs: rec.aiPacingMs }, skill: { limitSec: rec.humanTimeoutSec || 90, intervalMs: rec.aiPacingMs } },
      humanTimeoutSec: rec.humanTimeoutSec,
      aiPacingMs: rec.aiPacingMs,
      seats: rec.seats.map((s) => this.ports.seatView(s)),
      tokens: {
        host: rec.hostToken,
        spectator: rec.spectatorToken,
        seats: rec.seatTokens.map((t, i) => ({ seat: i + 1, token: t })),
      },
      ruleCardPreview: buildRuleCard(rules),
      validationErrors: rec.status === 'setup' ? this.ports.setupErrors(rec) : [],
      participants: this.participants(rec),
    };
  }

  view(rec: RoomReadRecord, viewer: Viewer): ViewResponse {
    return { room: this.brief(rec, viewer), projection: rec.state ? this.project(rec, viewer) : null,
      presentation: { deaths: (rec.state?.deaths ?? []).map((d) => ({ seat: d.seat, day: d.day, causes: deathCauses(d.via, d.causes, viewer.role === 'host') })),
        ...(rec.actionAvailableAt ? { actionAvailableAt: rec.actionAvailableAt } : {}) } };
  }

  speechLocale(rec: RoomReadRecord): string {
    return rec.state?.rules.locale ?? rec.locale ?? DEFAULT_GAME_LOCALE;
  }

  speechText(rec: RoomReadRecord, viewer: Viewer, seq: unknown): string {
    if (!Number.isInteger(seq) || Number(seq) < 1) throw new ApiFailure(400, 'BAD_REQUEST', '请选择一条已提交发言');
    if (!rec.state) throw new ApiFailure(409, 'NOT_STARTED', '对局还没有开始');
    const event = this.project(rec, viewer).events.find((e) => e.seq === seq);
    if (!event || event.type !== 'speech' || typeof event.payload.content !== 'string') {
      throw new ApiFailure(404, 'NOT_FOUND', '这条记录不是当前视角可朗读的已提交发言');
    }
    return gameText(rec.state.rules.locale, '{0}号发言。{1}', event.payload.seat, event.payload.content);
  }

  subscribe(rec: RoomReadRecord, viewer: Viewer, send: (n: number) => void): () => void {
    const state = this.getState(rec);
    const sub: Subscriber = { viewer, send, sig: this.signature(rec, viewer), count: 0 };
    state.subscribers.add(sub);
    // 新订阅的响应头尚未写出；仅向已经建立的其他连接通知在线变化。
    sub.sig = this.signature(rec, viewer);
    this.notify(rec);
    return () => { state.subscribers.delete(sub); if (!this.closed.has(rec.id)) this.notify(rec); };
  }

  exportRecord(rec: RoomReadRecord, viewer: Viewer, kind: 'public' | 'god'): unknown {
    if (!rec.state) throw new ApiFailure(409, 'NOT_STARTED', '对局还没有开始');
    if (kind === 'god') {
      if (viewer.role !== 'host') throw new ApiFailure(403, 'FORBIDDEN', '只有房主可以导出上帝记录');
      return {
        roomId: rec.id,
        locale: rec.rules?.locale ?? rec.locale ?? DEFAULT_GAME_LOCALE,
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

  brief(rec: RoomReadRecord, viewer: Viewer): RoomBrief {
    return {
      roomId: rec.id,
      locale: rec.rules?.locale ?? rec.locale ?? DEFAULT_GAME_LOCALE,
      avatarStyle: rec.avatarStyle,
      status: rec.status,
      paused: rec.paused,
      viewer: viewer.role,
      ...(viewer.role === 'seat' ? { seat: viewer.seat } : {}),
      presetName: rec.rules?.presetName ?? getPreset(rec.presetId).name,
      seats: rec.seats.map((s) => ({ seat: s.seat, name: s.name, controller: s.controller })),
      participants: this.participants(rec),
      ...(rec.status === 'setup' ? { ruleCard: buildRuleCard(buildRules(rec.presetId, rec.ruleValues, { locale: rec.locale })) } : {}),
    };
  }

  private participants(rec: RoomReadRecord): HumanParticipant[] {
    const subscribers = this.states.get(rec.id)?.subscribers;
    return rec.seats.filter((s) => s.controller === 'human').map((s) => ({
      seat: s.seat, joined: rec.participants?.[s.seat]?.joined ?? false, ready: rec.participants?.[s.seat]?.ready ?? false,
      online: !!subscribers && [...subscribers].some((sub) => sub.viewer.role === 'seat' && sub.viewer.seat === s.seat),
    }));
  }

  private visibleThoughts(rec: RoomReadRecord, viewer: Viewer) {
    const all = rec.thoughts ?? [];
    if (viewer.role === 'host') return all;
    if (viewer.role === 'seat') return all.filter((t) => t.seat === viewer.seat);
    return [];
  }

  /** 模型和座位页面看到同一份投影，包括这一步还剩多少时间。 */
  attachDeadline(rec: RoomReadRecord, seat: Seat, projection: Projection): Projection {
    const deadline = projection.task && !projection.task.submitted ? rec.deadlines[`${projection.task.decisionId}:${seat}`] : undefined;
    if (projection.task && deadline) projection.task.deadline = deadline;
    return projection;
  }

  private project(rec: RoomReadRecord, viewer: Viewer): Projection | GodProjection {
    const state = rec.state!;
    if (viewer.role === 'spectator') return projectSpectator(state, rec.events);
    const p = viewer.role === 'host' ? projectGod(state, rec.events) : projectSeat(state, rec.events, viewer.seat);
    if (viewer.role === 'seat') this.attachDeadline(rec, viewer.seat, p);
    const thoughts = this.visibleThoughts(rec, viewer);
    if (thoughts.length) p.thoughts = thoughts;
    return p;
  }

  private signature(rec: RoomReadRecord, viewer: Viewer): string {
    const room = [rec.status, rec.paused, rec.avatarStyle, rec.actionAvailableAt, rec.seats.map((s) => [s.seat, s.name, s.controller]), this.participants(rec)];
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

  notify(rec: RoomReadRecord): void {
    if (this.closed.has(rec.id)) return;
    for (const sub of this.getState(rec).subscribers) {
      const sig = this.signature(rec, sub.viewer);
      if (sig === sub.sig) continue;
      sub.sig = sig;
      try {
        sub.send(++sub.count);
      } catch {
        this.getState(rec).subscribers.delete(sub);
      }
    }
  }

  publishThoughts(rec: RoomReadRecord, immediate: boolean): void {
    if (this.closed.has(rec.id)) return;
    const state = this.getState(rec);
    const send = () => {
      if (state.thoughtTimer) clearTimeout(state.thoughtTimer);
      state.thoughtTimer = null;
      state.thoughtNotifiedAt = this.now();
      this.ports.scheduleSave(rec);
      this.notify(rec);
    };
    if (immediate) {
      send();
      return;
    }
    const elapsed = this.now() - state.thoughtNotifiedAt;
    if (elapsed >= 80) {
      send();
      return;
    }
    if (state.thoughtTimer) return;
    state.thoughtTimer = setTimeout(send, 80 - elapsed);
  }

  dispose(rec: RoomReadRecord): void {
    this.closed.add(rec.id);
    const state = this.states.get(rec.id);
    if (state?.thoughtTimer) clearTimeout(state.thoughtTimer);
    if (state) { state.thoughtTimer = null; state.subscribers.clear(); }
  }
}
