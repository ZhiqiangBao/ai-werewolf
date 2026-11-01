import type {
  GamePhase,
  GameResult,
  IdentityKnowledge,
  RuleOptionInfo,
  RuleSet,
  Seat,
  ToolCall,
  ToolSpec,
} from '@werewolf/protocol';
import type { Ctx } from './context';

export interface PlayerState {
  seat: Seat;
  name: string;
  role: string;
  alive: boolean;
  /** 身份是否已经公开（开枪、自爆、翻牌）。 */
  revealed: boolean;
  /** 技能公开的表面身份；真实 role 始终用于阵营与胜负。 */
  revealedAs?: string;
  /** 身份模块自己的私有状态，例如女巫药瓶、守卫上一夜守护对象。 */
  data: Record<string, any>;
}

export type DeathVia = 'night' | 'exile' | 'shot' | 'explode' | (string & {});

export interface DeathRecord {
  seat: Seat;
  day: number;
  via: DeathVia;
  /** 死因标签：wolf、poison、guard_and_save、exile、shot、explode…… */
  causes: string[];
  by?: Seat;
  /** 开枪致死时，射手本人的出局方式，决定被带走的人有没有遗言。 */
  shooterVia?: DeathVia;
  batch: number;
  lastWords: boolean;
  hooked: boolean;
}

export interface Attack {
  target: Seat;
  kind: string;
  by?: Seat[];
}

export interface Protection {
  target: Seat;
  kind: string;
  blocks: string[];
  by?: Seat;
}

export interface NightState {
  n: number;
  attacks: Attack[];
  protections: Protection[];
  /** 狼人合并后的原始刀口。undefined 表示本夜狼人没有行动，null 表示空刀。 */
  knife?: Seat | null;
  lines: string[];
}

export interface PendingDeaths {
  night: number;
  deaths: { seat: Seat; causes: string[] }[];
  knife: Seat | null;
}

export interface Step {
  type: string;
  /** 自爆发生时从议程中移除。 */
  cancelOnExplode?: boolean;
  [key: string]: unknown;
}

export interface Decision {
  id: string;
  /** 问话产生时的事件边界。座位收到此前全部可见消息后才能开始行动。旧存档可能没有。 */
  openedAtSeq?: number;
  step: Step;
  actors: Seat[];
  tools: Record<number, ToolSpec[]>;
  prompts: Record<number, string>;
  title: string;
  publicStage: string;
  simultaneous: boolean;
  /** 公开可见的当前行动者（例如发言者）。夜间行动与秘密行动不设置。 */
  publicActor?: Seat;
  /** 发言类决策进行中，允许插入自爆。 */
  speechWindow: boolean;
  submissions: Record<number, ToolCall>;
  acks: Record<number, string>;
}

export interface ElectionState {
  status: 'pending' | 'running' | 'done';
  candidates: Seat[];
  withdrawn: Seat[];
  postponed: boolean;
  postponedCandidates: Seat[] | null;
  /** 新延期规则保留投票轮次；原 candidates/withdrawn 保留首次报名与退水资格。旧存档可缺省。 */
  postponedVote?: { round: 1 | 2; candidates: Seat[] };
  explosions: number;
}

export type Direction = 'clockwise' | 'counterclockwise';

export interface DayState {
  direction: Direction | null;
  firstSpeaker: Seat | null;
  anchor: Seat | null;
  electionToday: boolean;
}

export interface NightLog {
  n: number;
  lines: string[];
  deaths: Seat[];
}

export interface History {
  deal: string[];
  nights: NightLog[];
  badge: string[];
  shots: string[];
}

export interface GameState {
  id: string;
  seed: string;
  rng: number;
  rules: RuleSet;
  players: PlayerState[];
  day: number;
  phase: GamePhase;
  stage: string;
  sheriff: Seat | null;
  election: ElectionState;
  dayState: DayState;
  night: NightState | null;
  pendingDeaths: PendingDeaths | null;
  deaths: DeathRecord[];
  agenda: Step[];
  pending: Decision | null;
  seq: number;
  counters: { decision: number; batch: number };
  history: History;
  /** 胜负已分，正在公布结果。 */
  ending: boolean;
  result: GameResult | null;
}

export interface RuleError {
  code: string;
  reason: string;
}

