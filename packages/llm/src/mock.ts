import type { ParamSpec, Projection, Seat, ToolCall, ToolSpec } from '@werewolf/protocol';
import { exposeAction, simulationTools } from '@werewolf/protocol';
import type { Adapter, DecideRequest, DecideResult } from './types';

type Rand = () => number;

function seeded(text: string): Rand {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: Rand, list: T[]): T => list[Math.floor(r() * list.length)];
const last = <T>(list: T[]): T | undefined => list[list.length - 1];

interface Check {
  night: number;
  target: Seat;
  wolf: boolean;
}

/** 模拟玩家只读取自己的投影：公开发言、私密记录和身份说明。 */
interface Knowledge {
  me: Seat;
  role: string;
  isWolf: boolean;
  wolves: Seat[];
  alive: Seat[];
  checks: Check[];
  claimedSeers: Seat[];
  accused: Seat[];
  knife: Seat | null;
}

function know(p: Projection): Knowledge {
  const me = p.me!;
  const isWolf = me.faction === 'wolf';
  const checks: Check[] = [];
  const claimedSeers: Seat[] = [];
  const accused: Seat[] = [];
  let knife: Seat | null = null;
  for (const e of p.events) {
    if (e.type === 'seer.result') {
      checks.push({ night: e.day, target: e.payload.target as Seat, wolf: e.payload.result === 'wolf' });
    } else if (e.type === 'witch.knife' && e.day === p.day) {
      knife = (e.payload.knife as Seat | null) ?? null;
    } else if (e.type === 'speech' && e.audience === 'public') {
      const content = String(e.payload.content ?? '');
      const speaker = e.payload.seat as Seat;
      if (content.includes('我是预言家')) claimedSeers.push(speaker);
      for (const m of content.matchAll(/查验\s*(\d+)号，是狼人/g)) accused.push(Number(m[1]));
    }
  }
  const alive = p.seats.filter((s) => s.alive).map((s) => s.seat);
  return {
    me: me.seat,
    role: me.role,
    isWolf,
    wolves: isWolf ? [me.seat, ...(me.teammates ?? [])] : [],
    alive,
    checks,
    claimedSeers: claimedSeers.filter((s) => alive.includes(s)),
    accused: accused.filter((s) => alive.includes(s)),
    knife,
  };
}

const optionsOf = (spec: ToolSpec, name: string): Seat[] => {
  const p = spec.params.find((x) => x.name === name);
  return p?.kind === 'seat' || p?.kind === 'seats' ? p.options : [];
};

const cleared = (k: Knowledge, s: Seat) => k.checks.some((c) => c.target === s && !c.wolf);

/** 狼队在同一夜用同一个种子挑刀口，保证意见一致。 */
function wolfTarget(k: Knowledge, p: Projection, options: Seat[]): Seat | null {
  const r = seeded(`${p.gameId}:${p.day}:kill`);
  const good = options.filter((s) => !k.wolves.includes(s));
  if (!good.length) return null;
  const seers = k.claimedSeers.filter((s) => good.includes(s));
  if (seers.length && r() < 0.7) return seers[0];
  return pick(r, good);
}

function voteTarget(k: Knowledge, options: Seat[], r: Rand): Seat | null {
  if (k.isWolf) {
    const good = options.filter((s) => !k.wolves.includes(s));
    const seers = k.claimedSeers.filter((s) => good.includes(s));
    if (seers.length && r() < 0.6) return last(seers)!;
    return good.length ? pick(r, good) : null;
  }
  const mine = k.checks.filter((c) => c.wolf && options.includes(c.target));
  if (mine.length) return mine[0].target;
  const accused = k.accused.filter((s) => options.includes(s) && s !== k.me && !cleared(k, s));
  if (accused.length && r() < 0.8) return last(accused)!;
  const others = options.filter((s) => s !== k.me && !cleared(k, s));
  return others.length ? pick(r, others) : null;
}

function speechKind(p: Projection): 'lastwords' | 'campaign' | 'pk' | 'discussion' {
  const title = p.task?.title ?? '';
  if (title.includes('遗言')) return 'lastwords';
  if (title.includes('竞选')) return 'campaign';
  if (title.includes('PK')) return 'pk';
  return 'discussion';
}

