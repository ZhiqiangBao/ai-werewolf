import { gameText } from '@werewolf/protocol';
import type { GameEvent, RuleSet, Seat, ToolCall, ToolSpec } from '@werewolf/protocol';
import { canonicalAction } from '@werewolf/protocol';
import { Ctx } from './context';
import { getRole, getStep, interruptsIn } from './registry';
import { hashSeed } from './rng';
import { validateRules } from './rules';
import { err, normalizeCall, validateArgs } from './tools';
import type { GameState, RuleError } from './types';
import { migrateGameState } from './role-data';
import { evaluateWin } from './flow/win';
import { seatLabel } from './text';

export interface CreateGameOptions {
  id: string;
  rules: RuleSet;
  seed: string;
  names?: string[];
  /** 仅供测试固定发牌。正式对局用种子洗牌。 */
  deal?: string[];
}

export interface SubmitInput {
  seat: Seat;
  call: ToolCall;
  decisionId?: string;
  /** 超时或多次非法后的托管提交：由引擎生成确定性的托管行动。 */
  auto?: boolean;
  /** 只写给行动者的托管原因，不改变正常公开结果。 */
  autoReason?: 'timeout' | 'invalid_tool' | 'request_failed';
}

export interface EngineResult {
  state: GameState;
  events: GameEvent[];
  error?: RuleError;
}

export class RulesError extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join('；'));
  }
}

const FALLBACK_TEXT: Record<string, string> = {
  mirror_inspect: '本夜不查验',
  awakened_wait: '保留模仿机会',
  awakened_empty_kill: '继承狼刀记为空刀',
  awakened_skip_skill: '本夜不用模仿技能',
  speak: '本段发言记为「我这轮过。」',
  wolf_discuss: '密谈记为「过。」',
  wolf_kill: '你的落刀记为空刀',
  seer_inspect: '本夜不查验',
  witch_act: '不救也不毒',
  guard_protect: '空守',
  hunter_shoot: '放弃开枪',
  wolf_explode_decision: '不自爆',
  sheriff_signup: '不上警',
  sheriff_vote: '弃票',
  vote: '弃票',
  set_speak_direction: '顺时针',
  badge_dispose: '撕毁警徽',
};

function runAgenda(ctx: Ctx): void {
  const s = ctx.state;
  let guard = 0;
  while (!s.pending && !s.result) {
    if (++guard > 100_000) throw new Error(gameText(ctx.rules.locale, "议程没有收敛"));
    const step = s.agenda.shift();
    if (!step) throw new Error(gameText(ctx.rules.locale, "议程为空，但对局还没有结束"));
    // 每批死亡及其各项职责开始前重新检查；前一枪致胜时取消已排队的后续技能。
    if (s.rules.deathResolutionVersion === 2 &&
      (step.type === 'deaths.batch' || step.dutySeat !== undefined) && evaluateWin(ctx)) {
      getStep('win.check').run(ctx, { type: 'win.check' });
      continue;
    }
    getStep(step.type).run(ctx, step);
  }
}

function sameMultiset(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
}

function strictArguments(ctx: Ctx, spec: ToolSpec, call: ToolCall, seat: Seat): RuleError | null {
  if (ctx.state.rules.toolsetVersion !== 2) return null;
  if (Array.isArray(call.args)) return err('INVALID_ARGUMENT', gameText(ctx.rules.locale, "工具参数必须是 JSON 对象"));
  const extra = Object.keys(call.args).filter((name) => !spec.params.some((p) => p.name === name));
  if (extra.length) return err('INVALID_ARGUMENT', gameText(ctx.rules.locale, "「{0}」不接受参数 {1}；{2}", spec.name, extra.join('、'), spec.params.length ? gameText(ctx.rules.locale, "只填写 {0}", spec.params.map((p) => p.name).join('、')) : gameText(ctx.rules.locale, "它是无参数工具，请填写 {}")));
  return validateArgs(ctx, spec, call.args, seat);
}

