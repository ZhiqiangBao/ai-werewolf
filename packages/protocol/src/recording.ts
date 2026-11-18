import { gameText } from './locale';
import { videoChaptersFromEvents } from './video-chapters';
export type { VideoScriptEntry } from './video-chapters';
import type { GameEvent, GodProjection, NightActionKind, NightActionRound, NightRoundKind, RoomBrief, Seat, Thought } from './index';

const PRIVATE_STATUS = new Set(['awakened.identity', 'awakened.inherit', 'awakened.activated']);

function singleSeat(event: GameEvent): Seat | undefined {
  return Array.isArray(event.audience) && event.audience.length === 1 && Number.isInteger(event.audience[0]) ? event.audience[0] : undefined;
}

function recordedTarget(value: unknown): Seat | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function derivedRound(day: number, roundKind: NightRoundKind, actionKind: NightActionKind, actorSeatId: Seat, targetSeatId: number | null): NightActionRound {
  return { roundKind, roundId: `night-${day}-${roundKind === 'lucky' ? `lucky-${actorSeatId}` : roundKind}`, actionKind, actorSeatId, targetSeatId };
}

/** 版本 3 使用事件上的 round。更早的存档只在读取时推导，不回写。 */
export function projectNightRound(event: GameEvent, actorRole?: string): NightActionRound | null {
  if (event.round) return event.round;
  const actor = singleSeat(event);
  if (actor === undefined) return null;
  const target = recordedTarget(event.payload.target);
  switch (event.type) {
    case 'merchant.gift': return derivedRound(event.day, 'merchant', 'gift', actor, target);
    case 'merchant.wait': return derivedRound(event.day, 'merchant', 'wait', actor, null);
    case 'lucky.inspect': case 'lucky.poison': case 'lucky.guard': return derivedRound(event.day, 'lucky', 'skill', actor, target);
    case 'lucky.skip': return derivedRound(event.day, 'lucky', 'skip', actor, null);
    case 'awakened.mimic': return derivedRound(event.day, 'awakened', 'mimic', actor, target);
    case 'awakened.wait': return derivedRound(event.day, 'awakened', 'wait', actor, null);
    case 'awakened.skill': return derivedRound(event.day, 'awakened', 'skill', actor, target);
    case 'awakened.skip': return derivedRound(event.day, 'awakened', 'skip', actor, null);
    case 'awakened.knife': return derivedRound(event.day, 'wolf', 'kill', actor, event.payload.target === null ? null : target);
    case 'mirror.result': return actorRole === 'awakened_wolf' ? derivedRound(event.day, 'awakened', 'skill', actor, target) : null;
    case 'mirror.skip': return actorRole === 'awakened_wolf' ? derivedRound(event.day, 'awakened', 'skip', actor, null) : null;
    default: return null;
  }
}

export function nightRoundSummary(round: NightActionRound, locale?: string): string {
  const action: Record<NightActionKind, string> = { gift: '交易', mimic: '模仿', wait: '空过', skip: '空过', skill: '技能', kill: '刀人' };
  const target = round.targetSeatId === null ? gameText(locale, '无') : gameText(locale, '{0}号', round.targetSeatId);
  return gameText(locale, '轮次：{0} · 行动：{1} · 目标：{2} · 座位：{3}', gameText(locale, ({ awakened: '觉醒隐狼', wolf: '狼人', merchant: '奇迹商人', lucky: '幸运儿' } as const)[round.roundKind]), gameText(locale, action[round.actionKind]), target, round.actorSeatId);
}

function fallbackSeatsBefore(events: GameEvent[], seq: number): number[] {
  const seats: number[] = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.seq >= seq) continue;
    if (event.type === 'action.fallback' && Array.isArray(event.audience)) {
      for (const seat of event.audience) if (!seats.includes(seat)) seats.push(seat);
      continue;
    }
    if (event.type === 'judge' || eventPurpose(event) === 'diagnostic') continue;
    break;
  }
  return seats;
}

function precededByBadgeChoice(events: GameEvent[], index: number, seat: unknown): boolean {
  if (typeof seat !== 'number') return false;
  for (let i = index - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'judge') return event.payload.step === 'badge.duty' && Array.isArray(event.audience) && event.audience.includes(seat);
    if (eventPurpose(event) !== 'diagnostic') break;
  }
  return false;
}