function seerReport(k: Knowledge): string {
  if (!k.checks.length) return '我是预言家，还没有查验结果。';
  const lines = k.checks.map((c) => `第${c.night}夜查验 ${c.target}号，是${c.wolf ? '狼人' : '好人'}`);
  const wolf = k.checks.find((c) => c.wolf && k.alive.includes(c.target));
  return `我是预言家。${lines.join('；')}。${wolf ? `请大家跟我投 ${wolf.target}号。` : ''}`;
}

function speech(k: Knowledge, p: Projection, r: Rand): string {
  const kind = speechKind(p);
  const others = k.alive.filter((s) => s !== k.me);
  const suspect = () => {
    const pool = k.isWolf ? others.filter((s) => !k.wolves.includes(s)) : others.filter((s) => !cleared(k, s));
    return pool.length ? pick(r, pool) : null;
  };
  if (k.role === 'seer') return kind === 'pk' ? `${seerReport(k)}我是真预言家，请不要出我。` : seerReport(k);

  if (kind === 'campaign') {
    return pick(r, ['我上警，我是好人，拿到警徽我会认真归票。', '我是好人，想拿警徽带队，大家可以听听我的思路。', '上警是想多一个发言位，我会给出明确的站边。']);
  }
  if (kind === 'pk') return '我是好人，请大家不要出我，我的发言前后一致。';

  // 狼人在第一天有时悍跳预言家。
  const fakeClaim = k.isWolf && p.day === 1 && kind === 'discussion' && seeded(`${p.gameId}:${k.me}:claim`)() < 0.25;
  if (fakeClaim) {
    const t = suspect();
    if (t !== null) return `我是预言家。第1夜查验 ${t}号，是狼人。今天请大家跟我投 ${t}号。`;
  }
  if (kind === 'lastwords') {
    const t = suspect();
    return t === null ? '我是好人，出局了，大家加油。' : `我是好人，出局了。大家多注意 ${t}号。`;
  }
  if (!k.isWolf) {
    const accused = k.accused.filter((s) => s !== k.me && !cleared(k, s));
    if (accused.length) return `我是好人。场上有预言家报了查杀，我暂时相信这个查验，今天先出 ${last(accused)}号。`;
  } else {
    const seer = k.claimedSeers.find((s) => !k.wolves.includes(s));
    if (seer !== undefined) return `我是好人。${seer}号这个预言家我不认，像是悍跳，大家想清楚再投。`;
  }
  const t = suspect();
  const opener = pick(r, ['我说两句。', '听了前面的发言，', '简单聊一下。', '']);
  if (t === null) return `${opener}我是好人，暂时没有明确的怀疑对象。`;
  return `${opener}我是好人。${t}号的发言${pick(r, ['有点飘', '站边很奇怪', '没有给出有用的信息'])}，${pick(r, ['我先把他放进狼坑。', '大家可以多关注他。', '今天可以考虑他。'])}`;
}

function randomArgs(spec: ToolSpec, r: Rand): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const p of spec.params as ParamSpec[]) {
    switch (p.kind) {
      case 'seat':
        args[p.name] = p.options.length ? pick(r, p.options) : null;
        break;
      case 'seats':
        args[p.name] = [...p.options].sort(() => r() - 0.5).slice(0, p.min);
        break;
      case 'boolean':
        args[p.name] = r() < 0.5;
        break;
      case 'text':
        args[p.name] = p.minLength > 0 ? '好的。' : '';
        break;
      case 'choice':
        args[p.name] = pick(r, p.options).value;
        break;
    }
  }
  return args;
}

