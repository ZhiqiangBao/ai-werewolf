import { apiProtocol, LocalizedError } from '@werewolf/protocol';
import type { AuditEntry, Catalog, ControlAction, CreateRoomResult, ModelPresetView, ParticipantInput, RoomBrief, RoomSetupInput, RoomSetupView, Seat, SeatTestResult, ViewResponse } from '@werewolf/protocol';
import { ModelLibrary, sameModelRoute, validEnvName } from './model-library';
import { modelKeyEnvs } from './model-key-envs';
import { ApiFailure } from './room-failure';
import { RoomLobbyService } from './room-lobby';
import { RoomPersistence } from './room-persistence';
import { RoomRuntimeService } from './room-runtime';
import { RoomViewService } from './room-view';
import type { ManagerOptions } from './room-types';
import type { RoomRecord } from './store';
import { RoomObservability } from './observability/collector';

export { ApiFailure } from './room-failure';
export { actionLimitSec } from './room-runtime';
export type { ManagerOptions } from './room-types';

export interface DisposeReport {
  durable: boolean;
  rooms: { roomId: string; saved: boolean; errorCode?: string }[];
  errors: string[];
  externalUnconfirmed: number;
}

/** 兼容入口、依赖装配与房间生命周期；业务状态分别由各服务维护。 */
export class RoomManager {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly models: ModelLibrary;
  private readonly modelsPath?: string;
  private readonly lobby: RoomLobbyService;
  private readonly runtime: RoomRuntimeService;
  private readonly views: RoomViewService;
  private readonly persistence: RoomPersistence;
  private readonly observability?: RoomObservability;
  private lifecycle: 'active' | 'disposing' | 'disposed' = 'active';
  private resolveDisposed!: (report: DisposeReport) => void;
  private readonly disposedPromise = new Promise<DisposeReport>((resolve) => { this.resolveDisposed = resolve; });

  constructor(o: ManagerOptions) {
    const now = o.now ?? Date.now;
    this.observability = o.observability ? new RoomObservability(o.observability) : undefined;
    this.models = new ModelLibrary(o.secrets, o.modelsPath);
    this.modelsPath = o.modelsPath;
    this.persistence = new RoomPersistence(o.store, now, this.observability);
    this.lobby = new RoomLobbyService(now, o.secrets, this.models);
    this.views = new RoomViewService(now, {
      seatView: this.lobby.seatView.bind(this.lobby),
      setupErrors: this.lobby.setupErrors.bind(this.lobby),
      scheduleSave: this.persistence.scheduleSave.bind(this.persistence),
    });
    this.runtime = new RoomRuntimeService(now, o.sleep, o.secrets, o.adapters ?? {}, {
      scheduleSave: this.persistence.scheduleSave.bind(this.persistence),
      writeAudit: this.persistence.writeAudit.bind(this.persistence),
      notify: this.views.notify.bind(this.views),
      publishThoughts: this.views.publishThoughts.bind(this.views),
      attachDeadline: this.views.attachDeadline.bind(this.views),
    }, this.observability, () => this.lifecycle === 'active');
    const restored = this.observability ? this.observability.measure('store_load', undefined, () => o.store.loadAll()) : o.store.loadAll();
    for (const rec of restored) this.register(rec, true);
    this.runtime.startTimer(o.tickMs ?? 1000);
  }

  private register(rec: RoomRecord, restored = false): void {
    this.rooms.set(rec.id, rec);
    this.runtime.register(rec, restored);
  }

  resumeAll(): void {
    if (this.lifecycle !== 'active') return;
    this.runtime.resumeAll();
  }

  dispose(): void {
    if (this.lifecycle !== 'active') return;
    this.lifecycle = 'disposing';
    this.runtime.stopTimer();
    const rooms: DisposeReport['rooms'] = [], errors: string[] = [];
    let externalUnconfirmed = 0;
    for (const rec of this.rooms.values()) {
      try {
        const result = this.runtime.disposeRoom(rec); externalUnconfirmed += result.pending;
        if (result.auditFailures) errors.push('ROOM_CANCEL_AUDIT_FAILED');
      } catch { errors.push('ROOM_CANCEL_FAILED'); }
      try { this.views.dispose(rec); } catch { errors.push('ROOM_VIEW_RELEASE_FAILED'); }
      try { rooms.push(this.persistence.finish(rec)); } catch { rooms.push({ roomId: rec.id, saved: false, errorCode: 'ROOM_SAVE_FAILED' }); }
    }
    const pending = [...this.rooms.keys()].map((id) => this.runtime.whenStopped(id));
    void Promise.allSettled(pending).then(() => {
      try { this.observability?.finish(); } catch { errors.push('OBSERVABILITY_RELEASE_FAILED'); }
      this.lifecycle = 'disposed';
      this.resolveDisposed({ durable: rooms.every((room) => room.saved) && errors.length === 0, rooms, errors, externalUnconfirmed });
    });
  }