/** 从实际事实回填旧思考卡片的警徽结果；不从思考文本猜目标。 */
export function recordedBadgeOutcome(thought: Thought, events: GameEvent[]): { text: string; automatic: boolean } | null {
  const start = events.findIndex((e) => e.payload.decisionId === thought.decisionId && e.payload.step === 'badge.duty');
  if (start < 0) return null;
  let automatic = false;
  for (const e of events.slice(start + 1)) {
    if (e.type === 'judge' && e.payload.decisionId && e.payload.decisionId !== thought.decisionId) break;
    if (e.type === 'action.fallback' && Array.isArray(e.audience) && e.audience.includes(thought.seat)) automatic = true;
    if ((e.type === 'badge.transfer' || e.type === 'badge.tear') && e.payload.from === thought.seat) return { text: e.text, automatic };
  }
  return null;
}

/** 游戏画面、Agent 问话与诊断分别消费；兼容没有额外标记的历史存档。 */
export function eventPurpose(e: GameEvent): 'gameplay' | 'agent' | 'diagnostic' {
  if (e.type === 'judge') return 'agent';
  if (e.type.startsWith('action.') || ['game.seed', 'random.anchor'].includes(e.type)) return 'diagnostic';
  return 'gameplay';
}

/** 只接收调用方已按权限过滤的事件；不改变原始日志或 Agent 上下文。 */
export function gameRecordEvents(events: GameEvent[], locale: string | undefined = 'zh-CN'): GameEvent[] {
  return events.flatMap((e) => {
    if (eventPurpose(e) !== 'gameplay' || e.payload.announced === true || ['wolf.team', 'night.resolution', 'awakened.identity'].includes(e.type)) return [];
    const p = e.payload;
    const isSeat = (value: unknown): value is Seat => typeof value === 'number' && Number.isInteger(value) && value > 0;
    const actorSeat = Array.isArray(e.audience) && e.audience.length === 1 && isSeat(e.audience[0]) ? e.audience[0] : undefined;
    const actor = actorSeat === undefined ? '' : gameText(locale, "（{0}号）", actorSeat);
    let text = e.text;
    // 旧存档曾把行动问话合并到事实正文里，展示时还原为简短、客观的事实。
    if (e.type === 'sheriff.start') text = gameText(locale, "警长竞选开始。");
    if (e.type === 'witch.knife' && actorSeat !== undefined && (isSeat(p.knife) || p.knife === null)) text = isSeat(p.knife) ? gameText(locale, "女巫{0}获知刀口：{1}号。", actor, p.knife) : gameText(locale, "女巫获知今夜没有刀口。");
    if (e.type === 'witch.targets' && actorSeat !== undefined && Array.isArray(p.targets) && p.targets.every(isSeat)) {
      text = p.targets.length ? gameText(locale, "女巫{0}获知本夜受到狼人攻击的玩家：{1}。", actor, p.targets.map((seat) => gameText(locale, "{0}号", seat)).join(gameText(locale, '、')))
        : gameText(locale, "女巫获知今夜无人受到狼人攻击。");
    }
    if (e.type === 'wolf.kill.split' && Array.isArray(p.picks) && p.picks.length > 0 && p.picks.every((pick) => Array.isArray(pick) && pick.length === 2 && isSeat(pick[0]) && (pick[1] === null || isSeat(pick[1])))) {
      const picks = p.picks as [Seat, Seat | null][];
      text = gameText(locale, "狼队刀口并列{0}。", gameText(locale, '（{0}）', picks.map(([s, t]) => gameText(locale, "{0}号→{1}", s, t === null ? gameText(locale, "空刀") : gameText(locale, "{0}号", t))).join(gameText(locale, '、'))));
    }
    if (e.type === 'guard.protect' && actorSeat !== undefined && isSeat(p.target)) text = gameText(locale, "守卫{0}守护{1}号。", actor, p.target);
    if (e.type === 'guard.skip' && actorSeat !== undefined) text = gameText(locale, "守卫{0}选择空守。", actor);
    if (e.type === 'seer.result' && actorSeat !== undefined && isSeat(p.target) && (p.result === 'wolf' || p.result === 'good')) text = gameText(locale, "预言家{0}查验{1}号：{2}。", actor, p.target, p.result === 'wolf' ? gameText(locale, "狼人") : gameText(locale, "好人"));
    if (e.type === 'seer.skip' && actorSeat !== undefined) text = gameText(locale, "预言家{0}本夜没有查验。", actor);
    if (e.type === 'witch.save' && actorSeat !== undefined && isSeat(p.target)) text = gameText(locale, "女巫{0}对{1}号使用解药。", actor, p.target);
    if (e.type === 'witch.poison' && actorSeat !== undefined && isSeat(p.target)) text = gameText(locale, "女巫{0}对{1}号使用毒药。", actor, p.target);
    if (e.type === 'witch.no_save' && actorSeat !== undefined) text = isSeat(p.target)
      ? gameText(locale, "女巫{0}本夜没有对{1}号使用解药。", actor, p.target)
      : gameText(locale, "女巫{0}本夜没有使用解药。", actor);
    if (e.type === 'witch.no_poison' && actorSeat !== undefined) text = gameText(locale, "女巫{0}本夜没有使用毒药。", actor);
    if (e.type === 'witch.idle' && actorSeat !== undefined) text = gameText(locale, "女巫{0}本夜没有用药。", actor);
    return [{ ...e, text }];
  });
}

