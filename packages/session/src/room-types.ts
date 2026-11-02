import type { AdapterKind, Seat } from '@werewolf/protocol';
import type { Adapter } from '@werewolf/llm';
import type { SecretBox } from './secret';
import type { RoomRecord, RoomStore } from './store';

export type Viewer = { role: 'host' } | { role: 'seat'; seat: Seat } | { role: 'spectator' };

export interface Subscriber {
  viewer: Viewer;
  send: (n: number) => void;
  sig: string;
  count: number;
}

/** 仅运行服务拥有推进、取消、代数和单步预算。rec 指向唯一房间记录。 */
export interface RoomRuntimeState {
  readonly rec: RoomRecord;
  running: Promise<void> | null;
  again: boolean;
  stepBudget: number;
  /** 暂停时冻结推进间隔；恢复时将截止时刻向后平移。 */
  gatePausedAt: number | undefined;
  /** 终结或暂停时加一；旧请求和推进循环不能再提交。 */
  gen: number;
  inflight: Map<string, AbortController>;
}

/** 连接与通知计数不持久化；重启后在线状态从空连接集合推导。 */
export interface RoomViewState {
  subscribers: Set<Subscriber>;
  thoughtTimer: ReturnType<typeof setTimeout> | null;
  thoughtNotifiedAt: number;
}

export interface ManagerOptions {
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
