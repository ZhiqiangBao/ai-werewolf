/** Offline experiment only. A single writer owns this directory; never use for production rooms. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoomRecord } from '../src/store';
import type { TranscriptMessage } from '@werewolf/llm';

export type Patch = {
  set?: Partial<RoomRecord>;
  unset?: (keyof RoomRecord)[];
  events?: RoomRecord['events'];
  actions?: RoomRecord['actions'];
  messages?: { seat: number; values: TranscriptMessage[] };
};
type Entry = { schemaVersion: 1; roomId: string; seq: number; previous: string | null; id: string; patch: Patch };
type Envelope<T> = { value: T; hash: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pack = <T>(value: T): Envelope<T> => ({ value, hash: hash(value) });
function unpack<T>(text: string): T {
  const item = JSON.parse(text) as Envelope<T>;
  if (!item || typeof item !== 'object' || item.hash !== hash(item.value)) throw new Error('checksum mismatch');
  return item.value;
}
function apply(room: RoomRecord, patch: Patch): void {
  Object.assign(room, patch.set);
  for (const key of patch.unset ?? []) delete (room as unknown as Record<string, unknown>)[key];
  if (patch.events) room.events.push(...patch.events);
  if (patch.actions) room.actions.push(...patch.actions);
  if (patch.messages) {
    const thread = room.threads?.find((t) => t.seat === patch.messages!.seat);
    if (!thread) throw new Error('missing seat thread');
    thread.messages.push(...patch.messages.values);
  }
}
function durableWrite(path: string, data: string, flag: string): void {
  const fd = openSync(path, flag);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}

export class EventStorePrototype {
  private room!: RoomRecord;
  private seq = 0;
  private ids = new Map<string, string>();
  private poisoned = false;
  private lastHash: string | null = null;
  private readonly log: string;
  private readonly snapshot: string;
  constructor(private readonly dir: string, initial?: RoomRecord, private readonly onDurable?: () => void) {
    this.log = join(dir, 'events.jsonl'); this.snapshot = join(dir, 'snapshot.json');
    if (!existsSync(this.snapshot)) {
      if (!initial || existsSync(this.log)) throw new Error('missing initial snapshot');
      this.room = structuredClone(initial);
      this.checkpoint();
      durableWrite(this.log, '', 'wx');
    }
    this.restore();
  }
  private restore(): void {
    const snap = unpack<{ schemaVersion: 1; roomId: string; seq: number; lastHash: string | null; room: RoomRecord }>(readFileSync(this.snapshot, 'utf8'));
    if (snap.schemaVersion !== 1 || snap.roomId !== snap.room.id || !Number.isSafeInteger(snap.seq) || snap.seq < 0) throw new Error('invalid snapshot');
    this.room = snap.room;
    const bytes = readFileSync(this.log);
    const end = bytes.lastIndexOf(10) + 1;
    // Only a partial final frame can be discarded. A complete malformed frame is corruption.
    if (end !== bytes.length) truncateSync(this.log, end);
    let seq = 0; let previous: string | null = null;
    const lines = bytes.subarray(0, end).toString('utf8').split('\n'); lines.pop();
    for (const line of lines) {
      const entry = unpack<Entry>(line);
      if (entry.schemaVersion !== 1 || entry.roomId !== snap.roomId || entry.previous !== previous || entry.seq !== ++seq || typeof entry.id !== 'string' || !entry.id || this.ids.has(entry.id)) throw new Error('invalid journal sequence, room, or id');
      previous = hash(entry);
      if (seq === snap.seq && previous !== snap.lastHash) throw new Error('snapshot journal mismatch');
      this.ids.set(entry.id, hash(entry.patch));
      if (entry.seq > snap.seq) apply(this.room, entry.patch);
    }
    if (seq < snap.seq || (snap.seq === 0 && snap.lastHash !== null)) throw new Error('snapshot beyond journal');
    this.seq = seq; this.lastHash = previous;
  }
  commit(id: string, patch: Patch): 'committed' | 'duplicate' {
    if (this.poisoned) throw new Error('reopen after an uncertain write');
    if (!id) throw new Error('empty id');
    const ownedPatch = structuredClone(patch);
    if ((ownedPatch.set?.id !== undefined && ownedPatch.set.id !== this.room.id) || ownedPatch.unset?.includes('id')) throw new Error('room identity cannot change');
    const prior = this.ids.get(id);
    if (prior) {
      if (prior !== hash(ownedPatch)) throw new Error('id reused with different patch');
      return 'duplicate';
    }
    // Validate on a copy before writing: an invalid operation must never become committed.
    const next = structuredClone(this.room); apply(next, ownedPatch);
    const entry: Entry = { schemaVersion: 1, roomId: this.room.id, seq: this.seq + 1, previous: this.lastHash, id, patch: ownedPatch };
    try { durableWrite(this.log, JSON.stringify(pack(entry)) + '\n', 'a'); this.onDurable?.(); }
    catch (error) { this.poisoned = true; throw error; }
    this.room = next; this.seq++; this.lastHash = hash(entry); this.ids.set(id, hash(ownedPatch));
    return 'committed';
  }
  checkpoint(): void {
    const tmp = this.snapshot + '.tmp';
    durableWrite(tmp, JSON.stringify(pack({ schemaVersion: 1, roomId: this.room.id, seq: this.seq, lastHash: this.lastHash, room: this.room })), 'w');
    renameSync(tmp, this.snapshot);
  }
  value(): RoomRecord { return structuredClone(this.room); }
}
