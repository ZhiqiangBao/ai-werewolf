import type { Audience, GameEvent, RuleValue, Seat, ToolSpec } from '@werewolf/protocol';
import { expandActionTools } from '@werewolf/protocol';
import { getRole, modulesIn } from './registry';
import { seatTools } from './catalog';
import { decisionId, nextRandom } from './rng';
import type { DeathRecord, DeathVia, GameState, PlayerState, RoleModule, Step } from './types';

export interface AskOptions {
  step: Step;
  actors: Seat[];
  tools: (seat: Seat) => ToolSpec[];
  prompt: (seat: Seat) => string;
  title: string;
  publicStage: string;
  simultaneous?: boolean;
  publicActor?: Seat;
  speechWindow?: boolean;
  /**
   * 把这句法官的话写成事件。能看见的座位会把它接进自己的上下文。
   * public：全场都听见。actors：只给行动者，其他人的上下文里没有这句。
   */
  hear?: 'public' | 'actors';
}

export interface KillInfo {
  via: DeathVia;
  causes: string[];
  batch: number;
  by?: Seat;
  shooterVia?: DeathVia;
  /** 死亡所属的天数，夜间出局用夜晚编号。默认当前天数。 */
  day?: number;
}

/** 引擎内部的操作上下文。每次提交都在状态的深拷贝上创建一个新的上下文。 */
export class Ctx {
  readonly events: GameEvent[] = [];

  constructor(readonly state: GameState) {}

  get rules() {
    return this.state.rules;
  }

  opt<T extends RuleValue = RuleValue>(key: string): T {
    const v = this.state.rules.values[key];
    if (v === undefined) throw new Error(`规则对象缺少选项：${key}`);
    return v as T;
  }

  emit(type: string, audience: Audience, text: string, payload: Record<string, unknown> = {}): GameEvent {
    const ev: GameEvent = {
      seq: ++this.state.seq,
      day: this.state.day,
      phase: this.state.phase,
      type,
      audience: Array.isArray(audience) ? [...new Set(audience)].sort((a, b) => a - b) : audience,
      text,
      payload,
    };
    this.events.push(ev);
    return ev;
  }

  pub(type: string, text: string, payload?: Record<string, unknown>): GameEvent {
    return this.emit(type, 'public', text, payload);
  }

  priv(seats: Seat[], type: string, text: string, payload?: Record<string, unknown>): GameEvent {
    return this.emit(type, seats, text, payload);
  }

  god(type: string, text: string, payload?: Record<string, unknown>): GameEvent {
    return this.emit(type, [], text, payload);
  }

  random(): number {
    const [v, next] = nextRandom(this.state.rng);
    this.state.rng = next;
    return v;
  }

  randomInt(n: number): number {
    return Math.floor(this.random() * n);
  }

  pick<T>(items: T[]): T {
    if (!items.length) throw new Error('随机选择的列表为空');
    return items[this.randomInt(items.length)];
  }