export function createGame(o: CreateGameOptions): EngineResult {
  const errors = validateRules(o.rules);
  if (errors.length) throw new RulesError(errors);
  const rules = structuredClone(o.rules);
  const state: GameState = {
    id: o.id,
    seed: o.seed,
    rng: hashSeed(o.seed),
    rules,
    players: [],
    day: 0,
    phase: 'setup',
    stage: gameText(o.rules.locale, "准备开始"),
    sheriff: null,
    election: { status: 'pending', candidates: [], withdrawn: [], postponed: false, postponedCandidates: null, explosions: 0 },
    dayState: { direction: null, firstSpeaker: null, anchor: null, electionToday: false },
    night: null,
    pendingDeaths: null,
    deaths: [],
    agenda: [],
    pending: null,
    seq: 0,
    counters: { decision: 0, batch: 0 },
    history: { deal: [], nights: [], badge: [], shots: [] },
    ending: false,
    result: null,
  };
  const ctx = new Ctx(state);
  if (o.deal && !sameMultiset(o.deal, rules.roles)) throw new RulesError([gameText(o.rules.locale, "固定发牌与版型身份不一致")]);
  const deal = o.deal ? [...o.deal] : ctx.shuffle([...rules.roles]);
  state.players = deal.map((role, i) => ({
    seat: i + 1,
    name: o.names?.[i]?.trim() || gameText(o.rules.locale, "{0}号", i + 1),
    role,
    alive: true,
    revealed: false,
    data: {},
  }));
  state.history.deal = deal;
  ctx.god('game.seed', gameText(o.rules.locale, "种子 {0}。发牌：{1}。", o.seed, deal.map((r, i) => gameText(o.rules.locale, "{0}号{1}", i + 1, gameText(o.rules.locale, getRole(r).name))).join('，')), {
    seed: o.seed,
    deal,
  });
  ctx.pub('game.start', gameText(o.rules.locale, "游戏开始。本局「{0}」，共 {1} 人，规则卡已发给所有座位。", rules.presetName, rules.playerCount), {
    presetId: rules.presetId,
    playerCount: rules.playerCount,
  });
  for (const mod of ctx.modulesInGame()) mod.setup?.(ctx, ctx.seatsOf(mod.id, false));
  state.players = migrateGameState(state).players;
  ctx.pushFront({ type: 'night.start' });
  runAgenda(ctx);
  return { state, events: ctx.events };
}

function apply(ctx: Ctx, input: SubmitInput): RuleError | null {
  const s = ctx.state;
  if (s.result) return err('GAME_ENDED', gameText(ctx.rules.locale, "对局已经结束"));
  if (!input.auto && s.rules.toolsetVersion === 2 && (!input.call?.args || typeof input.call.args !== 'object' || Array.isArray(input.call.args))) {
    return err('INVALID_ARGUMENT', gameText(ctx.rules.locale, "工具参数必须是 JSON 对象；无参数工具填写 {}"));
  }
  const call: ToolCall = {
    tool: typeof input.call?.tool === 'string' ? input.call.tool : '',
    args: input.call?.args && typeof input.call.args === 'object' ? input.call.args : {},
  };
  const d = s.pending;
  if (input.decisionId && input.decisionId !== d?.id) return err('STALE_DECISION', gameText(ctx.rules.locale, "这个决策已经结束，请刷新后重新选择"));
  const inTask = !!d && d.actors.includes(input.seat) && !d.submissions[input.seat] && d.tools[input.seat].some((t) => t.name === call.tool);

  if (!inTask && !input.auto) {
    const intr = interruptsIn(s.rules).find((i) => i.tool === call.tool);
    if (intr && intr.available(ctx, input.seat)) {
      const spec = intr.spec(ctx, input.seat);
      const strict = strictArguments(ctx, spec, call, input.seat);
      if (strict) return strict;
      const final = normalizeCall(spec, call);
      const e = validateArgs(ctx, spec, final.args, input.seat);
      if (e) return e;
      intr.apply(ctx, input.seat, final);
      return null;
    }
  }

  if (!d) return err('NOT_YOUR_TURN', gameText(ctx.rules.locale, "当前没有需要行动的决策"));
  if (input.decisionId && input.decisionId !== d.id) return err('STALE_DECISION', gameText(ctx.rules.locale, "这个决策已经结束"));
  if (!d.actors.includes(input.seat)) return err('NOT_YOUR_TURN', gameText(ctx.rules.locale, "当前没有轮到你行动"));
  if (d.submissions[input.seat]) return err('ALREADY_ACTED', gameText(ctx.rules.locale, "这一步你已经提交过了"));

  const handler = getStep(d.step.type);
  let final: ToolCall;
  if (input.auto) {
    final = handler.fallback ? handler.fallback(ctx, d.step, input.seat) : { tool: d.tools[input.seat][0].name, args: {} };
    const reason = input.autoReason === 'invalid_tool' ? gameText(ctx.rules.locale, "连续工具调用失败") : input.autoReason === 'request_failed' ? gameText(ctx.rules.locale, "模型请求失败") : gameText(ctx.rules.locale, "你没有在时限内完成有效行动");
    const attackTarget = final.tool === 'wolf_kill' ? final.args.target : final.tool === 'awakened_kill' ? final.args.targetSeat : undefined;
    const fallbackText = typeof attackTarget === 'number' ? gameText(ctx.rules.locale, "攻击目标记为{0}", seatLabel(attackTarget, ctx.rules.locale)) : gameText(ctx.rules.locale, FALLBACK_TEXT[final.tool] ?? final.tool);
    ctx.priv([input.seat], 'action.fallback', gameText(ctx.rules.locale, "{0}，系统已托管：{1}。", reason, fallbackText), {
      call: final,
      ...(input.autoReason ? { reason: input.autoReason } : {}),
    });
  } else {
    const tools = d.tools[input.seat];
    const spec = tools.find((t) => t.name === call.tool);
    if (!spec) {
      return err('TOOL_NOT_LEGAL', gameText(ctx.rules.locale, "当前不能使用「{0}」，可用工具：{1}", call.tool || gameText(ctx.rules.locale, "空"), tools.map((t) => t.name).join('、')));
    }
    final = normalizeCall(spec, call);
    if (s.rules.toolsetVersion === 2) {
      const rawError = strictArguments(ctx, spec, call, input.seat);
      if (rawError) return rawError;
    }
    const canonical = canonicalAction(spec, final);
    const e1 = handler.validate?.(ctx, d.step, input.seat, spec.operation ? canonical : { tool: final.tool, args: { ...call.args, ...final.args } });
    if (e1) return e1;
    const e2 = validateArgs(ctx, spec, final.args, input.seat);
    if (e2) return e2;
    final = canonical;
  }
  d.submissions[input.seat] = final;
  const ack = handler.ack?.(ctx, d.step, input.seat, final);
  if (ack) d.acks[input.seat] = ack;
  if (d.actors.every((a) => d.submissions[a])) {
    s.pending = null;
    handler.decide?.(ctx, d.step, d.submissions);
  }
  return null;
}

