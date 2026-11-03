import type { AuditEntry } from '@werewolf/protocol';
import type { RoomStore } from './store';
import type { RoomReadRecord } from './room-types';
import type { RoomObservability } from './observability/collector';

interface PersistenceState {
  saveTimer: ReturnType<typeof setTimeout> | null;
  auditId: number;
}

/** 保存与审计只读房间事实；不参与推进、计时或视图通知。 */
export class RoomPersistence {
  private readonly states = new Map<string, PersistenceState>();
  private readonly closed = new Set<string>();

  constructor(private readonly store: RoomStore, private readonly now: () => number, private readonly observability?: RoomObservability) {}

  private state(rec: RoomReadRecord): PersistenceState {
    let state = this.states.get(rec.id);
    if (!state) {
      state = { saveTimer: null, auditId: 0 };
      this.states.set(rec.id, state);
    }
    return state;
  }

  scheduleSave(rec: RoomReadRecord): void {
    if (this.closed.has(rec.id)) return;
    const state = this.state(rec);
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(() => this.flush(rec), 300);
  }

  flush(rec: RoomReadRecord): { roomId: string; saved: boolean; errorCode?: string } {
    const state = this.state(rec);
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = null;
    try {
      if (this.observability) this.observability.measure('store_save', rec, () => this.store.save(rec));
      else this.store.save(rec);
      return { roomId: rec.id, saved: true };
    } catch (e) {
      console.error(`房间 ${rec.id} 保存失败：`, (e as Error).message);
      return { roomId: rec.id, saved: false, errorCode: 'ROOM_SAVE_FAILED' };
    }
  }

  finish(rec: RoomReadRecord): { roomId: string; saved: boolean; errorCode?: string } {
    this.closed.add(rec.id);
    return this.flush(rec);
  }

  writeAudit(rec: RoomReadRecord, entry: Omit<AuditEntry, 'id' | 'at'>): void {
    if (this.closed.has(rec.id)) return;
    const state = this.state(rec);
    if (state.auditId === 0) state.auditId = this.audit(rec.id).length;
    const row = { id: ++state.auditId, at: this.now(), ...entry };
    if (this.observability) this.observability.measure('audit_append', rec, () => this.store.appendAudit(rec.id, row));
    else this.store.appendAudit(rec.id, row);
  }

  audit(roomId: string): AuditEntry[] {
    return this.observability ? this.observability.measure('audit_read', { id: roomId }, () => this.store.readAudit(roomId)) : this.store.readAudit(roomId);
  }
}