  /** Fisher–Yates，原地打乱并返回。 */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.randomInt(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  get playerCount(): number {
    return this.state.players.length;
  }

  player(seat: Seat): PlayerState {
    const p = this.state.players[seat - 1];
    if (!p) throw new Error(`没有座位 ${seat}`);
    return p;
  }

  roleOf(seat: Seat): RoleModule {
    return getRole(this.player(seat).role);
  }

  isAlive(seat: Seat): boolean {
    return this.player(seat).alive;
  }

  alive(): Seat[] {
    return this.state.players.filter((p) => p.alive).map((p) => p.seat);
  }

  seatsOf(roleId: string, aliveOnly = true): Seat[] {
    return this.state.players
      .filter((p) => p.role === roleId && (!aliveOnly || p.alive))
      .map((p) => p.seat);
  }

  isWolfTeam(seat: Seat): boolean {
    return !!this.roleOf(seat).wolfTeam;
  }

  wolfTeam(aliveOnly = true): Seat[] {
    return this.state.players
      .filter((p) => getRole(p.role).wolfTeam && (!aliveOnly || p.alive))
      .map((p) => p.seat);
  }

  modulesInGame(): RoleModule[] {
    return modulesIn(this.state.rules);
  }

  canVote(seat: Seat): boolean {
    if (!this.isAlive(seat)) return false;
    const mod = this.roleOf(seat);
    return mod.canVote ? mod.canVote(this, seat) : true;
  }

  pushFront(...steps: Step[]): void {
    this.state.agenda.unshift(...steps);
  }

  newBatch(): number {
    return ++this.state.counters.batch;
  }

  ask(o: AskOptions): void {
    if (this.state.pending) throw new Error('上一个决策尚未完成');
    if (!o.actors.length) throw new Error(`决策 ${o.step.type} 没有行动者`);
    const actors = [...new Set(o.actors)].sort((a, b) => a - b);
    const tools: Record<number, ToolSpec[]> = {};
    const prompts: Record<number, string> = {};
    for (const s of actors) {
      const catalog = seatTools(this.state, s);
      tools[s] = expandActionTools(o.tools(s), this.state.rules).map((tool) => ({ ...tool, description: catalog.find((t) => t.name === tool.name)?.description ?? tool.description }));
      prompts[s] = o.prompt(s);
    }
    this.state.pending = {
      id: decisionId(this.state.seed, ++this.state.counters.decision),
      step: o.step,
      actors,
      tools,
      prompts,
      title: o.title,
      publicStage: o.publicStage,
      simultaneous: o.simultaneous ?? actors.length > 1,
      publicActor: o.publicActor,
      speechWindow: !!o.speechWindow,
      submissions: {},
      acks: {},
    };
    this.sayAsk(o.hear ?? 'actors', o.step.type, actors, prompts);
    this.state.pending.openedAtSeq = this.state.seq;
  }

  /** 行动问话留在内部事件流供 Agent 同步；对局画面只展示游戏事实。 */
  private sayAsk(hear: 'public' | 'actors', step: string, actors: Seat[], prompts: Record<number, string>): void {
    const first = prompts[actors[0]];
    const same = actors.every((s) => prompts[s] === first);
    const payload = { step, decisionId: this.state.pending!.id };
    // 这些通知本来就是同一次问话，直接补全原事件，不再先通知、再追问。
    const trigger = { 'sheriff.signup': 'sheriff.start', 'night:witch': 'witch.knife', 'wolf.kill': 'wolf.kill.split' }[step];
    const previous = this.events.at(-1);
    if (same && previous && trigger && previous.type === trigger) {
      Object.assign(previous.payload, payload, { prompt: first });
      return;
    }
    if (hear === 'public' && same) {
      this.pub('judge', first, payload);
      return;
    }
    if (same) {
      this.priv(actors, 'judge', first, payload);
      return;
    }
    for (const s of actors) this.priv([s], 'judge', prompts[s], payload);
  }

  /** 标记出局并登记死亡记录。职责（开枪、警徽、遗言）由 deaths.batch 步骤统一处理。 */
  kill(seat: Seat, info: KillInfo): DeathRecord | null {
    const p = this.player(seat);
    if (!p.alive) return null;
    p.alive = false;
    const rec: DeathRecord = {
      seat,
      day: info.day ?? this.state.day,
      via: info.via,
      causes: [...info.causes],
      by: info.by,
      shooterVia: info.shooterVia,
      batch: info.batch,
      lastWords: false,
      hooked: false,
    };
    rec.lastWords = lastWordsFor(this, rec);
    this.state.deaths.push(rec);
    return rec;
  }
}

export function lastWordsFor(ctx: Ctx, d: DeathRecord): boolean {
  switch (d.via) {
    case 'night':
      return ctx.opt<boolean>(d.day === 1 ? 'lastWords.firstNight' : 'lastWords.laterNight');
    case 'exile':
      return ctx.opt<boolean>('lastWords.exile');
    case 'explode':
      return ctx.opt<boolean>('lastWords.explode');
    case 'shot':
      if (d.shooterVia === 'night') {
        return ctx.opt<boolean>(d.day === 1 ? 'lastWords.shotAfterFirstNight' : 'lastWords.shotAfterLaterNight');
      }
      return ctx.opt<boolean>('lastWords.shotAfterVote');
    default:
      return false;
  }
}
