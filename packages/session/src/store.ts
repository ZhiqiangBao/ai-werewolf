import type { AuditEntry, GameEvent, RuleSet, RuleValue, SeatConfigView, Thought } from '@werewolf/protocol';
import type { ActionRecord, GameState } from '@werewolf/engine';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SeatRecord extends Omit<SeatConfigView, 'apiKeyMasked'> {
  /** 加密后的密钥。 */
  apiKeyEnc: string | null;
  apiKeyMask: string | null;
}

export interface RoomRecord {
  id: string;
  createdAt: number;
  hostToken: string;
  spectatorToken: string;
  seatTokens: string[];
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
  /** `${decisionId}:${seat}` → 真人行动截止时间（毫秒）。 */
  deadlines: Record<string, number>;
  /** 模型思考和工具外正文。只供显示，不进入对局事件。旧房间可能没有。 */
  thoughts?: Thought[];
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

/** 本地文件存储：data/rooms/<id>.json 保存房间，<id>.audit.jsonl 追加审计。一条命令启动，不需要单独安装数据库。 */
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
        out.push(JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as RoomRecord);
      } catch (e) {
        console.warn(`跳过无法读取的房间文件 ${f}：${(e as Error).message}`);
      }
    }
    return out;
  }

  save(room: RoomRecord): void {
    const file = join(this.dir, `${room.id}.json`);
    const tmp = `${file}.tmp`;
    const text = JSON.stringify(room);
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