/** 未配音的剪辑稿，不把模型网络等待时间冒充成片时间。 */
export function buildVideoScript(p: GodProjection, room: RoomBrief) {
  if (p.viewer.kind !== 'god' || room.viewer !== 'host') throw new Error(gameText(p.locale, "只有上帝视角可以导出完整剪辑稿"));
  const narrated = gameRecordEvents(p.events, p.locale).filter((event) => !PRIVATE_STATUS.has(event.type));
  const narratedBySeq = new Map(narrated.map((e) => [e.seq, e]));
  const roleOf = new Map(p.god.roles.map((role) => [role.seat, role.role]));
  const fallbackSeqs = new Set<number>();
  // 已被合并播报的出局等事实仍供画面重建，spoken=false 避免重复配音。
  const events = p.events.flatMap((e, index) => {
    if (eventPurpose(e) !== 'gameplay' || e.type === 'wolf.team' || e.type === 'awakened.identity') return [];
    const { decisionId: _decision, step: _step, prompt: _prompt, announced: _announced, ...data } = e.payload;
    const actor = singleSeat(e);
    const round = projectNightRound(e, actor === undefined ? undefined : roleOf.get(actor));
    if (round) data.round = round;
    // badge.tear also occurs automatically when the Sheriff has nobody to hand the badge to.
    if (e.type === 'badge.tear' && precededByBadgeChoice(p.events, index, data.from)) data.badgeDecision = true;
    const fallbackSeats = fallbackSeatsBefore(p.events, e.seq);
    if (fallbackSeats.length) data.fallbackSeats = fallbackSeats;
    const previous = p.events[index - 1];
    const speech = e.type === 'speech' || e.type === 'wolf.chat';
    const seat = speech && typeof e.payload.seat === 'number' ? e.payload.seat : undefined;
    const actingSeat = seat ?? (Array.isArray(e.audience) && e.audience.length === 1 ? e.audience[0] : undefined);
    if (previous?.type === 'action.fallback' && (e.type === 'speech.order' ||
        (actingSeat !== undefined && Array.isArray(previous.audience) && previous.audience.includes(actingSeat)))) fallbackSeqs.add(e.seq);
    return [{ sourceSeq: e.seq, day: e.day, phase: e.phase, type: e.type, audience: e.audience, spoken: narratedBySeq.has(e.seq), text: narratedBySeq.get(e.seq)?.text ?? e.text, data }];
  });
  return {
    format: 'werewolf-video-script', version: 1, perspective: 'god', timing: 'untimed',
    locale: p.locale ?? 'zh-CN', roomId: room.roomId, presetName: p.presetName, status: p.status,
    ruleCard: p.ruleCard,
    cast: p.god.roles.map((r) => ({ seat: r.seat, name: p.seats.find((s) => s.seat === r.seat)?.name ?? gameText(p.locale, "{0}号", r.seat), role: r.role, roleName: r.roleName, factionName: r.factionName, voiceKey: `seat-${r.seat}` })),
    events, chapters: videoChaptersFromEvents(events, p.locale, fallbackSeqs), result: p.result ?? null,
  };
}
