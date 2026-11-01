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
export function gameRecordEvents(events: GameEvent[]): GameEvent[] {
  return events.flatMap((e) => {
    if (eventPurpose(e) !== 'gameplay' || e.payload.announced === true || ['wolf.team', 'night.resolution'].includes(e.type)) return [];
    const p = e.payload;
    const actor = Array.isArray(e.audience) && e.audience.length === 1 ? `（${e.audience[0]}号）` : '';
    let text = e.text;
    // 旧存档曾把行动问话合并到事实正文里，展示时还原为简短、客观的事实。
    if (e.type === 'sheriff.start') text = '警长竞选开始。';
    if (e.type === 'witch.knife') text = typeof p.knife === 'number' ? `女巫${actor}获知刀口：${p.knife}号。` : '女巫获知今夜没有刀口。';
    if (e.type === 'wolf.kill.split') {
      const picks = Array.isArray(p.picks) ? p.picks as [Seat, Seat | null][] : [];
      text = `狼队刀口并列${picks.length ? `（${picks.map(([s, t]) => `${s}号→${t === null ? '空刀' : `${t}号`}`).join('、')}）` : ''}。`;
    }
    if (e.type === 'guard.protect') text = `守卫${actor}守护${p.target}号。`;
    if (e.type === 'guard.skip') text = `守卫${actor}选择空守。`;
    if (e.type === 'seer.result') text = `预言家${actor}查验${p.target}号：${p.result === 'wolf' ? '狼人' : '好人'}。`;
    if (e.type === 'seer.skip') text = `预言家${actor}本夜没有查验。`;
    if (e.type === 'witch.save') text = `女巫${actor}对${p.target}号使用解药。`;
    if (e.type === 'witch.poison') text = `女巫${actor}对${p.target}号使用毒药。`;
    if (e.type === 'witch.idle') text = `女巫${actor}本夜没有用药。`;
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
  if (p.viewer.kind !== 'god' || room.viewer !== 'host') throw new Error('只有上帝视角可以导出完整剪辑稿');
  const chapters: { day: number; phase: GameEvent['phase']; title: string; entries: VideoScriptEntry[] }[] = [];
  const narrated = gameRecordEvents(p.events);
  const narratedBySeq = new Map(narrated.map((e) => [e.seq, e]));
  for (const e of narrated) {
    const key = `${e.day}:${e.phase}`;
    let chapter = chapters.at(-1);
    if (!chapter || `${chapter.day}:${chapter.phase}` !== key) {
      chapter = { day: e.day, phase: e.phase, title: e.phase === 'setup' ? '开局' : e.phase === 'end' ? '终局' : `第${e.day}${e.phase === 'night' ? '夜' : '天'}`, entries: [] };
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
      speaker: seat === undefined ? '法官' : `${seat}号${e.type === 'wolf.chat' ? '（狼队密谈）' : ''}`,
      voiceKey: seat === undefined ? 'judge' : `seat-${seat}`,
      ...(seat === undefined ? {} : { seat }),
      text: speech && typeof e.payload.content === 'string' ? e.payload.content : e.text,
      visibility: e.audience === 'public' ? 'public' : 'private', data,
    });
  }
  return {
    format: 'werewolf-video-script', version: 1, perspective: 'god', timing: 'untimed',
    roomId: room.roomId, presetName: p.presetName, status: p.status,
    ruleCard: p.ruleCard,
    cast: p.god.roles.map((r) => ({ seat: r.seat, name: p.seats.find((s) => s.seat === r.seat)?.name ?? `${r.seat}号`, role: r.role, roleName: r.roleName, factionName: r.factionName, voiceKey: `seat-${r.seat}` })),
    // 已被合并播报的出局等事实仍供画面重建，spoken=false 避免重复配音。
    events: p.events.filter((e) => eventPurpose(e) === 'gameplay' && e.type !== 'wolf.team').map((e) => {
      const { decisionId: _decision, step: _step, prompt: _prompt, announced: _announced, ...data } = e.payload;
      return { sourceSeq: e.seq, day: e.day, phase: e.phase, type: e.type, audience: e.audience, spoken: narratedBySeq.has(e.seq), text: narratedBySeq.get(e.seq)?.text ?? e.text, data };
    }),
    chapters, result: p.result ?? null,
  };
}
