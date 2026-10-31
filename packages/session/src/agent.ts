import { eventPurpose, gameRecordEvents, type GameEvent, type Seat } from '@werewolf/protocol';
import { migrateTranscript, type TranscriptMessage } from '@werewolf/llm';

/** 旁听轮次调用了工具时，原样退回。不执行。 */
export const NOT_TOOL_TURN = '不是工具调用轮次，请勿调用。';

export interface SeatThread {
  formatVersion?: 2;
  seat: Seat;
  /** 已经写进对话的最后一条事件序号。 */
  seen: number;
  /** 当前这个决策的结尾已经写过，就不再写第二条。 */
  cueFor?: string;
  messages: TranscriptMessage[];
}

/** 旧 Chat 消息仅转换结构，不重放历史工具、不读取其他座位，也不改消息文本。 */
export function migrateThread(thread: SeatThread): SeatThread {
  if (thread.formatVersion !== 2) {
    thread.messages = migrateTranscript(thread.messages);
    thread.formatVersion = 2;
  }
  return thread;
}

/** 写结尾时用。下一步是谁、是什么。 */
export interface TurnHint {
  nextSeat: number | null;
  nextStep: string | null;
  /** 同步这一条时，如果它就是当前行动，用行动结尾，不用「不要调用工具」。 */
  cue?: ActionCue | null;
}

/** 这一步要不要单独补一句法官提示。发言的结尾已经写在上一条里时不必再补。 */
export interface ActionCue {
  id: string;
  afterSeq?: number;
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

/** 这条公开消息后面就是发言。警长票型若判定为 PK，和发言邀请是同一条。 */
function inviteKind(e: GameEvent): string | null {
  const named = INVITE[e.type];
  if (named) return named;
  if (e.type === 'vote.result' && e.payload.outcome === 'pk') return e.payload.kind === 'sheriff' ? 'sheriff_pk' : 'pk';
  return null;
}

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

function lastUser(messages: TranscriptMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.content) return m.content;
  }
  return '';
}

function alreadySaid(prior: TranscriptMessage[], content: string): boolean {
  const quoted = JSON.stringify(content);
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    if (m.role === 'tool') {
      if (m.content === content) return true;
      continue;
    }
    if (m.role !== 'assistant') break;
    if (m.content === content || (m.content ?? '').includes(quoted)) return true;
    if ((m.calls ?? []).some((c) => c.arguments.includes(quoted))) return true;
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
  prior: TranscriptMessage[],
  hint: TurnHint,
  latestTalk: boolean,
): TranscriptMessage | null {
  if (e.payload.announced === true || eventPurpose(e) === 'diagnostic') return null;
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
  const invite = inviteKind(e);
  if (invite) {
    const first = firstSeat(e);
    const yours = latestTalk && first === me && hint.nextStep === 'speech' && hint.nextSeat === me;
    const who = latestTalk && first && hint.nextStep === 'speech' && hint.nextSeat === first ? `有请${first}号玩家发言。` : '';
    return { role: 'user', name: 'judge', content: `法官：${e.text}${who}\n${turnSuffix(invite, yours)}` };
  }
  const opened = openAction(e, me, hint);
  if (opened) return opened;
  if (e.type === 'judge') {
    const cue = hint.cue;
    if (cue && e.payload.step === cue.step &&
        (e.payload.decisionId ? e.payload.decisionId === cue.id : e.seq === cue.afterSeq)) {
      const actor = cue.actors.includes(me);
      const prompt = (actor ? cue.prompts[me] : e.text) || e.text;
      return { role: 'user', name: 'judge', content: `法官：${prompt}\n${cueTail(cue, me)}` };
    }
    // 过期问话不是新事实，不能把「轮到你」与「不要调用」一起重播。
    return null;
  }
  const fact = ['witch.knife', 'sheriff.start', 'wolf.kill.split'].includes(e.type) ? gameRecordEvents([e])[0]?.text ?? e.text : e.text;
  return { role: 'user', name: 'judge', content: `法官：${fact}\n不要调用工具。` };
}

/** 这条事件就是当前行动。写成一句，带上能不能用工具，不再先停再追问。 */
function openAction(e: GameEvent, me: Seat, hint: TurnHint): TranscriptMessage | null {
  const cue = hint.cue;
  if (!cue) return null;
  if (e.payload.decisionId ? e.payload.decisionId !== cue.id : e.seq !== cue.afterSeq) return null;
  const match =
    (e.type === 'witch.knife' && cue.tool === 'witch_act') ||
    (e.type === 'sheriff.start' && cue.tool === 'sheriff_signup') ||
    (e.type === 'wolf.kill.split' && cue.tool === 'wolf_kill');
  if (!match) return null;
  const actor = cue.actors.includes(me);
  if (!actor && !(cue.broadcast && e.type === 'sheriff.start')) return null;
  const prompt = (actor ? cue.prompts[me] : Object.values(cue.prompts).find(Boolean)) || e.text;
  return { role: 'user', name: 'judge', content: `法官：${prompt}\n${cueTail(cue, me)}` };
}

