import type { Seat, ToolSpec } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { directionLabel, orderList, seatLabel, seatList } from '../text';
import { explodeTool, seatParam, speakTool, textParam } from '../tools';
import type { Direction, PendingDeaths, Step, StepHandler } from '../types';
import { applyExplosion, explodeOnOwnTurn } from './explode';
import { nextAlive, pkOrder, randomDirection, ringOrder, sheriffOrder } from './order';
import { describeTally, tally, tallyPayload, type Ballot } from './tally';

export type SpeechKind = 'discussion' | 'campaign' | 'pk' | 'sheriff_pk' | 'lastwords';

export const SPEECH_LABEL: Record<SpeechKind, string> = {
  discussion: '发言',
  campaign: '竞选发言',
  pk: 'PK发言',
  sheriff_pk: '竞选PK发言',
  lastwords: '遗言',
};

const withdrawTool: ToolSpec = {
  name: 'sheriff_withdraw',
  title: '退水',
  description: '退出警长竞选。可以附带一段公开发言，也可以留空。',
  params: [textParam('content', '退水时的发言（可留空）', 0, 400)],
};

/** 一段发言及其之前的自爆询问（仅「每段发言前询问」模式）。 */
export function speechSteps(ctx: Ctx, seat: Seat, kind: SpeechKind, extra: Record<string, unknown> = {}): Step[] {
  const steps: Step[] = [];
  const allowExplode = kind === 'lastwords' ? !!extra.allowExplode : true;
  const cancel = (extra.cancelOnExplode as boolean | undefined) ?? true;
  if (allowExplode && ctx.opt<string>('explode.window') === 'between_speeches') {
    steps.push({ type: 'explode.window', cancelOnExplode: cancel });
  }
  steps.push({ type: 'speech', seat, kind, ...extra, cancelOnExplode: cancel });
  return steps;
}

function speechPrompt(ctx: Ctx, seat: Seat, kind: SpeechKind): string {
  const s = ctx.state;
  switch (kind) {
    case 'discussion':
      return s.sheriff === seat
        ? '轮到你发言。你是警长，最后一个发言，可以在发言里归票。'
        : '轮到你发言。请分析局势、表明立场。';
    case 'campaign':
      return '轮到你竞选发言。你也可以选择退水（退出竞选）。';
    case 'sheriff_pk':
      return '竞选平票，你在 PK 台上，请发言争取警徽。';
    case 'pk':
      return '放逐投票平票，你在 PK 台上，请发言。';
    case 'lastwords':
      return '你已出局，请发表遗言。遗言公开给所有人。';
  }
}