/** 用投影做出一次合法行动。行动必须合法，发言可以模板化。 */
function legacyMockDecision(p: Projection, tools: ToolSpec[]): ToolCall {
  const k = know(p);
  const r = seeded(`${p.gameId}:${p.task?.decisionId}:${k.me}:${p.version}`);
  const has = (name: string) => tools.find((t) => t.name === name);

  const speak = has('speak');
  if (speak) {
    if (has('wolf_explode') && r() < 0.02) return { tool: 'wolf_explode', args: {} };
    if (has('sheriff_withdraw') && k.role !== 'seer' && r() < 0.1) return { tool: 'sheriff_withdraw', args: { content: '' } };
    return { tool: 'speak', args: { content: speech(k, p, r) } };
  }

  const spec = tools[0];
  switch (spec.name) {
    case 'wolf_discuss': {
      const t = wolfTarget(k, p, k.alive);
      return { tool: spec.name, args: { content: t === null ? '今晚空刀吧。' : `今晚刀 ${t}号。` } };
    }
    case 'wolf_kill':
      return { tool: spec.name, args: { target: wolfTarget(k, p, optionsOf(spec, 'target')) } };
    case 'seer_inspect': {
      const options = optionsOf(spec, 'target');
      const fresh = options.filter((s) => !k.checks.some((c) => c.target === s));
      const claimers = k.claimedSeers.filter((s) => fresh.includes(s));
      return { tool: spec.name, args: { target: claimers.length ? claimers[0] : pick(r, fresh.length ? fresh : options) } };
    }
    case 'witch_act': {
      const canSave = spec.params.some((x) => x.name === 'save');
      const save = canSave && (p.day === 1 || (k.knife !== null && k.claimedSeers.includes(k.knife)) || r() < 0.4);
      const poisonOptions = optionsOf(spec, 'poisonTarget');
      const accused = k.accused.filter((s) => poisonOptions.includes(s));
      const poison = !save && accused.length && r() < 0.5 ? last(accused)! : null;
      return { tool: spec.name, args: { ...(canSave ? { save } : {}), poisonTarget: poison } };
    }
    case 'guard_protect': {
      const options = optionsOf(spec, 'target');
      const seer = k.claimedSeers.find((s) => s !== k.me && options.includes(s));
      if (seer !== undefined && r() < 0.7) return { tool: spec.name, args: { target: seer } };
      return { tool: spec.name, args: { target: r() < 0.3 || !options.length ? null : pick(r, options) } };
    }
    case 'hunter_shoot': {
      const options = optionsOf(spec, 'target');
      const accused = k.accused.filter((s) => options.includes(s) && !cleared(k, s));
      if (accused.length && r() < 0.8) return { tool: spec.name, args: { target: last(accused)! } };
      return { tool: spec.name, args: { target: r() < 0.4 && options.length ? pick(r, options) : null } };
    }
    case 'vote':
    case 'sheriff_vote': {
      const options = optionsOf(spec, 'target');
      const abstain = spec.params.some((p) => p.kind === 'seat' && p.name === 'target' && p.nullable);
      if (abstain && r() < 0.05) return { tool: spec.name, args: { target: null } };
      if (spec.name === 'sheriff_vote') {
        const preferred = k.isWolf ? options.filter((s) => k.wolves.includes(s)) : k.claimedSeers.filter((s) => options.includes(s));
        if (preferred.length && r() < 0.7) return { tool: spec.name, args: { target: pick(r, preferred) } };
      }
      return { tool: spec.name, args: { target: voteTarget(k, options, r) ?? (abstain ? null : options[0]) } };
    }
    case 'sheriff_signup':
      return { tool: spec.name, args: { run: r() < (k.role === 'seer' ? 0.8 : 0.3) } };
    case 'set_speak_direction':
      return { tool: spec.name, args: { direction: r() < 0.5 ? 'clockwise' : 'counterclockwise' } };
    case 'badge_dispose': {
      const options = optionsOf(spec, 'target');
      if (k.isWolf) {
        const mate = options.find((s) => k.wolves.includes(s));
        return { tool: spec.name, args: { target: mate ?? null } };
      }
      const trusted = options.filter((s) => !k.accused.includes(s));
      const seer = k.claimedSeers.find((s) => trusted.includes(s));
      return { tool: spec.name, args: { target: seer ?? (trusted.length ? pick(r, trusted) : null) } };
    }
    case 'wolf_explode_decision':
      return { tool: spec.name, args: { explode: r() < 0.02 } };
    default:
      return { tool: spec.name, args: randomArgs(spec, r) };
  }
}

export const mockAdapter: Adapter = {
  async decide(req: DecideRequest): Promise<DecideResult> {
    if (req.toolChoice === 'auto') {
      return { ok: true, assistant: { role: 'assistant', content: '' }, toolCallIds: [], latencyMs: 0 };
    }
    if (!req.projection) return { ok: false, error: '模拟玩家需要座位投影', toolCallIds: [], latencyMs: 0, fatal: true };
    const legal = req.projection.task && !req.projection.task.submitted ? req.projection.task.tools : req.tools;
    const call = mockDecision(req.projection, legal);
    return {
      ok: true,
      call,
      assistant: { role: 'assistant', content: JSON.stringify(call) },
      toolCallIds: [],
      latencyMs: 0,
    };
  },
};

export function mockDecision(p: Projection, tools: ToolSpec[]): ToolCall {
  if (!tools.some((t) => t.operation)) return legacyMockDecision(p, tools);
  const call = legacyMockDecision(p, simulationTools(tools));
  return exposeAction(call, tools);
}