  whenDisposed(): Promise<DisposeReport> { return this.disposedPromise; }

  private assertActive(): void {
    if (this.lifecycle !== 'active') throw new ApiFailure(503, 'MANAGER_DISPOSED', '服务正在关闭，请稍后重新连接', { key: '服务正在关闭，请稍后重新连接' });
  }

  catalog(): Catalog {
    return this.lobby.catalog();
  }

  /** 统一项目模型库，包含已迁移和网页新增的条目；没有密钥明文。 */
  modelPresets(): ModelPresetView[] {
    return this.models.views().filter((model) => model.lifecycle !== 'archived');
  }

  modelKeyEnvs(): { name: string; available: boolean }[] {
    try { return modelKeyEnvs(this.modelsPath); }
    catch (e) { throw new ApiFailure(400, 'BAD_REQUEST', (e as Error).message, e instanceof LocalizedError ? e.localization : undefined); }
  }

  private assertRegisteredEnv(name: unknown, current?: string): void {
    if (typeof name !== 'string' || !name.trim()) return;
    if (!validEnvName(name.trim())) throw new LocalizedError('环境变量名称无效，请只填写变量名');
    if (name.trim() === current) return;
    if (!this.modelKeyEnvs().some((entry) => entry.name === name.trim())) throw new LocalizedError('请从项目配置的密钥环境变量中选择');
  }

  importLegacyModels(): number { this.assertActive(); return this.models.importLegacySettings(); }

  addModel(body: { name?: unknown; baseUrl?: unknown; apiKey?: unknown; apiKeyEnv?: unknown; apiProtocol?: unknown }): ModelPresetView {
    this.assertActive();
    try {
      if (body.apiKeyEnv !== undefined && typeof body.apiKeyEnv !== 'string') throw new LocalizedError('环境变量名称无效，请只填写变量名');
      if (body.apiKey !== undefined && typeof body.apiKey !== 'string') throw new LocalizedError('请填写密钥');
      this.assertRegisteredEnv(body.apiKeyEnv);
      return this.models.add(String(body.name ?? ''), String(body.baseUrl ?? ''), String(body.apiKey ?? ''), apiProtocol(body.apiProtocol), String(body.apiKeyEnv ?? ''));
    } catch (e) {
      if (e instanceof ApiFailure) throw e;
      throw new ApiFailure(400, 'BAD_REQUEST', (e as Error).message, e instanceof LocalizedError ? e.localization : undefined);
    }
  }

  deleteModel(id: string): void {
    this.assertActive();
    this.assertModelEditable(id, false);
    this.models.remove(id);
  }

  updateModel(id: string, body: { name?: unknown; baseUrl?: unknown; apiKey?: unknown; apiKeyEnv?: unknown; apiProtocol?: unknown }): ModelPresetView {
    this.assertActive();
    this.assertModelEditable(id, true);
    try {
      if (body.apiKeyEnv !== undefined && typeof body.apiKeyEnv !== 'string') throw new LocalizedError('环境变量名称无效，请只填写变量名');
      if (body.apiKey !== undefined && typeof body.apiKey !== 'string') throw new LocalizedError('请填写密钥');
      this.assertRegisteredEnv(body.apiKeyEnv, this.models.findRaw(id)?.apiKeyEnv);
      return this.models.update(id, String(body.name ?? ''), String(body.baseUrl ?? ''), String(body.apiKey ?? ''), apiProtocol(body.apiProtocol), String(body.apiKeyEnv ?? ''));
    } catch (e) {
      if (e instanceof LocalizedError) throw new ApiFailure(400, 'BAD_REQUEST', e.message, e.localization);
      throw e;
    }
  }

  private assertModelEditable(id: string, editing: boolean): void {
    const all = this.models.list();
    const target = all.find((model) => model.id === id && !model.mergedInto && model.lifecycle !== 'archived');
    if (!target) throw new ApiFailure(404, 'NOT_FOUND', '没有这个模型', { key: '没有这个模型' });
    const related = all.filter((model) => model.id === id || model.mergedInto === id);
    if (editing && related.length > 1) throw new ApiFailure(409, 'MODEL_ALIAS_IN_USE', '此模型存在归并的别名，请先使用本机维护工具处理。', { key: '此模型存在归并的别名，请先使用本机维护工具处理。' });
    if (editing) return;
    const inUse = [...this.rooms.values()].filter((room) => room.status !== 'ended' && room.seats.some((seat) => seat.controller === 'ai' && seat.adapter === 'openai_compatible' && related.some((model) =>
      seat.modelId === model.id || (seat.model === model.model && (seat.apiProtocol ?? 'chat_completions') === model.apiProtocol && sameModelRoute(seat.baseUrl, model.baseUrl, model.apiProtocol))))).map((room) => room.id);
    if (inUse.length) throw new ApiFailure(409, 'MODEL_IN_USE', `未结束的房间 ${inUse.join('、')} 正在使用此模型，请在这些房间更换模型或结束对局后重试。`, { key: '未结束的房间 {0} 正在使用此模型，请在这些房间更换模型或结束对局后重试。', values: [inUse.join('、')] });
  }

