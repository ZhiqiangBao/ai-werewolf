import type { GameEvent, Seat } from '@werewolf/protocol';
import type { ChatMessage } from '@werewolf/llm';

/** 旁听轮次调用了工具时，原样退回。不执行。 */
export const NOT_TOOL_TURN = '不是工具调用轮次，请勿调用。';

export interface SeatThread {
  seat: Seat;
  /** 已经写进对话的最后一条事件序号。 */
  seen: number;
  /** 当前这个决策的结尾已经写过，就不再写第二条。 */
  cueFor?: string;
  messages: ChatMessage[];
}

/** 写结尾时用。下一步是谁、是什么。 */
export interface TurnHint {
  nextSeat: number | null;
  nextStep: string | null;
}

/** 这一步要不要单独补一句法官提示。发言的结尾已经写在上一条里时不必再补。 */
export interface ActionCue {
  id: string;
  step: string;
  kind: string | null;
  actors: number[];
  prompts: Record<number, string>;
  tool: string;
  /** 投票、上警：每个座位都写一句，结尾按他能不能动。夜间技能只写给行动者。 */
  broadcast: boolean;
}

const visible = (e: GameEvent, seat: Seat) =>
  e.audience === 'public' || (Array.isArray(e.audience) && e.audience.includes(seat));

const TOOL_TAIL: Record<string, string> = {
  sheriff_signup: '你现在可以使用上警与否工具。',
  guard_protect: '你现在可以使用守护工具。',
  seer_inspect: '你现在可以使用查验工具。',
  witch_act: '你现在可以使用用药工具。',
  wolf_kill: '你现在可以使用落刀工具。',
  vote: '你现在可以使用投票工具。',
  sheriff_vote: '你现在可以使用投票工具。',
  set_speak_direction: '你现在可以使用选择发言方向的工具。',
  badge_dispose: '你现在可以使用处理警徽工具。',
  hunter_shoot: '你现在可以使用开枪工具。',
  sheriff_withdraw: '你现在可以使用退水工具。',
  wolf_explode: '你现在可以使用自爆工具。',
  wolf_explode_decision: '你现在可以使用自爆工具。',
};

const INVITE: Record<string, string> = {
  'sheriff.order': 'campaign',
  'sheriff.pk': 'sheriff_pk',
  'speech.order': 'discussion',
  'vote.pk': 'pk',
};

function speechKind(e: GameEvent): string {
  return typeof e.payload.kind === 'string' ? e.payload.kind : 'discussion';
}

/** 警上发言、白天发言、遗言、狼队密谈。name 仍是座位号。 */
function speechMark(e: GameEvent, speaker: number): string {
  if (e.type === 'wolf.chat') return `第${e.day}夜${speaker}号狼队密谈`;
  const kind = speechKind(e);
  if (kind === 'campaign') return `警上${speaker}号发言`;
  if (kind === 'sheriff_pk') return `警上${speaker}号PK发言`;
  if (kind === 'lastwords') return `第${e.day}天${speaker}号遗言`;
  if (kind === 'pk') return `第${e.day}天${speaker}号PK发言`;
  return `第${e.day}天${speaker}号发言`;
}

/** 这条消息的结尾。轮到这个座位，就告诉他可以用什么；不是他，就让他停。 */
export function turnSuffix(kind: string, yours: boolean, wolf = false): string {
  if (wolf) {
    return yours ? '接下来是你的发言轮次，可以调用狼队密谈工具。' : '不是你的发言轮次，不要调用工具。';
  }
  if (kind === 'campaign' || kind === 'sheriff_pk') {
    return yours ? '接下来是你的发言轮次，可以调用speak工具。' : '不是你的发言轮次，不可以调用。';
  }
  if (kind === 'discussion' || kind === 'pk' || kind === 'lastwords' || kind === 'speech') {
    return yours ? '接下来是你的发言轮次，可以使用工具。' : '不是你的发言轮次，不要调用工具。';
  }
  return yours ? (TOOL_TAIL[kind] ?? '你现在可以使用工具。') : '不要调用工具。';
}

function firstSeat(e: GameEvent): number | null {
  if (typeof e.payload.first === 'number') return e.payload.first;
  const order = e.payload.order;
  if (Array.isArray(order) && typeof order[0] === 'number') return order[0];
  return null;
}

function lastUser(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.content) return m.content;
  }
  return '';
}