export interface StepHandler {
  run(ctx: Ctx, step: Step): void;
  /** 决策的全部行动者都提交后调用。 */
  decide?(ctx: Ctx, step: Step, submissions: Record<number, ToolCall>): void;
  /** 在通用参数校验之前执行，用来返回更具体的错误码。 */
  validate?(ctx: Ctx, step: Step, seat: Seat, call: ToolCall): RuleError | null;
  /** 超时或多次非法后的托管行动。 */
  fallback?(ctx: Ctx, step: Step, seat: Seat): ToolCall;
  /** 同时行动时，提交者自己看到的回执。 */
  ack?(ctx: Ctx, step: Step, seat: Seat, call: ToolCall): string;
}

export interface ResolutionRow {
  attack: Attack;
  blockers: Protection[];
  blocked: boolean;
  causes: string[];
}

export interface InterruptDef {
  tool: string;
  available(ctx: Ctx, seat: Seat): boolean;
  spec(ctx: Ctx, seat: Seat): ToolSpec;
  apply(ctx: Ctx, seat: Seat, call: ToolCall): void;
}

export type OptionDef = RuleOptionInfo;

/** 目录构建只读取开局规则与座位，不可读取阶段、存活或私有资源，保持整局 Schema 稳定。 */
export interface ToolCatalogContext {
  readonly seat: Seat;
  readonly seats: Seat[];
  readonly rules: RuleSet;
}

export interface RoleModule {
  /** 身份自行声明固定工具，新身份无需修改公共目录分支。 */
  tools?(context: ToolCatalogContext): ToolSpec[];
  id: string;
  name: string;
  faction: 'good' | 'wolf';
  /** 屠边统计用：god 神职、villager 平民、wolf 狼人。 */
  category: 'god' | 'villager' | 'wolf';
  maxPerGame: number;
  summary: string;
  /** 预言家查验看到的阵营，默认按 faction。 */
  inspectAs?: 'good' | 'wolf';
  /** 参与狼人夜间落刀、互认队友。 */
  wolfTeam?: boolean;
  /** 白天可以自爆。 */
  canExplode?: boolean;
  options?: OptionDef[];
  /** 占用的夜间阶段，order 越小越早。 */
  nightPhase?: { id: string; order: number };
  /** 一个身份可有多个夜间步骤，旧的单阶段声明仍然有效。 */
  nightPhases?: { id: string; order: number; name: string }[];
  steps?: Record<string, StepHandler>;
  interrupts?: InterruptDef[];
  /** 公共规则卡里的技能说明。 */
  ruleCard?(rules: RuleSet): string[];
  /** 身份附录里的私密说明，只能使用该座位有权知道的信息。 */
  appendix?(ctx: Ctx, seat: Seat): string[];
  /** 该座位通过自身技能确实获知的信息，可区分阵营与具体身份。 */
  knowledge?(ctx: Ctx, seat: Seat): IdentityKnowledge[];
  /** 具体身份查验的表现，不改变真实身份、阵营或能力。 */
  inspectRole?(ctx: Ctx, seat: Seat): string;
  /** 开局：初始化私有状态、发送私密信息。 */
  setup?(ctx: Ctx, seats: Seat[]): void;
  /** 新夜开始、任何夜间决策之前更新本身份的状态。 */
  nightStart?(ctx: Ctx): void;
  /** 夜间攻击结算后、天亮死亡职责之前启用延迟能力。 */
  afterNight?(ctx: Ctx): void;
  /** 出局时产生的职责（例如猎人开枪），按返回顺序执行。 */
  onDeath?(ctx: Ctx, death: DeathRecord): Step[];
  /** 被放逐前调用，返回 true 表示放逐被身份能力接管（例如白痴翻牌）。 */
  beforeExile?(ctx: Ctx, seat: Seat): boolean;
  /** 是否拥有放逐投票权。 */
  canVote?(ctx: Ctx, seat: Seat): boolean;
  /** 夜间结算的修正，例如同守同救。 */
  resolveNight?(ctx: Ctx, rows: ResolutionRow[]): void;
}

export interface PresetDef {
  id: string;
  version?: number;
  name: string;
  description: string;
  roles: string[];
  overrides?: Record<string, string | number | boolean>;
  tag?: string;
}
