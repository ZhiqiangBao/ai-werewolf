import { gameText } from '@werewolf/protocol';
import type { GameEvent, Seat } from '@werewolf/protocol';

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

type VideoFact<Phase extends string> = Pick<GameEvent, 'day' | 'type' | 'audience' | 'text'> & {
  sourceSeq: number;
  phase: Phase;
  spoken: boolean;
  data: Record<string, unknown>;
};

/** 从已投影的事实流和托管标记恢复配音章节。 */
export function videoChaptersFromEvents<Phase extends string>(events: readonly VideoFact<Phase>[], locale: string | undefined, fallbackSeqs: ReadonlySet<number>) {
  const chapters: { day: number; phase: Phase; title: string; entries: VideoScriptEntry[] }[] = [];
  for (const e of events) {
    if (!e.spoken) continue;
    const key = `${e.day}:${e.phase}`;
    let chapter = chapters.at(-1);
    if (!chapter || `${chapter.day}:${chapter.phase}` !== key) {
      chapter = { day: e.day, phase: e.phase, title: e.phase === 'setup' ? gameText(locale, "开局") : e.phase === 'end' ? gameText(locale, "终局") : gameText(locale, "第{0}{1}", e.day, e.phase === 'night' ? gameText(locale, "夜") : gameText(locale, "天")), entries: [] };
      chapters.push(chapter);
    }
    const speech = e.type === 'speech' || e.type === 'wolf.chat';
    const seat = speech && typeof e.data.seat === 'number' ? e.data.seat : undefined;
    chapter.entries.push({
      sourceSeq: e.sourceSeq, type: e.type,
      speaker: seat === undefined ? gameText(locale, "法官") : gameText(locale, "{0}号{1}", seat, e.type === 'wolf.chat' ? gameText(locale, "（狼队密谈）") : ''),
      voiceKey: seat === undefined ? 'judge' : `seat-${seat}`,
      ...(seat === undefined ? {} : { seat }),
      text: speech && typeof e.data.content === 'string' ? e.data.content : e.text,
      visibility: e.audience === 'public' ? 'public' : 'private',
      data: fallbackSeqs.has(e.sourceSeq) ? { ...e.data, systemFallback: true } : { ...e.data },
    });
  }
  return chapters;
}
