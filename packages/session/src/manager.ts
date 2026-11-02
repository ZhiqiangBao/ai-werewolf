import { apiProtocol } from '@werewolf/protocol';
import type { AuditEntry, Catalog, ControlAction, CreateRoomResult, ModelPresetView, ParticipantInput, RoomBrief, RoomSetupInput, RoomSetupView, Seat, SeatTestResult, ViewResponse } from '@werewolf/protocol';
import { ModelLibrary } from './model-library';
import { ApiFailure } from './room-failure';
import { RoomLobbyService } from './room-lobby';
import { RoomPersistence } from './room-persistence';
import { RoomRuntimeService } from './room-runtime';
import { RoomViewService } from './room-view';
import type { ManagerOptions } from './room-types';
import type { RoomRecord } from './store';

export { ApiFailure } from './room-failure';
export { actionLimitSec } from './room-runtime';
export type { ManagerOptions } from './room-types';

/** 兼容入口、依赖装配与房间生命周期；业务状态分别由各服务维护。 */
export class RoomManager {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly models: ModelLibrary;
  private readonly lobby: RoomLobbyService;
  private readonly runtime: RoomRuntimeService;
  private readonly views: RoomViewService;
  private readonly persistence: RoomPersistence;

  constructor(o: ManagerOptions) {
    const now = o.now ?? Date.now;
    this.models = new ModelLibrary(o.secrets, o.modelsPath);
    this.persistence = new RoomPersistence(o.store, now);
    this.lobby = new RoomLobbyService(now, o.secrets, this.models);
    this.views = new RoomViewService(now, {
      seatView: this.lobby.seatView.bind(this.lobby),
      setupErrors: this.lobby.setupErrors.bind(this.lobby),
      scheduleSave: this.persistence.scheduleSave.bind(this.persistence),
    });
    this.runtime = new RoomRuntimeService(now, o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), o.secrets, o.adapters ?? {}, {
      scheduleSave: this.persistence.scheduleSave.bind(this.persistence),
      writeAudit: this.persistence.writeAudit.bind(this.persistence),
      notify: this.views.notify.bind(this.views),
      publishThoughts: this.views.publishThoughts.bind(this.views),
      attachDeadline: this.views.attachDeadline.bind(this.views),
    });
    for (const rec of o.store.loadAll()) this.register(rec, true);
    this.runtime.startTimer(o.tickMs ?? 1000);
  }

  private register(rec: RoomRecord, restored = false): void {
    this.rooms.set(rec.id, rec);
    this.runtime.register(rec, restored);
  }

  resumeAll(): void {
    this.runtime.resumeAll();
  }

  dispose(): void {
    this.runtime.dispose();
    for (const rec of this.rooms.values()) {
      this.views.dispose(rec);
      this.persistence.flush(rec);
    }
  }

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
    this.register(rec);
    this.persistence.flush(rec);
    return { roomId: rec.id, hostToken: rec.hostToken };
  }

  /** 用同样的配置（含加密密钥）开一个新房间，凭证全部重新生成。 */
  cloneRoom(roomId: string, tok: string): CreateRoomResult {
    const src = this.lobby.host(this.rooms.get(roomId), tok);
    const created = this.createRoom();
    const rec = this.rooms.get(created.roomId)!;
    this.lobby.cloneSetup(src, rec);
    this.persistence.flush(rec);
    return created;
  }

  getSetup(roomId: string, tok: string): RoomSetupView {
    return this.views.setupView(this.lobby.host(this.rooms.get(roomId), tok));
  }

  updateSetup(roomId: string, tok: string, input: RoomSetupInput): RoomSetupView {
    const rec = this.lobby.host(this.rooms.get(roomId), tok);
    this.lobby.updateSetup(rec, input);
    this.runtime.changed(rec);
    return this.views.setupView(rec);
  }

  async testSeat(roomId: string, tok: string, seat: Seat): Promise<SeatTestResult> {
    return this.lobby.testSeat(this.lobby.host(this.rooms.get(roomId), tok), seat);
  }

  start(roomId: string, tok: string): RoomSetupView {
    const rec = this.lobby.host(this.rooms.get(roomId), tok);
    this.lobby.validateStart(rec);
    this.runtime.start(rec);
    return this.views.setupView(rec);
  }

  control(roomId: string, tok: string, action: ControlAction): RoomBrief {
    const rec = this.lobby.host(this.rooms.get(roomId), tok);
    this.runtime.control(rec, action);
    return this.views.brief(rec, { role: 'host' });
  }

  /** 座位凭证只能修改本人昵称和准备状态；运行中接入不改对局事实。 */
  participate(roomId: string, tok: string, input: ParticipantInput): ViewResponse {
    const { rec, viewer } = this.lobby.resolve(this.rooms.get(roomId), tok);
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
    return this.runtime.act(rec, viewer, body);
  }

  subscribe(roomId: string, tok: string, send: (n: number) => void): () => void {
    const { rec, viewer } = this.lobby.resolve(this.rooms.get(roomId), tok);
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
    this.runtime.tick();
  }

  async whenIdle(roomId: string): Promise<void> {
    return this.runtime.whenIdle(roomId);
  }
}
