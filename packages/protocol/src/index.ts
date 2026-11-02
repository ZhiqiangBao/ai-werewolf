export type Seat = number;
export { AVATAR_STYLES, isAvatarStyleId, avatarDefaultName } from './avatars';
export type { AvatarStyleId } from './avatars';
import type { AvatarStyleId } from './avatars';
export type { SpeechProviderView, SpeechProvidersView, SpeechConnectionKind, SpeechConnectionDraft, SpeechConnectionView, SpeechSettingsView } from './speech';
export { SPEECH_CONNECTION_TEMPLATES } from './speech';
export { expandActionTools, canonicalAction, simulationTools, exposeAction, actionMenu } from './action-tools';
export { API_PROTOCOLS, API_PROTOCOL_LABELS, apiProtocol, apiBase, apiUrl, isDashscopeEndpoint } from './api';
export type { ApiProtocol, TokenUsage } from './api';
import type { ApiProtocol, TokenUsage } from './api';
export { eventPurpose, gameRecordEvents, buildVideoScript, recordedBadgeOutcome } from './recording';
export type { VideoScriptEntry } from './recording';
export { THINKING_MODES, thinkingOptions, thinkingParameters, defaultThinkingMode } from './thinking';
export type { ThinkingMode, ThinkingOption } from './thinking';
import type { ThinkingMode } from './thinking';

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
  /** 不写就没有上限。上限会进工具参数，模型会去数字数。 */
  maxLength?: number;
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
  /** 引擎内部的确定性动作映射，不进入模型请求的 Schema。旧存档没有此字段。 */
  operation?: { tool: string; constants: Record<string, unknown>; parameters: Record<string, string> };
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** 真人和模型最终都提交同一种工具调用；网页必须绑定决策窗口。 */
export interface SeatActionInput extends ToolCall { decisionId: string }

export type JsonSchema = Record<string, unknown>;

export function paramToJsonSchema(p: ParamSpec): JsonSchema {
  switch (p.kind) {
    case 'seat': {
      const values: (number | null)[] = [...p.options];
      if (p.nullable) values.push(null);
      const label = `${p.label}。填写玩家的真实座位号（整数），不是候选列表下标；提交值须与最终选择一致`;
      const desc = p.nullable ? `${label}。传 null 表示「${p.nullLabel ?? '不选'}」` : label;
      return { type: p.nullable ? ['integer', 'null'] : 'integer', enum: values, description: desc };
    }
    case 'seats':
      return {
        type: 'array',
        items: { type: 'integer', enum: p.options },
        minItems: p.min,
        maxItems: p.max,
        uniqueItems: true,
        description: `${p.label}。填写互不重复的真实整数座位号列表，不是列表下标；数量为 ${p.min}–${p.max} 个`,
      };
    case 'boolean':
      return { type: 'boolean', description: `${p.label}。true=${p.trueLabel ?? '是'}；false=${p.falseLabel ?? '否'}。填写布尔值，不要填写字符串` };
    case 'text': {
      const schema: JsonSchema = { type: 'string', minLength: p.minLength, description: p.label };
      if (p.maxLength !== undefined) schema.maxLength = p.maxLength;
      return schema;
    }
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
  /** 缺省为历史 v1；新开局使用显式单动作工具 v2。随规则存档，便于精确恢复与重放。 */
  toolsetVersion?: 1 | 2;
  /** 缺省／1 保留历史先公告再续投；2 为警上优先；新局 3 另增加普通竞选的发言后退水与最终确认。 */
  electionVersion?: 1 | 2 | 3;
  presetId: string;
  /** 新版型的项目规则版本；旧房间缺省不补写历史。 */
  presetVersion?: number;
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
  version?: number;
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

/** 只有实际获知该信息的座位收到；查验表现不等于引擎真实身份。 */
export type IdentityKnowledge =
  | { seat: Seat; kind: 'alignment'; alignment: 'good' | 'wolf'; source: 'teammate' | 'inspection' }
  | { seat: Seat; kind: 'role'; role: string; roleName: string; source: 'teammate' | 'inspection' };

export interface MeInfo {
  seat: Seat;
  name: string;
  role: string;
  roleName: string;
  faction: string;
  factionName: string;
  alive: boolean;
  teammates?: Seat[];
  knownIdentities?: IdentityKnowledge[];
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
  /** 插入行动所属的窗口，避免刷新前的自爆等误落在下一段发言。 */
  actionWindowId?: string;
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
  /** 旧配置缺省为 Chat Completions。远程调用方式与协议分别保存。 */
  apiProtocol?: ApiProtocol;
  baseUrl: string;
  model: string;
  apiKeyMasked: string | null;
  temperature: number;
  style: string;
  persona: string;
  toolMode: ToolMode;
  timeoutSec: number;
  maxOutputTokens?: number;
  /** 统一的思考档位；接口不支持的档位不能选用。 */
  thinkingMode?: ThinkingMode;
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
  apiProtocol?: ApiProtocol;
}

/** 模型名单里的一条。没有密钥明文。 */
export interface ModelPresetView {
  id: string;
  label: string;
  model: string;
  baseUrl: string;
  apiProtocol?: ApiProtocol;
  hasKey: boolean;
  /** imported：已复制到项目的旧模型；added：网页添加。settings 仅兼容旧响应。 */
  source: 'settings' | 'imported' | 'added';
}

export interface RoomLinks {
  host: string;
  spectator: string;
  seats: { seat: Seat; token: string }[];
}

/** 仅房主可读取的当前服务分享地址，不写入对局历史或座位投影。 */
export interface InviteNetworkView {
  loopbackOnly: boolean;
  addresses: { label: string; origin: string }[];
}

export interface RoomSetupView {
  roomId: string;
  avatarStyle?: AvatarStyleId;
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
  participants: HumanParticipant[];
}

export interface HumanParticipant { seat: Seat; joined: boolean; ready: boolean; online: boolean }
export interface ParticipantInput { name?: string; ready?: boolean }

export interface RoomSetupInput {
  avatarStyle?: AvatarStyleId;
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
  avatarStyle?: AvatarStyleId;
  status: 'setup' | 'running' | 'ended';
  paused: boolean;
  viewer: ViewerRole;
  seat?: Seat;
  presetName: string;
  seats: { seat: Seat; name: string; controller: Controller }[];
  participants?: HumanParticipant[];
  /** 候场时也能阅读本局规则，不包含发牌与私密配置。 */
  ruleCard?: string;
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

/** 发给提供方的工具配置快照；只保存白名单字段，不保存认证头或密钥。 */
export interface ModelRequestInfo {
  apiProtocol: ApiProtocol;
  tools: unknown[];
  toolChoice?: unknown;
  /** JSON 兼容模式没有原生工具，其实际格式说明保存于此。 */
  toolInstruction?: string;
}

export interface AuditEntry {
  apiProtocol?: ApiProtocol;
  usage?: TokenUsage;
  id: number;
  at: number;
  seat: Seat;
  model: string;
  decisionId: string;
  projectionVersion: number;
  ok: boolean;
  messages?: unknown;
  request?: ModelRequestInfo;
  response?: unknown;
  toolCall?: ToolCall;
  error?: string;
  latencyMs?: number;
  purpose?: 'listen' | 'action';
  attempt?: number;
  deadline?: number;
  failureKind?: 'timeout' | 'cancelled' | 'http' | 'network' | 'invalid_tool';
  thinkingMode?: ThinkingMode;
  firstDeltaMs?: number;
  thinkingChars?: number;
  replyChars?: number;
}