  createRoom(input: Pick<RoomSetupInput, 'avatarStyle' | 'locale'> = {}): CreateRoomResult {
    this.assertActive();
    const rec = this.lobby.createRoom(input);
    this.register(rec);
    this.persistence.flush(rec);
    return { roomId: rec.id, hostToken: rec.hostToken };
  }

  /** 用同样的配置（含加密密钥）开一个新房间，凭证全部重新生成。 */
  cloneRoom(roomId: string, tok: string): CreateRoomResult {
    const src = this.lobby.host(this.rooms.get(roomId), tok);
    this.assertActive();
    this.lobby.assertModelsAvailable(src);
    const created = this.createRoom();
    const rec = this.rooms.get(created.roomId)!;
    this.lobby.cloneSetup(src, rec);
    this.persistence.flush(rec);
    return created;
  }

  getSetup(roomId: string, tok: string, uiLocale?: string): RoomSetupView {
    return this.views.setupView(this.lobby.host(this.rooms.get(roomId), tok), uiLocale);
  }

  updateSetup(roomId: string, tok: string, input: RoomSetupInput, uiLocale?: string): RoomSetupView {
    const rec = this.lobby.host(this.rooms.get(roomId), tok);
    this.assertActive();
    this.lobby.updateSetup(rec, input);
    this.runtime.changed(rec);
    return this.views.setupView(rec, uiLocale);
  }

  async testSeat(roomId: string, tok: string, seat: Seat, uiLocale?: string): Promise<SeatTestResult> {
    const rec = this.lobby.host(this.rooms.get(roomId), tok);
    this.assertActive();
    return this.runtime.testSeat(rec, (signal) => this.lobby.testSeat(rec, seat, signal, uiLocale));
  }

  start(roomId: string, tok: string, uiLocale?: string): RoomSetupView {
    const rec = this.lobby.host(this.rooms.get(roomId), tok);
    this.assertActive();
    this.lobby.validateStart(rec, uiLocale);
    this.runtime.start(rec);
    return this.views.setupView(rec);
  }

  control(roomId: string, tok: string, action: ControlAction): RoomBrief {
    const rec = this.lobby.host(this.rooms.get(roomId), tok);
    this.assertActive();
    this.runtime.control(rec, action);
    return this.views.brief(rec, { role: 'host' });
  }

  /** 座位凭证只能修改本人昵称和准备状态；运行中接入不改对局事实。 */
  participate(roomId: string, tok: string, input: ParticipantInput): ViewResponse {
    const { rec, viewer } = this.lobby.resolve(this.rooms.get(roomId), tok);
    this.assertActive();
    this.lobby.participate(rec, viewer, input);
    this.runtime.changed(rec);
    return this.view(roomId, tok);
  }

  /** 视角只由凭证决定。 */
  view(roomId: string, tok: string): ViewResponse {
    const { rec, viewer } = this.lobby.resolve(this.rooms.get(roomId), tok);
    return this.views.view(rec, viewer);
  }

  speechLocale(roomId: string, tok: string): string {
    const { rec } = this.lobby.resolve(this.rooms.get(roomId), tok);
    return this.views.speechLocale(rec);
  }

  speechText(roomId: string, tok: string, seq: unknown): string {
    const { rec, viewer } = this.lobby.resolve(this.rooms.get(roomId), tok);
    return this.views.speechText(rec, viewer, seq);
  }

  act(roomId: string, tok: string, body: { decisionId?: unknown; tool?: unknown; args?: unknown }) {
    const { rec, viewer } = this.lobby.resolve(this.rooms.get(roomId), tok);
    this.assertActive();
    return this.runtime.act(rec, viewer, body);
  }

  subscribe(roomId: string, tok: string, send: (n: number) => void): () => void {
    const { rec, viewer } = this.lobby.resolve(this.rooms.get(roomId), tok);
    this.assertActive();
    return this.views.subscribe(rec, viewer, send);
  }

  audit(roomId: string, tok: string): AuditEntry[] {
    this.lobby.host(this.rooms.get(roomId), tok);
    return this.persistence.audit(roomId);
  }

  exportRecord(roomId: string, tok: string, kind: 'public' | 'god'): unknown {
    const { rec, viewer } = this.lobby.resolve(this.rooms.get(roomId), tok);
    return this.views.exportRecord(rec, viewer, kind);
  }

  tick(): void {
    if (this.lifecycle !== 'active') return;
    this.runtime.tick();
  }

  async whenIdle(roomId: string): Promise<void> {
    if (this.lifecycle !== 'active') { await this.whenDisposed(); return; }
    return this.runtime.whenIdle(roomId);
  }
}
