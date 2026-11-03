import type { AdapterKind, AuditEntry, ObservabilityOptions, Seat } from '@werewolf/protocol';
import type { Adapter } from '@werewolf/llm';
import type { SecretBox } from './secret';
import type { RoomRecord, RoomStore } from './store';

export type Viewer = { role: 'host' } | { role: 'seat'; seat: Seat } | { role: 'spectator' };

/** 新增存档字段时必须明确唯一写入方；建房时的初值由候场工厂一次构造。 */
export const roomFieldOwners = {
  id: 'identity',
  createdAt: 'identity',
  locale: 'lobby',
  avatarStyle: 'lobby',
  hostToken: 'lobby',
  spectatorToken: 'lobby',
  seatTokens: 'lobby',
  participants: 'lobby',
  presetId: 'lobby',
  ruleValues: 'lobby',
  timing: 'lobby',
  humanTimeoutSec: 'lobby',
  aiPacingMs: 'lobby',
  seats: 'lobby',
  status: 'runtime',
  paused: 'runtime',
  seed: 'runtime',
  rules: 'runtime',
  state: 'runtime',
  events: 'runtime',
  actions: 'runtime',
  deadlines: 'runtime',
  actionAvailableAt: 'runtime',
  actionGateRemainingMs: 'runtime',
  deadlineRemainingMs: 'runtime',
  thoughts: 'runtime',
  threads: 'runtime',
  heardSeq: 'runtime',
} as const satisfies Record<keyof RoomRecord, 'identity' | 'lobby' | 'runtime'>;

export type OwnedRoomFields<Owner extends 'lobby' | 'runtime'> = {
  [Field in keyof typeof roomFieldOwners]: typeof roomFieldOwners[Field] extends Owner ? Field : never
}[keyof typeof roomFieldOwners];

/** 服务只能替换自己负责的字段；读取其他字段时仍引用同一份记录。 */
type OwnedRoomRecord<Owner extends 'lobby' | 'runtime'> =
  Pick<RoomRecord, OwnedRoomFields<Owner>> & Readonly<Omit<RoomRecord, OwnedRoomFields<Owner>>>;

export type RoomLobbyRecord = OwnedRoomRecord<'lobby'>;
export type RoomRuntimeRecord = OwnedRoomRecord<'runtime'>;
export type RoomReadRecord = Readonly<RoomRecord>;

export interface Subscriber {
  viewer: Viewer;
  send: (n: number) => void;
  sig: string;
  count: number;
}

/** 仅运行服务拥有推进、取消、代数和单步预算。rec 指向唯一房间记录。 */
export interface RoomRuntimeState {
  readonly rec: RoomRuntimeRecord;
  running: Promise<void> | null;
  again: boolean;
  stepBudget: number;
  /** 暂停时冻结推进间隔；恢复时将截止时刻向后平移。 */
  gatePausedAt: number | undefined;
  /** 终结或暂停时加一；旧请求和推进循环不能再提交。 */
  gen: number;
  inflight: Map<string, AbortController>;
  disposeController: AbortController;
  externalWaits: number;
  pendingCalls: Map<AbortController, { entry: Omit<AuditEntry, 'id' | 'at' | 'latencyMs'>; startedAt: number }>;
}

/** 连接与通知计数不持久化；重启后在线状态从空连接集合推导。 */
export interface RoomViewState {
  subscribers: Set<Subscriber>;
  thoughtTimer: ReturnType<typeof setTimeout> | null;
  thoughtNotifiedAt: number;
}

export interface ManagerOptions {
  /** 默认关闭的独立诊断旁路，不参与对局恢复与调度。 */
  observability?: ObservabilityOptions;
  store: RoomStore;
  secrets: SecretBox;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 测试时替换适配器。 */
  adapters?: Partial<Record<AdapterKind, Adapter>>;
  /** 行动超时检查间隔，0 表示不启动定时器。 */
  tickMs?: number;
  /** 页面里添加的模型。不传则只留在内存里。 */
  modelsPath?: string;
}
