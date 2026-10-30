import type { GameEvent, Projection, Seat } from '@werewolf/protocol';
import type { ChatMessage } from '@werewolf/llm';

/** 旁听轮次调用了工具时，原样退回。不执行。 */
export const NOT_TOOL_TURN = '不是工具调用轮次，请勿调用。';

export interface SeatThread {
  seat: Seat;
  /** 已经写进对话的最后一条事件序号。 */
  seen: number;
  messages: ChatMessage[];
}

const visible = (e: GameEvent, seat: Seat) =>
  e.audience === 'public' || (Array.isArray(e.audience) && e.audience.includes(seat));

const SPEECH_KIND: Record<string, string> = {
  discussion: '发言',
  campaign: '竞选发言',
  pk: 'PK发言',
  sheriff_pk: '竞选PK发言',
  lastwords: '遗言',
};

/** 第1天3号发言。name 仍是座位号，正文开头写明第几天、几号、哪种发言。 */
function speechMark(e: GameEvent, speaker: number): string {
  const when = `第${e.day}${e.phase === 'night' ? '夜' : '天'}`;
  if (e.type === 'wolf.chat') return `${when}${speaker}号狼队密谈`;
  const kind = typeof e.payload.kind === 'string' ? e.payload.kind : 'discussion';
  return `${when}${speaker}号${SPEECH_KIND[kind] ?? '发言'}`;
}

/**
 * 别人的发言是用户消息。自己刚说出口的那句如果已经在末尾，就不再写一遍。
 */
export function eventToMessage(e: GameEvent, me: Seat, prior: ChatMessage[]): ChatMessage | null {
  const content = e.payload.content;
  const speaker = e.payload.seat;
  if ((e.type === 'speech' || e.type === 'wolf.chat') && typeof content === 'string' && typeof speaker === 'number') {
    if (speaker === me) {
      const last = prior[prior.length - 1];
      if (last?.role === 'assistant' && last.content === content) return null;
      return { role: 'assistant', content };
    }
    return { role: 'user', name: String(speaker), content: `${speechMark(e, speaker)}：${content}` };
  }
  return { role: 'user', name: 'judge', content: e.text };
}

/** 把该座位还没见过的事件接在对话后面。系统消息沿用调用方给的那条，这里不改写它的文字。 */
export function syncThread(thread: SeatThread, events: GameEvent[], system: ChatMessage): void {
  if (!thread.messages.length) thread.messages.push(system);
  else if (thread.messages[0].role === 'system' && thread.messages[0].content !== system.content) thread.messages[0] = system;
  for (const e of events) {
    if (e.seq <= thread.seen) continue;
    if (visible(e, thread.seat)) {
      const msg = eventToMessage(e, thread.seat, thread.messages);
      if (msg) thread.messages.push(msg);
    }
    thread.seen = e.seq;
  }
}

export function taskMessage(p: Projection): ChatMessage {
  const task = p.task;
  const alive = p.seats.filter((s) => s.alive).map((s) => `${s.seat}号`);
  const dead = p.seats.filter((s) => !s.alive).map((s) => `${s.seat}号`);
  const sheriff = p.seats.find((s) => s.sheriff);
  const revealed = p.seats.filter((s) => s.revealedRoleName).map((s) => `${s.seat}号=${s.revealedRoleName}`);
  const status = [
    `存活（${alive.length} 人）：${alive.join('、') || '无'}`,
    `已出局：${dead.join('、') || '无'}`,
    `警长：${sheriff ? `${sheriff.seat}号` : '无'}`,
    ...(revealed.length ? [`已公开身份：${revealed.join('、')}`] : []),
  ].join('\n');
  return {
    role: 'user',
    name: 'judge',
    content: [
      task ? task.title : '当前没有需要你行动的任务。',
      ...(task ? [task.prompt] : []),
      ...(task?.simultaneous ? ['这一步所有相关玩家同时提交，别人的选择在全部提交后才公开。'] : []),
      status,
    ].join('\n'),
  };
}

/** 行动成功后记在自己的上下文里。发言用原话，方便和广播去重。 */
export function ownLine(tool: string, args: Record<string, unknown>): string {
  if (typeof args.content === 'string' && args.content) return args.content;
  if ('target' in args) return args.target == null ? `${tool}：放弃` : `${tool}：${args.target}号`;
  if ('explode' in args) return args.explode ? '自爆' : '不自爆';
  return tool;
}

export function notToolTurnMessages(previous: { assistant?: ChatMessage; toolCallIds: string[] }): ChatMessage[] {
  if (!previous.assistant) return [{ role: 'user', content: NOT_TOOL_TURN }];
  const out: ChatMessage[] = [previous.assistant];
  if (previous.toolCallIds.length) {
    for (const id of previous.toolCallIds) out.push({ role: 'tool', tool_call_id: id, content: NOT_TOOL_TURN });
  } else out.push({ role: 'user', content: NOT_TOOL_TURN });
  return out;
}