/** 把该座位还没见过、且不超过 maxSeq 的事件接在对话后面。系统消息只在第一句写入，之后不改。 */
export function syncThread(
  thread: SeatThread,
  events: GameEvent[],
  system: TranscriptMessage,
  hint: TurnHint = { nextSeat: null, nextStep: null },
  maxSeq = Number.POSITIVE_INFINITY,
): void {
  if (!thread.messages.length) thread.messages.push(system);
  const start = thread.messages.length;
  const previousUser = thread.messages.findLast((m) => m.role === 'user');
  // 当前决策的行动许可不能倒灌到尚未送完的历史消息里。
  const complete = !hint.cue?.afterSeq || maxSeq >= hint.cue.afterSeq;
  const turn = complete ? hint : { nextSeat: null, nextStep: null, cue: null };
  const pending = events.filter((e) => e.seq > thread.seen && e.seq <= maxSeq);
  let lastTalk = -1;
  let lastNew = -1;
  for (const e of pending) {
    lastNew = e.seq;
    if ((e.type === 'speech' || e.type === 'wolf.chat') && visible(e, thread.seat)) lastTalk = e.seq;
  }
  for (const e of pending) {
    if (visible(e, thread.seat)) {
      const talk = e.seq === lastTalk;
      const invite = inviteKind(e) ? e.seq === lastNew && lastTalk < 0 : false;
      const msg = eventToMessage(e, thread.seat, thread.messages, turn, talk || invite);
      const prev = thread.messages.at(-1);
      // 发言与紧随其后的邀请一次送达，不在两句之间让模型空回一轮。
      const previousEvent = pending.findLast((p) => p.seq < e.seq && visible(p, thread.seat));
      const followsSpeech = previousEvent && (previousEvent.type === 'speech' || previousEvent.type === 'wolf.chat' || !!inviteKind(previousEvent));
      if (msg && e.type === 'judge' && e.payload.decisionId === turn.cue?.id && followsSpeech &&
          thread.messages.length > start && prev?.role === 'user') {
        prev.content = `${prev.content.slice(0, prev.content.lastIndexOf('\n'))}\n${msg.content}`;
      } else if (msg) thread.messages.push(msg);
    }
    thread.seen = e.seq;
  }
  if (complete && turn.cue?.actors.includes(thread.seat) &&
      thread.messages.findLast((m) => m.role === 'user') !== previousUser &&
      lastUser(thread.messages).endsWith(cueTail(turn.cue, thread.seat))) {
    thread.cueFor = turn.cue.id;
  }
}

/** 这条法官提示的结尾。行动者能用工具，其他人停。 */
export function cueTail(cue: ActionCue, seat: number): string {
  const actor = cue.actors.includes(seat);
  const wolf = cue.step === 'wolf.discuss';
  if (cue.step === 'speech' || wolf) return turnSuffix(wolf ? 'wolf' : (cue.kind ?? 'discussion'), actor, wolf);
  return actor ? (TOOL_TAIL[cue.tool] ?? '你现在可以使用工具。') : '不要调用工具。';
}

/** 已收到当前决策的行动许可与此前消息。重试反馈不会撤销同一决策的许可。 */
export function readyToAct(thread: SeatThread, cue: ActionCue | null): boolean {
  return !!cue && cue.actors.includes(thread.seat) && thread.cueFor === cue.id &&
    thread.seen >= (cue.afterSeq ?? 0);
}

/**
 * 上一条的结尾已经说明能不能动，就不再加消息。
 * 否则补一句法官提示，工具说明写在这句的结尾。
 */
export function ensureCue(thread: SeatThread, cue: ActionCue | null): void {
  if (!cue) return;
  if (thread.seen < (cue.afterSeq ?? 0)) return;
  const actor = cue.actors.includes(thread.seat);
  if (thread.cueFor === cue.id && !actor) return;
  const spoken = cue.step === 'speech' || cue.step === 'wolf.discuss';
  const tail = cueTail(cue, thread.seat);
  const prev = lastUser(thread.messages);
  const body = (actor ? cue.prompts[thread.seat] : Object.values(cue.prompts).find(Boolean)) || '';
  if (actor && thread.cueFor === cue.id && prev.endsWith(tail)) return;
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

export function notToolTurnMessages(previous: { assistant?: TranscriptMessage; toolCallIds: string[] }): TranscriptMessage[] {
  if (!previous.assistant) return [{ role: 'user', content: NOT_TOOL_TURN }];
  const out: TranscriptMessage[] = [previous.assistant];
  if (previous.toolCallIds.length) {
    for (const id of previous.toolCallIds) out.push({ role: 'tool', callId: id, content: NOT_TOOL_TURN, isError: true });
  } else out.push({ role: 'user', content: NOT_TOOL_TURN });
  return out;
}
