import type { GameEvent, Seat, ToolCall, ToolSpec } from '@werewolf/protocol';
import {
  buildRules,
  createGame,
  projectSeat,
  projectSpectator,
  submit,
  type ActionRecord,
  type GameState,
  type RuleError,
} from '../src/index';

export const DEAL12 = [
  'werewolf', 'werewolf', 'werewolf', 'werewolf',
  'seer', 'witch', 'hunter', 'guard',
  'villager', 'villager', 'villager', 'villager',
];
export const DEAL9 = ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'];

export interface GameOptions {
  toolsetVersion?: 1 | 2;
  electionVersion?: 1 | 2 | 3;
  preset?: string;
  deal?: string[];
  values?: Record<string, unknown>;
  seed?: string;
}

export interface NightPlan {
  guard?: Seat | null;
  kill?: Seat | null;
  inspect?: Seat;
  save?: boolean;
  poison?: Seat | null;
}

export class TestGame {
  state: GameState;
  events: GameEvent[] = [];
  actions: ActionRecord[] = [];
  readonly options: { id: string; rules: ReturnType<typeof buildRules>; seed: string; deal?: string[] };

  constructor(o: GameOptions = {}) {
    const preset = o.preset ?? (o.deal?.length === 9 ? 'classic9' : 'standard12');
    // 原有用例继续覆盖版本 2；发言后退水用例显式选择 3，随机整局和会话测试覆盖新局默认版本。
    const rules = buildRules(preset, o.values ?? {}, { toolsetVersion: o.toolsetVersion ?? 1, electionVersion: o.electionVersion ?? 2, allowFixed: true, ...(o.deal ? { roles: o.deal } : {}) });
    this.options = { id: 'test', rules, seed: o.seed ?? 'seed-1', ...(o.deal ? { deal: o.deal } : {}) };
    const r = createGame(this.options);
    this.state = r.state;
    this.events.push(...r.events);
  }

  get pending() {
    return this.state.pending;
  }

  waiting(): Seat[] {
    const d = this.state.pending;
    return d ? d.actors.filter((a) => !d.submissions[a]) : [];
  }

  toolsOf(seat: Seat): ToolSpec[] {
    return this.state.pending?.tools[seat] ?? [];
  }

  hasTool(name: string): boolean {
    const d = this.state.pending;
    return !!d && this.waiting().some((s) => d.tools[s].some((t) => t.name === name));
  }

  act(seat: Seat, tool: string, args: Record<string, unknown> = {}): RuleError | undefined {
    const input: ActionRecord = { seat, call: { tool, args } };
    const r = submit(this.state, input);
    this.actions.push(input);
    this.state = r.state;
    this.events.push(...r.events);
    return r.error;
  }

  ok(seat: Seat, tool: string, args: Record<string, unknown> = {}): void {
    const e = this.act(seat, tool, args);
    if (e) throw new Error(`${seat}号 ${tool} 被拒绝：${e.code} ${e.reason}`);
  }

  auto(seat: Seat): void {
    const input: ActionRecord = { seat, call: { tool: '', args: {} }, auto: true };
    const r = submit(this.state, input);
    this.actions.push(input);
    if (r.error) throw new Error(`托管失败：${r.error.reason}`);
    this.state = r.state;
    this.events.push(...r.events);
  }

  /** 用托管行动（或自定义策略）推进，直到条件满足。 */
  until(pred: (g: TestGame) => boolean, policy?: (seat: Seat, tools: ToolSpec[]) => ToolCall | undefined, max = 3000): void {
    for (let i = 0; i < max; i++) {
      if (pred(this)) return;
      if (this.state.result) throw new Error('对局已经结束，条件仍未满足');
      const seat = this.waiting()[0];
      if (seat === undefined) throw new Error('没有待行动座位');
      const call = policy?.(seat, this.toolsOf(seat));
      if (call) this.ok(seat, call.tool, call.args);
      else this.auto(seat);
    }
    throw new Error('推进超过上限');
  }

  untilTool(name: string): void {
    this.until((g) => g.hasTool(name));
  }

  /** 按计划完成整个夜晚。 */
  night(plan: NightPlan = {}): void {
    const n = this.state.day;
    while (this.state.phase === 'night' && this.state.day === n && this.pending && !this.state.result) {
      const seat = this.waiting()[0];
      const names = this.toolsOf(seat).map((t) => t.name);
      if (names.includes('guard_protect')) this.ok(seat, 'guard_protect', { target: plan.guard ?? null });
      else if (names.includes('wolf_discuss')) this.ok(seat, 'wolf_discuss', { content: '商量一下' });
      else if (names.includes('wolf_kill')) this.ok(seat, 'wolf_kill', { target: plan.kill ?? null });
      else if (names.includes('seer_inspect') && plan.inspect !== undefined) this.ok(seat, 'seer_inspect', { target: plan.inspect });
      else if (names.includes('witch_act')) this.ok(seat, 'witch_act', { save: !!plan.save, poisonTarget: plan.poison ?? null });
      else this.auto(seat);
    }
  }

  /** 所有存活玩家不上警。 */
  noElection(): void {
    if (!this.hasTool('sheriff_signup')) return;
    for (const s of this.waiting()) this.ok(s, 'sheriff_signup', { run: false });
  }

  /** 把当前白天推进到放逐投票。 */
  toVote(): void {
    this.until((g) => g.hasTool('vote'));
  }

  vote(map: Record<number, Seat | null>): void {
    if (!this.hasTool('vote')) throw new Error('当前不是投票');
    for (const s of this.waiting()) this.ok(s, 'vote', { target: map[s] ?? null });
  }

  /** 推进到下一夜开始（或对局结束）。 */
  toNight(): void {
    const day = this.state.day;
    this.until((g) => !!g.state.result || (g.state.phase === 'night' && g.state.day > day));
  }

  publicTexts(): string[] {
    return this.events.filter((e) => e.audience === 'public').map((e) => e.text);
  }

  view(seat: Seat) {
    return projectSeat(this.state, this.events, seat);
  }

  spectator() {
    return projectSpectator(this.state, this.events);
  }

  alive(): Seat[] {
    return this.state.players.filter((p) => p.alive).map((p) => p.seat);
  }

  /** 测试布置：直接让某些座位出局（不产生事件）。 */
  removeSeats(...seats: Seat[]): void {
    for (const s of seats) this.state.players[s - 1].alive = false;
  }
}

export function lastPublic(g: TestGame, type: string): GameEvent | undefined {
  return [...g.events].reverse().find((e) => e.type === type && e.audience === 'public');
}