export const daySteps: Record<string, StepHandler> = {
  'day.start': {
    run(ctx) {
      const s = ctx.state;
      s.phase = 'day';
      s.stage = `第${s.day}天`;
      ctx.pub('phase', `第${s.day}天，天亮了。`, { phase: 'day' });
      const el = s.election;
      const electionToday =
        ctx.opt<boolean>('sheriff.enabled') && el.status === 'pending' && (s.day === 1 || el.postponed);
      s.dayState.electionToday = electionToday;
      const steps: Step[] = [];
      const announce: Step = { type: 'dawn.announce' };
      const election: Step = { type: 'sheriff.election', cancelOnExplode: true };
      if (electionToday && ctx.opt<string>('sheriff.timing') === 'before_announcement') steps.push(election, announce);
      else {
        steps.push(announce);
        if (electionToday) steps.push(election);
      }
      steps.push({ type: 'day.discussion', cancelOnExplode: true }, { type: 'night.start' });
      ctx.pushFront(...steps);
    },
  },

  'dawn.announce': {
    run(ctx) {
      const s = ctx.state;
      const pd = s.pendingDeaths;
      s.pendingDeaths = null;
      s.stage = `第${s.day}天`;
      if (!pd || !pd.deaths.length) {
        s.dayState.anchor = null;
        ctx.pub('dawn', '昨夜平安，无人出局。', { deaths: [] });
        return;
      }
      const batch = ctx.newBatch();
      const seats = pd.deaths.map((d) => d.seat);
      for (const d of pd.deaths) ctx.kill(d.seat, { via: 'night', causes: d.causes, batch, day: pd.night });
      s.dayState.anchor = pickAnchor(ctx, pd);
      ctx.pub('dawn', `昨夜出局：${seatList(seats)}。`, { deaths: seats });
      ctx.pushFront({ type: 'deaths.batch', batch, mode: 'standard' });
    },
  },

  'day.discussion': {
    run(ctx, step) {
      const s = ctx.state;
      s.stage = `第${s.day}天 · 发言`;
      const sh = s.sheriff;
      if (sh !== null && ctx.isAlive(sh)) {
        const dirs: Direction[] = ['clockwise', 'counterclockwise'];
        const orders = dirs.map((d) => orderList(sheriffOrder(ctx, sh, d)));
        ctx.ask({
          step,
          actors: [sh],
          tools: () => [
            {
              name: 'set_speak_direction',
              title: '选择发言方向',
              description: '警长选择发言方向，从警长相邻的存活玩家开始，警长最后发言。',
              params: [
                {
                  kind: 'choice',
                  name: 'direction',
                  label: '发言方向',
                  options: [
                    { value: 'clockwise', label: '顺时针（号码增大）', hint: orders[0] },
                    { value: 'counterclockwise', label: '逆时针（号码减小）', hint: orders[1] },
                  ],
                },
              ],
            },
          ],
          prompt: () => `你是警长，请选择发言方向。顺时针顺序：${orders[0]}；逆时针顺序：${orders[1]}。`,
          title: `第${s.day}天 · 发言方向`,
          publicStage: `警长${seatLabel(sh)}选择发言方向`,
          publicActor: sh,
        });
        return;
      }
      const dir = randomDirection(ctx);
      const anchor = s.dayState.anchor;
      if (anchor !== null) {
        const first = nextAlive(ctx, anchor, dir) as Seat;
        startDiscussion(ctx, first, dir, `从${seatLabel(anchor)}的下一位开始，${directionLabel(dir)}`);
      } else {
        const first = ctx.pick(ctx.alive());
        startDiscussion(ctx, first, dir, `法官指定${seatLabel(first)}开始，${directionLabel(dir)}`);
      }
    },
    decide(ctx, _step, subs) {
      const sh = ctx.state.sheriff as Seat;
      const dir = subs[sh].args.direction as Direction;
      const first = nextAlive(ctx, sh, dir) ?? sh;
      startDiscussion(ctx, first, dir, `警长${seatLabel(sh)}选择${directionLabel(dir)}`);
    },
    fallback: () => ({ tool: 'set_speak_direction', args: { direction: 'clockwise' } }),
  },

  speech: {
    run(ctx, step) {
      const s = ctx.state;
      const seat = step.seat as Seat;
      const kind = step.kind as SpeechKind;
      if (kind !== 'lastwords' && !ctx.isAlive(seat)) return;
      if (kind === 'campaign' && (!s.election.candidates.includes(seat) || s.election.withdrawn.includes(seat))) return;
      const tools: ToolSpec[] = [speakTool(kind === 'lastwords' ? '发表遗言' : SPEECH_LABEL[kind])];
      if (kind === 'campaign') tools.push(withdrawTool);
      if (explodeOnOwnTurn(ctx, seat, kind)) tools.push(explodeTool);
      const label = SPEECH_LABEL[kind];
      ctx.ask({
        step,
        actors: [seat],
        tools: () => tools,
        prompt: () => speechPrompt(ctx, seat, kind),
        title: `第${s.day}天 · ${label}`,
        publicStage: `${seatLabel(seat)}${label}中`,
        publicActor: seat,
        speechWindow: kind === 'lastwords' ? !!step.allowExplode : true,
      });
    },
    decide(ctx, step, subs) {
      const seat = step.seat as Seat;
      const kind = step.kind as SpeechKind;
      const call = subs[seat];
      if (call.tool === 'wolf_explode') {
        applyExplosion(ctx, seat);
        return;
      }
      if (call.tool === 'sheriff_withdraw') {
        const content = String(call.args.content ?? '');
        ctx.state.election.withdrawn.push(seat);
        if (content) ctx.pub('speech', `${seatLabel(seat)}${SPEECH_LABEL[kind]}：${content}`, { seat, kind, content });
        ctx.pub('sheriff.withdraw', `${seatLabel(seat)}退水。`, { seat });
        return;
      }
      const content = String(call.args.content);
      ctx.pub('speech', `${seatLabel(seat)}${SPEECH_LABEL[kind]}：${content}`, { seat, kind, content });
    },
    fallback: () => ({ tool: 'speak', args: { content: '我这轮过。' } }),
  },

  'exile.vote': {
    run(ctx, step) {
      const s = ctx.state;
      const round = step.round as number;
      const candidates = (step.candidates as Seat[] | undefined) ?? null;
      s.stage = `第${s.day}天 · ${round === 1 ? '放逐投票' : 'PK 投票'}`;
      const voters = ctx.alive().filter((x) => ctx.canVote(x) && !(candidates ?? []).includes(x));
      if (!voters.length) {
        ctx.pub('vote.none', '没有可以投票的玩家，今天无人出局。', {});
        return;
      }
      const allowAbstain = ctx.opt<boolean>('vote.allowAbstain');
      const allowSelf = ctx.opt<boolean>('vote.allowSelf');
      const optionsFor = (voter: Seat) =>
        candidates ?? ctx.alive().filter((x) => allowSelf || x !== voter);
      ctx.ask({
        step,
        actors: voters,
        simultaneous: true,
        tools: (voter) => [
          {
            name: 'vote',
            title: round === 1 ? '放逐投票' : 'PK 投票',
            description: '同时秘密投票，票齐后公开谁投了谁。警长的票记 1.5 票。',
            params: [seatParam('target', '放逐目标', optionsFor(voter), allowAbstain ? '弃票' : undefined)],
          },
        ],
        prompt: () =>
          round === 1
            ? '请投票放逐一名玩家。票齐之前看不到别人的票。'
            : `请在 PK 的 ${seatList(candidates ?? [])} 中投票放逐一名玩家。`,
        title: `第${s.day}天 · ${round === 1 ? '放逐投票' : 'PK 投票'}`,
        publicStage: round === 1 ? '放逐投票中' : 'PK 投票中',
      });
    },
    ack: (_ctx, _step, _seat, call) =>
      call.args.target === null ? '你选择了弃票。' : `你投给了 ${seatLabel(call.args.target as Seat)}。`,
    decide(ctx, step, subs) {
      const s = ctx.state;
      const round = step.round as number;
      const normal = ctx.opt<number>('vote.normalWeight');
      const sheriffW = ctx.opt<number>('vote.sheriffWeight');
      const ballots: Ballot[] = Object.entries(subs)
        .map(([voter, call]) => {
          const v = Number(voter);
          const target = (call.args.target as Seat | null) ?? null;
          return { voter: v, target, weight: target === null ? 0 : v === s.sheriff ? sheriffW : normal };
        })
        .sort((a, b) => a.voter - b.voter);
      const t = tally(ballots);
      ctx.pub(
        'vote.result',
        `${round === 1 ? '放逐投票' : 'PK 投票'}结果：${describeTally(t, s.sheriff)}。`,
        tallyPayload('exile', round, t, s.sheriff),
      );
      if (!t.top.length) {
        ctx.pub('vote.none', '无人得票，今天无人出局（平安日）。', {});
        return;
      }
      if (t.top.length === 1) {
        ctx.pushFront({ type: 'exile.apply', seat: t.top[0], cancelOnExplode: true });
        return;
      }
      if (round === 1) {
        const order = pkOrder(ctx, t.top);
        ctx.pub('vote.pk', `${seatList(t.top)}平票，进入 PK。PK 发言顺序：${orderList(order)}。`, { seats: t.top, order });
        ctx.pushFront(
          ...order.flatMap((seat) => speechSteps(ctx, seat, 'pk')),
          { type: 'exile.vote', round: 2, candidates: t.top, cancelOnExplode: true },
        );
        return;
      }
      ctx.pub('vote.none', `${seatList(t.top)}再次平票，今天无人出局（平安日）。`, {});
    },
    fallback: () => ({ tool: 'vote', args: { target: null } }),
  },

  'exile.apply': {
    run(ctx, step) {
      const seat = step.seat as Seat;
      if (ctx.roleOf(seat).beforeExile?.(ctx, seat)) return;
      const batch = ctx.newBatch();
      ctx.kill(seat, { via: 'exile', causes: ['exile'], batch });
      ctx.pub('exile', `${seatLabel(seat)}被投票放逐。`, { seat });
      ctx.pushFront({ type: 'deaths.batch', batch, mode: 'standard' });
    },
  },
};