function alreadySaid(prior: ChatMessage[], content: string): boolean {
  const quoted = JSON.stringify(content);
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    if (m.role === 'tool') {
      if (m.content === content) return true;
      continue;
    }
    if (m.role !== 'assistant') break;
    if (m.content === content || (m.content ?? '').includes(quoted)) return true;
    if ((m.tool_calls ?? []).some((c) => c.function.arguments.includes(quoted))) return true;
    break;
  }
  return false;
}

/**
 * 别人的发言追加为用户消息，结尾写这个座位下一步能不能动。
 * 自己的回复已经在末尾时，不再写一遍。
 */
export function eventToMessage(
  e: GameEvent,
  me: Seat,
  prior: ChatMessage[],
  hint: TurnHint,
  latestTalk: boolean,
): ChatMessage | null {
  const content = e.payload.content;
  const speaker = e.payload.seat;
  if ((e.type === 'speech' || e.type === 'wolf.chat') && typeof content === 'string' && typeof speaker === 'number') {
    if (speaker === me) {
      if (alreadySaid(prior, content)) return null;
      return { role: 'assistant', content };
    }
    const wolf = e.type === 'wolf.chat';
    const yours =
      latestTalk &&
      hint.nextSeat === me &&
      ((wolf && hint.nextStep === 'wolf.discuss') || (!wolf && hint.nextStep === 'speech'));
    const tail = turnSuffix(wolf ? 'wolf' : speechKind(e), yours, wolf);
    return { role: 'user', name: String(speaker), content: `${speechMark(e, speaker)}：${content}\n${tail}` };
  }
  const invite = INVITE[e.type];
  if (invite) {
    const first = firstSeat(e);
    const yours = latestTalk && first === me && hint.nextStep === 'speech' && hint.nextSeat === me;
    const who = first ? `有请${first}号玩家发言。` : '';
    return { role: 'user', name: 'judge', content: `法官：${e.text}${who}\n${turnSuffix(invite, yours)}` };
  }
  return { role: 'user', name: 'judge', content: `法官：${e.text}\n不要调用工具。` };
}

/** 把该座位还没见过的事件接在对话后面。系统消息只在第一句写入，之后不改。 */
export function syncThread(thread: SeatThread, events: GameEvent[], system: ChatMessage, hint: TurnHint = { nextSeat: null, nextStep: null }): void {
  if (!thread.messages.length) thread.messages.push(system);
  let lastTalk = -1;
  let lastNew = -1;
  for (const e of events) {
    if (e.seq <= thread.seen) continue;
    lastNew = e.seq;
    if ((e.type === 'speech' || e.type === 'wolf.chat') && visible(e, thread.seat)) lastTalk = e.seq;
  }
  for (const e of events) {
    if (e.seq <= thread.seen) continue;
    if (visible(e, thread.seat)) {
      const talk = e.seq === lastTalk;
      const invite = INVITE[e.type] ? e.seq === lastNew && lastTalk < 0 : false;
      const msg = eventToMessage(e, thread.seat, thread.messages, hint, talk || invite);
      if (msg) thread.messages.push(msg);
    }
    thread.seen = e.seq;
  }
}

/**
 * 上一条的结尾已经说明能不能动，就不再加消息。
 * 否则补一句法官提示，工具说明写在这句的结尾。
 */
export function ensureCue(thread: SeatThread, cue: ActionCue | null): void {
  if (!cue || thread.cueFor === cue.id) return;
  const actor = cue.actors.includes(thread.seat);
  const spoken = cue.step === 'speech' || cue.step === 'wolf.discuss';
  const tail = spoken
    ? turnSuffix(cue.step === 'wolf.discuss' ? 'wolf' : (cue.kind ?? 'discussion'), actor, cue.step === 'wolf.discuss')
    : actor
      ? (TOOL_TAIL[cue.tool] ?? '你现在可以使用工具。')
      : '不要调用工具。';
  const prev = lastUser(thread.messages);
  const body = (actor ? cue.prompts[thread.seat] : Object.values(cue.prompts).find(Boolean)) || '';
  if (actor && prev.endsWith(tail)) {
    thread.cueFor = cue.id;
    return;
  }
  if (!actor && (spoken || !cue.broadcast)) {
    thread.cueFor = cue.id;
    return;
  }
  if (!actor && body && prev.includes(body) && prev.endsWith(tail)) {
    thread.cueFor = cue.id;
    return;
  }
  if (!body) {
    thread.cueFor = cue.id;
    return;
  }
  thread.messages.push({ role: 'user', name: 'judge', content: `法官：${body}\n${tail}` });
  thread.cueFor = cue.id;
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
