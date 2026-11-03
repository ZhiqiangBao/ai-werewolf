import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { ObservationEvent } from '@werewolf/protocol';
import { FileStore, MemoryStore, RoomManager, SecretBox, type RoomRecord } from '../src/index';
import { RoomPersistence } from '../src/room-persistence';
import { RoomObservability } from '../src/observability/collector';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(): RoomRecord {
  const store = new MemoryStore(), manager = new RoomManager({ store, secrets: SecretBox.ephemeral(), tickMs: 0 });
  manager.createRoom(); manager.dispose(); return store.loadAll()[0];
}

it('attributes delayed saves and audit reads/appends to their own monotonic local spans', () => {
  let monotonic = 0, wall = 1000;
  const events: ObservationEvent[] = [], record = fixture();
  const observation = new RoomObservability({ clock: { monotonicMs: () => monotonic, wallTimeMs: () => wall }, sink: { emit: (e) => events.push(e) } });
  const store = new MemoryStore();
  const save = store.save.bind(store), append = store.appendAudit.bind(store), read = store.readAudit.bind(store);
  store.save = (rec) => { monotonic += 25; wall -= 1000; save(rec); };
  store.appendAudit = (id, row) => { monotonic += 15; wall += 5000; append(id, row); };
  store.readAudit = (id) => { monotonic += 5; return read(id); };
  const persistence = new RoomPersistence(store, () => wall, observation);
  persistence.flush(record);
  persistence.writeAudit(record, { seat: 1, model: 'mock', decisionId: 'synthetic', projectionVersion: 1, ok: true });
  const durations = events.filter((e) => e.kind === 'local_span' && e.phase === 'end').map((e) => [e.operation, e.metrics?.persistenceMs?.valueMs]);
  expect(durations).toEqual([['store_save',25],['audit_read',5],['audit_append',15]]);
  expect(store.readAudit(record.id)[0].at).toBe(0);
  observation.finish();
  expect(observation.stats.activeSpans).toBe(0);
});

it('measures the existing temporary FileStore path and preserves audit numbering and room contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'werewolf-observation-file-')); directories.push(dir);
  const events: ObservationEvent[] = [], record = fixture(), store = new FileStore(dir);
  const observation = new RoomObservability({ mappingPath: join(dir, 'identity.json'), sink: { emit: (event) => events.push(event) } });
  const persistence = new RoomPersistence(store, Date.now, observation);
  persistence.flush(record);
  persistence.writeAudit(record, { seat: 1, model: 'mock', decisionId: 'synthetic', projectionVersion: 1, ok: true });
  const recovered = observation.measure('store_load', undefined, () => store.loadAll());
  expect(recovered[0]).toEqual(record);
  expect(persistence.audit(record.id).map((r) => r.id)).toEqual([1]);
  observation.finish();
  const spans = events.filter((e) => e.kind === 'local_span' && e.phase === 'end');
  expect(new Set(spans.map((s) => s.operation))).toEqual(new Set(['store_save','audit_read','audit_append','store_load']));
  expect(spans.every((s) => s.outcome === 'success' && typeof s.metrics?.persistenceMs?.valueMs === 'number')).toBe(true);
});
