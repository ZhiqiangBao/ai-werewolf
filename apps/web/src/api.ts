import type {
  ActResult,
  AuditEntry,
  Catalog,
  ControlAction,
  ModelDraft,
  ModelPresetView,
  CreateRoomResult,
  RoomBrief,
  RoomSetupInput,
  RoomSetupView,
  SeatTestResult,
  ToolCall,
  ViewResponse,
  ParticipantInput,
  SeatActionInput,
  SpeechProvidersView,
} from '@werewolf/protocol';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('NETWORK', '连不上服务器，请确认服务已启动', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.code ?? 'HTTP', data.message ?? `请求失败（${res.status}）`, res.status);
  return data as T;
}

export const api = {
  speechProviders: (id: string, token: string) => request<SpeechProvidersView>('GET', `/rooms/${id}/speech-providers`, token),
  catalog: () => request<Catalog>('GET', '/catalog'),
  modelPresets: () => request<ModelPresetView[]>('GET', '/models'),
  addModel: (draft: ModelDraft) => request<ModelPresetView>('POST', '/models', undefined, draft),
  deleteModel: (id: string) => request<{ ok: true }>('DELETE', `/models/${encodeURIComponent(id)}`),
  createRoom: () => request<CreateRoomResult>('POST', '/rooms'),
  cloneRoom: (id: string, t: string) => request<CreateRoomResult>('POST', `/rooms/${id}/clone`, t),
  getSetup: (id: string, t: string) => request<RoomSetupView>('GET', `/rooms/${id}/setup`, t),
  putSetup: (id: string, t: string, input: RoomSetupInput) => request<RoomSetupView>('PUT', `/rooms/${id}/setup`, t, input),
  testSeat: (id: string, t: string, seat: number) => request<SeatTestResult>('POST', `/rooms/${id}/seats/${seat}/test`, t),
  start: (id: string, t: string) => request<RoomSetupView>('POST', `/rooms/${id}/start`, t),
  control: (id: string, t: string, action: ControlAction) => request<RoomBrief>('POST', `/rooms/${id}/control`, t, { action }),
  view: (id: string, t: string) => request<ViewResponse>('GET', `/rooms/${id}/view`, t),
  participate: (id: string, t: string, input: ParticipantInput) => request<ViewResponse>('POST', `/rooms/${id}/participate`, t, input),
  act: (id: string, t: string, input: SeatActionInput) =>
    request<ActResult>('POST', `/rooms/${id}/act`, t, input),
  audit: (id: string, t: string) => request<AuditEntry[]>('GET', `/rooms/${id}/audit`, t),
};

export const streamUrl = (id: string, t: string) => `/api/v1/rooms/${id}/stream?token=${encodeURIComponent(t)}`;
export const exportUrl = (id: string, t: string, kind: 'public' | 'god') =>
  `/api/v1/rooms/${id}/export?kind=${kind}&token=${encodeURIComponent(t)}`;

export interface SavedRoom {
  roomId: string;
  hostToken: string;
  createdAt: number;
}

const KEY = 'werewolf.rooms';

export function savedRooms(): SavedRoom[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedRoom[];
  } catch {
    return [];
  }
}

export function rememberRoom(r: CreateRoomResult): void {
  const list = [{ ...r, createdAt: Date.now() }, ...savedRooms().filter((x) => x.roomId !== r.roomId)].slice(0, 20);
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function forgetRoom(roomId: string): void {
  localStorage.setItem(KEY, JSON.stringify(savedRooms().filter((x) => x.roomId !== roomId)));
}
