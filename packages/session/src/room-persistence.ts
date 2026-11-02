import type { AuditEntry } from '@werewolf/protocol';
import type { RoomRecord, RoomStore } from './store';

interface PersistenceState {
  saveTimer: ReturnType<typeof setTimeout> | null;
  auditId: number;
}

/** 保存与审计只读房间事实；不参与推进、计时或视图通知。 */
export class RoomPersistence {
  private readonly states = new Map<string, PersistenceState>();

  constructor(private readonly store: RoomStore, private readonly now: () => number) {}

  private state(rec: RoomRecord): PersistenceState {
    let state = this.states.get(rec.id);
    if (!state) {
      state = { saveTimer: null, auditId: 0 };
      this.states.set(rec.id, state);
    }
    return state;
  }

  scheduleSave(rec: RoomRecord): void {
    const state = this.state(rec);
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(() => this.flush(rec), 300);
  }

  flush(rec: RoomRecord): void {
    const state = this.state(rec);
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = null;
    try {
      this.store.save(rec);
    } catch (e) {
      console.error(`房间 ${rec.id} 保存失败：`, (e as Error).message);
    }
  }

  writeAudit(rec: RoomRecord, entry: Omit<AuditEntry, 'id' | 'at'>): void {
    const state = this.state(rec);
    if (state.auditId === 0) state.auditId = this.store.readAudit(rec.id).length;
    this.store.appendAudit(rec.id, { id: ++state.auditId, at: this.now(), ...entry });
  }

  audit(roomId: string): AuditEntry[] {
    return this.store.readAudit(roomId);
  }
}
