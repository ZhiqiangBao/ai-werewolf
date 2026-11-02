import type { AuditEntry, AvatarStyleId, GameEvent, RuleSet, RuleValue, SeatConfigView, Thought } from '@werewolf/protocol';
import type { SeatThread } from './agent';
import { migrateThread } from './agent';
import type { ActionRecord, GameState } from '@werewolf/engine';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SeatRecord extends Omit<SeatConfigView, 'apiKeyMasked'> {
  /** 缺省为旧存档；只把旧的座位号昵称视为默认昵称。 */
  nameSource?: 'avatar' | 'custom';
  /** 加密后的密钥。 */
  apiKeyEnc: string | null;
  apiKeyMask: string | null;
}

export interface RoomRecord {
  id: string;
  avatarStyle?: AvatarStyleId;
  createdAt: number;
  hostToken: string;
  spectatorToken: string;
  seatTokens: string[];
  /** 旧房间缺省不强制候场确认；新房间为每个真人保存确认状态。 */
  participants?: Record<number, { joined: boolean; ready: boolean }>;
  status: 'setup' | 'running' | 'ended';
  paused: boolean;
  presetId: string;
  /** 房主改过的可编辑规则选项。 */
  ruleValues: Record<string, RuleValue>;
  humanTimeoutSec: number;
  aiPacingMs: number;
  seats: SeatRecord[];
  seed: string | null;
  rules: RuleSet | null;
  state: GameState | null;
  events: GameEvent[];
  actions: ActionRecord[];
  /** `${decisionId}:${seat}` → 已开始计时的行动截止时间（毫秒）。 */
  deadlines: Record<string, number>;
  /** 模型思考和工具外正文。只供显示，不进入对局事件。旧房间可能没有。 */
  thoughts?: Thought[];
  /** 每个座位自己的对话。旁听回应只写在这里。旧房间可能没有。 */
  threads?: SeatThread[];
  /** 已经向其他座位广播过的最后一条发言序号。 */
  heardSeq?: number;
}

/** 会话层的存储端口。引擎不接触存储。 */
export interface RoomStore {
  loadAll(): RoomRecord[];
  save(room: RoomRecord): void;
  appendAudit(roomId: string, entry: AuditEntry): void;
  readAudit(roomId: string): AuditEntry[];
}

export class MemoryStore implements RoomStore {
  readonly rooms = new Map<string, RoomRecord>();
  readonly audits = new Map<string, AuditEntry[]>();

  loadAll(): RoomRecord[] {
    return [...this.rooms.values()].map((r) => structuredClone(r));
  }

  save(room: RoomRecord): void {
    this.rooms.set(room.id, structuredClone(room));
  }

  appendAudit(roomId: string, entry: AuditEntry): void {
    const list = this.audits.get(roomId) ?? [];
    list.push(structuredClone(entry));
    this.audits.set(roomId, list);
  }

  readAudit(roomId: string): AuditEntry[] {
    return structuredClone(this.audits.get(roomId) ?? []);
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e;
    writeFileSync(file, text);
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件被占用时留下，下次保存会覆盖。
    }
  }
}

/** 本地文件存储：data/rooms/<id>.json 保存房间，<id>/s<座位>.json 保存该座位的消息，<id>.audit.jsonl 追加审计。 */
export class FileStore implements RoomStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'rooms');
    mkdirSync(this.dir, { recursive: true });
  }

  loadAll(): RoomRecord[] {
    const out: RoomRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as RoomRecord;
        const fromFiles = this.readSeatFiles(rec.id);
        if (fromFiles) rec.threads = fromFiles;
        out.push(rec);
      } catch (e) {
        console.warn(`跳过无法读取的房间文件 ${f}：${(e as Error).message}`);
      }
    }
    return out;
  }

  save(room: RoomRecord): void {
    if (!/^[A-Za-z0-9_-]+$/.test(room.id)) throw new Error('非法房间号');
    const { threads, ...rest } = room;
    writeAtomic(join(this.dir, `${room.id}.json`), JSON.stringify(rest));
    if (threads) this.writeSeatFiles(room.id, threads);
  }

  private readSeatFiles(roomId: string): RoomRecord['threads'] | undefined {
    const dir = join(this.dir, roomId);
    if (!existsSync(dir)) return undefined;
    const threads: NonNullable<RoomRecord['threads']> = [];
    for (const f of readdirSync(dir)) {
      if (!/^s\d+\.json$/.test(f)) continue;
      try {
        threads.push(migrateThread(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
      } catch (e) {
        console.warn(`跳过无法读取的座位文件 ${roomId}/${f}：${(e as Error).message}`);
      }
    }
    if (!threads.length) return undefined;
    threads.sort((a, b) => a.seat - b.seat);
    return threads;
  }

  private writeSeatFiles(roomId: string, threads: NonNullable<RoomRecord['threads']>): void {
    const dir = join(this.dir, roomId);
    mkdirSync(dir, { recursive: true });
    const keep = new Set<string>();
    for (const t of threads) {
      if (!Number.isInteger(t.seat) || t.seat < 1 || t.seat > 99) continue;
      const name = `s${t.seat}.json`;
      keep.add(name);
      writeAtomic(join(dir, name), JSON.stringify(t, null, 2));
    }
    for (const f of readdirSync(dir)) {
      if (/^s\d+\.json$/.test(f) && !keep.has(f)) {
        try {
          unlinkSync(join(dir, f));
        } catch {
          // 下次保存再删。
        }
      }
    }
  }

  appendAudit(roomId: string, entry: AuditEntry): void {
    appendFileSync(join(this.dir, `${roomId}.audit.jsonl`), `${JSON.stringify(entry)}\n`);
  }

  readAudit(roomId: string): AuditEntry[] {
    const file = join(this.dir, `${roomId}.audit.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry);
  }
}
