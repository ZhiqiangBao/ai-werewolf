import { gameText } from './locale';
import type { GameEvent, GodProjection, RoomBrief, Seat, Thought } from './index';

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
    if (eventPurpose(e) !== 'gameplay' || e.payload.announced === true || ['wolf.team', 'night.resolution'].includes(e.type)) return [];
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

export interface VideoScriptEntry {
  sourceSeq: number;
  type: string;
  speaker: string;
  voiceKey: string;
  seat?: Seat;
  text: string;
  visibility: 'public' | 'private';
  /** 用于票型、PK 等剪辑卡片；不含决策问话。 */
  data: Record<string, unknown>;
}

/** 未配音的剪辑稿，不把模型网络等待时间冒充成片时间。 */
export function buildVideoScript(p: GodProjection, room: RoomBrief) {
  if (p.viewer.kind !== 'god' || room.viewer !== 'host') throw new Error(gameText(p.locale, "只有上帝视角可以导出完整剪辑稿"));
  const chapters: { day: number; phase: GameEvent['phase']; title: string; entries: VideoScriptEntry[] }[] = [];
  const narrated = gameRecordEvents(p.events, p.locale);
  const narratedBySeq = new Map(narrated.map((e) => [e.seq, e]));
  for (const e of narrated) {
    const key = `${e.day}:${e.phase}`;
    let chapter = chapters.at(-1);
    if (!chapter || `${chapter.day}:${chapter.phase}` !== key) {
      chapter = { day: e.day, phase: e.phase, title: e.phase === 'setup' ? gameText(p.locale, "开局") : e.phase === 'end' ? gameText(p.locale, "终局") : gameText(p.locale, "第{0}{1}", e.day, e.phase === 'night' ? gameText(p.locale, "夜") : gameText(p.locale, "天")), entries: [] };
      chapters.push(chapter);
    }
    const speech = e.type === 'speech' || e.type === 'wolf.chat';
    const seat = speech && typeof e.payload.seat === 'number' ? e.payload.seat : undefined;
    const { decisionId: _decision, step: _step, prompt: _prompt, announced: _announced, ...data } = e.payload;
    const previous = p.events.findLast((event) => event.seq < e.seq);
    const actingSeat = seat ?? (Array.isArray(e.audience) && e.audience.length === 1 ? e.audience[0] : undefined);
    if (previous?.type === 'action.fallback' && (e.type === 'speech.order' ||
        (actingSeat !== undefined && Array.isArray(previous.audience) && previous.audience.includes(actingSeat)))) data.systemFallback = true;
    chapter.entries.push({
      sourceSeq: e.seq, type: e.type,
      speaker: seat === undefined ? gameText(p.locale, "法官") : gameText(p.locale, "{0}号{1}", seat, e.type === 'wolf.chat' ? gameText(p.locale, "（狼队密谈）") : ''),
      voiceKey: seat === undefined ? 'judge' : `seat-${seat}`,
      ...(seat === undefined ? {} : { seat }),
      text: speech && typeof e.payload.content === 'string' ? e.payload.content : e.text,
      visibility: e.audience === 'public' ? 'public' : 'private', data,
    });
  }
  return {
    format: 'werewolf-video-script', version: 1, perspective: 'god', timing: 'untimed',
    locale: p.locale ?? 'zh-CN', roomId: room.roomId, presetName: p.presetName, status: p.status,
    ruleCard: p.ruleCard,
    cast: p.god.roles.map((r) => ({ seat: r.seat, name: p.seats.find((s) => s.seat === r.seat)?.name ?? gameText(p.locale, "{0}号", r.seat), role: r.role, roleName: r.roleName, factionName: r.factionName, voiceKey: `seat-${r.seat}` })),
    // 已被合并播报的出局等事实仍供画面重建，spoken=false 避免重复配音。
    events: p.events.filter((e) => eventPurpose(e) === 'gameplay' && e.type !== 'wolf.team').map((e) => {
      const { decisionId: _decision, step: _step, prompt: _prompt, announced: _announced, ...data } = e.payload;
      return { sourceSeq: e.seq, day: e.day, phase: e.phase, type: e.type, audience: e.audience, spoken: narratedBySeq.has(e.seq), text: narratedBySeq.get(e.seq)?.text ?? e.text, data };
    }),
    chapters, result: p.result ?? null,
  };
}