function startDiscussion(ctx: Ctx, first: Seat, dir: Direction, how: string): void {
  const s = ctx.state;
  const order = ringOrder(ctx.playerCount, first, dir, ctx.alive());
  s.dayState.direction = dir;
  s.dayState.firstSpeaker = first;
  ctx.pub('speech.order', `${how}。发言顺序：${orderList(order)}。`, { order, direction: dir, first });
  ctx.pushFront(
    ...order.flatMap((seat) => speechSteps(ctx, seat, 'discussion')),
    { type: 'exile.vote', round: 1, cancelOnExplode: true },
  );
}

/** 无警长时的死亡锚点。默认在多名出局者中随机取一名，避免从起点反推谁被刀、谁被毒。 */
function pickAnchor(ctx: Ctx, pd: PendingDeaths): Seat | null {
  const dead = pd.deaths.map((d) => d.seat);
  if (!dead.length) return null;
  if (dead.length === 1) return dead[0];
  if (ctx.opt<string>('speech.anchor') === 'knife_first') {
    if (pd.knife !== null && dead.includes(pd.knife)) return pd.knife;
    return dead[0];
  }
  const anchor = ctx.pick(dead);
  ctx.god('random.anchor', `随机发言锚点：${seatLabel(anchor)}`, { anchor });
  return anchor;
}
