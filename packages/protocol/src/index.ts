export type Seat = number;

export type GamePhase = 'setup' | 'night' | 'day' | 'end';

/** 'public' 表示全体（含出局者与观战）；数组是写入时冻结的座位号列表，空数组表示只有上帝视角可见。 */
export type Audience = 'public' | Seat[];

export interface GameEvent {
  seq: number;
  day: number;
  phase: GamePhase;
  type: string;
  audience: Audience;
  text: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export interface SeatParam {
  kind: 'seat';
  name: string;
  label: string;
  options: Seat[];
  nullable?: boolean;
  nullLabel?: string;
}

export interface SeatsParam {
  kind: 'seats';
  name: string;
  label: string;
  options: Seat[];
  min: number;
  max: number;
}

export interface BooleanParam {
  kind: 'boolean';
  name: string;
  label: string;
  trueLabel?: string;
  falseLabel?: string;
}

export interface TextParam {
  kind: 'text';
  name: string;
  label: string;
  minLength: number;
  maxLength: number;
  placeholder?: string;
}

export interface ChoiceParam {
  kind: 'choice';
  name: string;
  label: string;
  options: { value: string; label: string; hint?: string }[];
}

export type ParamSpec = SeatParam | SeatsParam | BooleanParam | TextParam | ChoiceParam;

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  params: ParamSpec[];
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export type JsonSchema = Record<string, unknown>;

export function paramToJsonSchema(p: ParamSpec): JsonSchema {
  switch (p.kind) {
    case 'seat': {
      const values: (number | null)[] = [...p.options];
      if (p.nullable) values.push(null);
      const desc = p.nullable ? `${p.label}。传 null 表示「${p.nullLabel ?? '不选'}」` : p.label;
      return { type: p.nullable ? ['integer', 'null'] : 'integer', enum: values, description: desc };
    }
    case 'seats':
      return {
        type: 'array',
        items: { type: 'integer', enum: p.options },
        minItems: p.min,
        maxItems: p.max,
        uniqueItems: true,
        description: p.label,
      };
    case 'boolean':
      return { type: 'boolean', description: p.label };
    case 'text':
      return { type: 'string', minLength: p.minLength, maxLength: p.maxLength, description: p.label };
    case 'choice':
      return {
        type: 'string',
        enum: p.options.map((o) => o.value),
        description: `${p.label}：${p.options.map((o) => `${o.value}=${o.label}`).join('，')}`,
      };
  }
}

export function toolToJsonSchema(tool: ToolSpec): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of tool.params) {
    properties[p.name] = paramToJsonSchema(p);
    required.push(p.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// 规则对象
// ---------------------------------------------------------------------------

export type RuleValue = string | number | boolean;

export interface RuleSet {
  presetId: string;
  presetName: string;
  playerCount: number;
  /** 身份多重集，长度等于人数。 */
  roles: string[];
  /** 由身份模块声明的夜间阶段顺序推导，只读。 */
  nightOrder: string[];
  /** 扁平键，例如 `sheriff.enabled`、`witch.selfSave`。核心与各身份模块各自声明自己的键。 */
  values: Record<string, RuleValue>;
}

export interface RuleOptionInfo {
  key: string;
  group: string;
  label: string;
  type: 'boolean' | 'choice' | 'number';
  choices?: { value: RuleValue; label: string }[];
  default: RuleValue;
  /** 开局页可改；否则只写入规则卡。 */
  editable: boolean;
  hint?: string;
  /** 由某个身份模块声明的选项：本局没有该身份时不显示。 */
  owner?: string;
}

export interface RoleInfo {
  id: string;
  name: string;
  faction: string;
  factionName: string;
  category: string;
  categoryName: string;
  maxPerGame: number;
  summary: string;
}

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  playerCount: number;
  roles: string[];
  overrides: Record<string, RuleValue>;
  tag?: string;
}

export interface Catalog {
  presets: PresetInfo[];
  roles: RoleInfo[];
  options: RuleOptionInfo[];
  styles: { id: string; name: string; text: string }[];
}

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

export interface SeatInfo {
  seat: Seat;
  name: string;
  alive: boolean;
  sheriff: boolean;
  /** 已经公开的身份（开枪、自爆、翻牌、终局复盘）。 */
  revealedRole?: string;
  revealedRoleName?: string;
  /** 当前正在公开行动（发言等）的座位。 */
  active?: boolean;
}

export interface MeInfo {
  seat: Seat;
  name: string;
  role: string;
  roleName: string;
  faction: string;
  factionName: string;
  alive: boolean;
  teammates?: Seat[];
  appendix: string;
}

export interface PendingTask {
  decisionId: string;
  title: string;
  prompt: string;
  tools: ToolSpec[];
  simultaneous: boolean;
  submitted: boolean;
  submittedText?: string;
  /** 由会话层填写的截止时间（毫秒时间戳）。 */
  deadline?: number;
}

export interface GameResult {
  winner: string;
  winnerName: string;
  reason: string;
  /** 为 false 时终局不公开身份。正常结束缺省公开。 */
  reveal?: boolean;
}

export type Viewer = { kind: 'seat'; seat: Seat } | { kind: 'spectator' } | { kind: 'god' };

/** 模型这一步的思考和工具外正文。只给界面对应视角看，不进入任何座位的提示词。 */
export interface Thought {
  seat: Seat;
  decisionId: string;
  at: number;
  thinking: string;
  reply: string;
  /** 模型还在往下写。 */
  live: boolean;
}

export interface Projection {
  viewer: Viewer;
  gameId: string;
  version: number;
  status: 'running' | 'ended';
  day: number;
  phase: GamePhase;
  stage: string;
  presetName: string;
  ruleCard: string;
  seats: SeatInfo[];
  me?: MeInfo;
  events: GameEvent[];
  task: PendingTask | null;
  /** 不阻塞流程、随时可用的工具（例如发言阶段的自爆）。 */
  interrupts: ToolSpec[];
  result?: GameResult;
  /** 上帝看全部，座位只看自己。旁观没有这个字段。 */
  thoughts?: Thought[];
}

export interface GodSeatInfo {
  seat: Seat;
  role: string;
  roleName: string;
  factionName: string;
  alive: boolean;
}

export interface GodPending {
  decisionId: string;
  title: string;
  actors: { seat: Seat; submitted: boolean; tools: string[] }[];
}

export interface GodProjection extends Projection {
  god: {
    seed: string;
    roles: GodSeatInfo[];
    pending: GodPending | null;
  };
}

// ---------------------------------------------------------------------------
// 会话接口
// ---------------------------------------------------------------------------

export type Controller = 'human' | 'ai';
export type AdapterKind = 'mock' | 'openai_compatible';
export type ToolMode = 'tools' | 'json';

export interface SeatConfigView {
  seat: Seat;
  name: string;
  controller: Controller;
  adapter: AdapterKind;
  baseUrl: string;
  model: string;
  apiKeyMasked: string | null;
  temperature: number;
  style: string;
  persona: string;
  toolMode: ToolMode;
  timeoutSec: number;
  /** 选用的模型名单条目。旧房间可能还没有。 */
  modelId?: string | null;
}

/** 只需要带上要修改的字段。 */
export interface SeatConfigInput extends Partial<Omit<SeatConfigView, 'seat' | 'apiKeyMasked'>> {
  seat: Seat;
  /** undefined 表示保持原值，null 表示清除。 */
  apiKey?: string | null;
  /**
   * 从模型名单里选用。服务端据此写入地址、模型名和密钥，响应里不会出现密钥明文。
   * 若同时提交了 apiKey，密钥以 apiKey 为准。
   */
  presetId?: string;
}

/** 添加一个模型。名称同时作为接口里的模型名。 */
export interface ModelDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** 模型名单里的一条。没有密钥明文。 */
export interface ModelPresetView {
  id: string;
  label: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  /** settings：来自 Qwen Code 的 settings.json。added：在页面里添加的。 */
  source: 'settings' | 'added';
}

export interface RoomLinks {
  host: string;
  spectator: string;
  seats: { seat: Seat; token: string }[];
}

export interface RoomSetupView {
  roomId: string;
  status: 'setup' | 'running' | 'ended';
  paused: boolean;
  presetId: string;
  ruleValues: Record<string, RuleValue>;
  humanTimeoutSec: number;
  aiPacingMs: number;
  seats: SeatConfigView[];
  tokens: RoomLinks;
  ruleCardPreview: string;
  validationErrors: string[];
}

export interface RoomSetupInput {
  presetId?: string;
  ruleValues?: Record<string, RuleValue>;
  humanTimeoutSec?: number;
  aiPacingMs?: number;
  seats?: SeatConfigInput[];
}

export interface ApiError {
  code: string;
  message: string;
}

export interface CreateRoomResult {
  roomId: string;
  hostToken: string;
}

export type ViewerRole = 'host' | 'seat' | 'spectator';

/** 房间层面的公开信息：谁是真人、谁是模型，以及暂停状态。不含任何身份和配置细节。 */
export interface RoomBrief {
  roomId: string;
  status: 'setup' | 'running' | 'ended';
  paused: boolean;
  viewer: ViewerRole;
  seat?: Seat;
  presetName: string;
  seats: { seat: Seat; name: string; controller: Controller }[];
}

export interface ViewResponse {
  room: RoomBrief;
  /** 未开局时为 null。 */
  projection: Projection | GodProjection | null;
}

export interface SeatTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export type ControlAction = 'pause' | 'resume' | 'step' | 'end';

export interface ActResult {
  ok: boolean;
  error?: ApiError;
}

export interface AuditEntry {
  id: number;
  at: number;
  seat: Seat;
  model: string;
  decisionId: string;
  projectionVersion: number;
  ok: boolean;
  messages?: unknown;
  response?: unknown;
  toolCall?: ToolCall;
  error?: string;
  latencyMs?: number;
}