/** 提交一次行动。总是在状态的深拷贝上执行；被拒绝时只追加一条仅行动者可见的拒绝说明。 */
export function submit(prev: GameState, input: SubmitInput): EngineResult {
  const ctx = new Ctx(migrateGameState(structuredClone(prev)));
  const error = apply(ctx, input);
  if (error) {
    if (Number.isInteger(input.seat) && input.seat >= 1 && input.seat <= ctx.state.players.length) {
      ctx.priv([input.seat], 'action.rejected', gameText(prev.rules.locale, "行动被拒绝：{0}。", error.reason), {
        code: error.code,
        reason: error.reason,
        tool: input.call?.tool,
      });
    }
    return { state: ctx.state, events: ctx.events, error };
  }
  runAgenda(ctx);
  return { state: ctx.state, events: ctx.events };
}

export interface ActionRecord extends SubmitInput {}

/** 由「规则 + 种子 + 行动序列」重放出完全相同的事件。 */
export function replay(o: CreateGameOptions, actions: ActionRecord[]): { state: GameState; events: GameEvent[] } {
  const first = createGame(o);
  let state = first.state;
  const events = [...first.events];
  for (const a of actions) {
    const r = submit(state, a);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

/** 房主终结。记为流局，不跑剩余结算，不公开身份和夜间行动。 */
export function abandonGame(prev: GameState): EngineResult {
  const ctx = new Ctx(structuredClone(prev));
  if (ctx.state.result) return { state: ctx.state, events: [] };
  const s = ctx.state;
  s.phase = 'end';
  s.stage = gameText(prev.rules.locale, "游戏结束");
  s.ending = false;
  s.agenda = [];
  s.pending = null;
  s.result = { winner: 'draw', winnerName: gameText(prev.rules.locale, "无人"), reason: gameText(prev.rules.locale, "房主终结了对局，本局流局，无胜负。"), reveal: false };
  ctx.pub('game.end', gameText(prev.rules.locale, "游戏结束：流局，无胜负。"), { result: s.result });
  return { state: s, events: ctx.events };
}

/** 当前决策里还没有提交的座位。 */
export function waitingSeats(state: GameState): Seat[] {
  const d = state.pending;
  if (!d) return [];
  return d.actors.filter((a) => !d.submissions[a]);
}
