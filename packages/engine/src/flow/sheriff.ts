import type { Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { directionLabel, orderList, seatLabel, seatList } from '../text';
import { seatParam } from '../tools';
import type { StepHandler } from '../types';
import { speechSteps } from './day';
import { pkOrder, randomDirection, ringOrder } from './order';
import { describeTally, tally, tallyPayload, type Ballot, type Tally } from './tally';

function grantSheriff(ctx: Ctx, seat: Seat): void {
  const s = ctx.state;
  s.sheriff = seat;
  s.election.status = 'done';
  s.history.badge.push(`第${s.day}天 ${seatLabel(seat)}当选警长`);
}

function elect(ctx: Ctx, seat: Seat, note?: string): void {
  grantSheriff(ctx, seat);
  ctx.pub('sheriff.elected', `${note ? `${note}` : ''}${seatLabel(seat)}当选警长。`, { seat });
}

function closeElection(ctx: Ctx): void {
  ctx.state.election.status = 'done';
}

function noSheriff(ctx: Ctx, text: string): void {
  closeElection(ctx);
  ctx.pub('sheriff.none', text, {});
}

type SheriffVerdict =
  | { outcome: 'elected'; conclusion: string; seat: Seat }
  | { outcome: 'pk'; conclusion: string; seats: Seat[]; order: Seat[] }
  | { outcome: 'lost'; conclusion: string; seats?: Seat[] };

/** 票已经点完。先判定，再决定播什么。不在判定前单独播票型。 */
function judgeSheriffVote(ctx: Ctx, round: number, t: Tally): SheriffVerdict {
  if (t.top.length === 1) {
    const seat = t.top[0];
    return { outcome: 'elected', seat, conclusion: `${seatLabel(seat)}当选警长。` };
  }
  if (t.top.length > 1 && round === 1) {
    const order = pkOrder(ctx, t.top);
    return {
      outcome: 'pk',
      seats: t.top,
      order,
      conclusion: `${seatList(t.top)}平票，进入竞选 PK。发言顺序：${orderList(order)}。`,
    };
  }
  const again = t.top.length > 1 ? `${seatList(t.top)}再次平票，` : '';
  return { outcome: 'lost', seats: t.top.length > 1 ? t.top : undefined, conclusion: `${again}警徽流失，本局没有警长。` };
}

function startCampaign(ctx: Ctx): void {
  const s = ctx.state;
  const el = s.election;
  const cands = el.candidates.filter((c) => ctx.isAlive(c) && !el.withdrawn.includes(c));
  if (!cands.length) return noSheriff(ctx, '没有候选人，本局没有警长。');
  if (cands.length === 1) return elect(ctx, cands[0], '只有一名候选人，直接当选：');
  const first = ctx.pick(cands);
  const dir = randomDirection(ctx);
  const order = ringOrder(ctx.playerCount, first, dir, cands);
  s.dayState.direction = dir;
  s.dayState.firstSpeaker = first;
  ctx.pub('sheriff.order', `竞选发言从${seatLabel(first)}开始，${directionLabel(dir)}：${orderList(order)}。`, {
    order,
    direction: dir,
  });
  ctx.pushFront(
    ...order.flatMap((seat) => speechSteps(ctx, seat, 'campaign')),
    { type: 'sheriff.vote', round: 1, cancelOnExplode: true },
  );
}

export const sheriffSteps: Record<string, StepHandler> = {
  'sheriff.election': {
    run(ctx) {
      const s = ctx.state;
      const el = s.election;
      el.status = 'running';
      s.stage = `第${s.day}天 · 警长竞选`;
      if (el.postponed && ctx.opt<string>('sheriff.explodeInElection') === 'postpone_vote' && el.postponedVote) {
        const vote = el.postponedVote;
        const candidates = vote.candidates.filter((c) => ctx.isAlive(c) && !el.withdrawn.includes(c));
        el.postponed = false;
        el.postponedCandidates = null;
        delete el.postponedVote;
        ctx.pub('sheriff.resume', `延期竞选直接续投，不再竞选发言。${s.pendingDeaths ? '昨夜出局情况尚未公布；先完成警上环节，再通报。' : ''}候选人：${candidates.length ? seatList(candidates) : '无'}。`, {
          candidates, withdrawn: [...el.withdrawn], mode: 'vote', round: vote.round,
        });
        if (!candidates.length) return noSheriff(ctx, '续选候选人均已出局或退水，本局没有警长。');
        ctx.pushFront(
          { type: 'explode.window', electionResume: true, cancelOnExplode: true },
          { type: 'sheriff.vote', round: vote.round, ...(vote.round === 2 ? { tied: candidates } : {}), cancelOnExplode: true },
        );
        return;
      }
      el.withdrawn = [];
      if (el.postponed && el.postponedCandidates) {
        el.candidates = el.postponedCandidates.filter((c) => ctx.isAlive(c));
        el.postponed = false;
        el.postponedCandidates = null;
        ctx.pub('sheriff.resume', `继续警长竞选，候选人：${el.candidates.length ? seatList(el.candidates) : '无'}。`, {
          candidates: el.candidates,
        });
        startCampaign(ctx);
        return;
      }
      el.postponed = false;
      el.candidates = [];
      ctx.pub('sheriff.start', '开始竞选警长。' + (s.pendingDeaths ? `${s.rules.electionVersion === 2 ? '昨夜' : '首夜'}出局情况尚未公布，将在竞选结束或自爆中断后通报；尚未通报不代表平安夜。` : ''), {});
      ctx.pushFront({ type: 'sheriff.signup', cancelOnExplode: true });
    },
  },

  'sheriff.signup': {
    run(ctx, step) {
      ctx.ask({
        step,
        actors: ctx.alive(),
        simultaneous: true,
        tools: () => [
          {
            name: 'sheriff_signup',
            title: '上警',
            description: '同时选择是否竞选警长。全部提交后公开谁上警。',
            params: [{ kind: 'boolean', name: 'run', label: '是否上警', trueLabel: '上警', falseLabel: '不上警' }],
          },
        ],
        prompt: () => '是否上警竞选警长？警长放逐投票记 1.5 票，并决定白天发言方向。',
        title: `第${ctx.state.day}天 · 上警`,
        publicStage: '警长竞选：上警',
      });
    },
    ack: (_c, _s, _seat, call) => (call.args.run ? '你选择了上警。' : '你选择不上警。'),
    decide(ctx, _step, subs) {
      const all = Object.keys(subs).map(Number).sort((a, b) => a - b);
      const cands = all.filter((x) => subs[x].args.run === true);
      if (!cands.length) return noSheriff(ctx, '无人上警，本局没有警长。');
      ctx.state.election.candidates = cands;
      if (cands.length === all.length) {
        ctx.pub('sheriff.signup', `全员上警：${seatList(cands)}。`, { candidates: cands });
        return noSheriff(ctx, '全员上警，没有警下玩家投票，本局没有警长。');
      }
      const others = all.filter((x) => !cands.includes(x));
      ctx.pub('sheriff.signup', `上警：${seatList(cands)}；警下：${seatList(others)}。`, { candidates: cands });
      startCampaign(ctx);
    },
    fallback: () => ({ tool: 'sheriff_signup', args: { run: false } }),
  },

  'sheriff.vote': {
    run(ctx, step) {
      const s = ctx.state;
      const el = s.election;
      const round = step.round as number;
      const pool = (round === 1 ? el.candidates : (step.tied as Seat[])).filter(
        (c) => ctx.isAlive(c) && !el.withdrawn.includes(c),
      );
      if (!pool.length) return noSheriff(ctx, '候选人全部退水，本局没有警长。');
      if (pool.length === 1) return elect(ctx, pool[0], '其余候选人已退水：');
      const withdrawnVote = ctx.opt<boolean>('sheriff.withdrawnCanVote');
      const voters =
        round === 1
          ? ctx.alive().filter((x) => !el.candidates.includes(x) || (withdrawnVote && el.withdrawn.includes(x)))
          : ctx.alive().filter((x) => !pool.includes(x));
      if (!voters.length) {
        return noSheriff(ctx, round === 1 ? '没有可以投票的警下玩家，本局没有警长。' : '没有可以投票的玩家，本局没有警长。');
      }
      const allowAbstain = ctx.opt<boolean>('vote.allowAbstain');
      ctx.ask({
        step,
        actors: voters,
        simultaneous: true,
        tools: () => [
          {
            name: 'sheriff_vote',
            title: round === 1 ? '警长投票' : '警长 PK 投票',
            description:
              round === 1
                ? '同时秘密投票选警长，每人 1 票，票齐后公开。'
                : '在平票的候选人中再投一次。除仍在平票台上的玩家外，其余存活玩家都可以投票。每人 1 票，票齐后公开。',
            params: [seatParam('target', '投给', pool, allowAbstain ? '弃票' : undefined)],
          },
        ],
        prompt: () =>
          round === 1
            ? `请在候选人 ${seatList(pool)} 中投票选出警长。`
            : `请在平票的 ${seatList(pool)} 中再投一次。除平票台上的玩家外，其余存活玩家都可以投票。`,
        title: `第${s.day}天 · ${round === 1 ? '警长投票' : '警长 PK 投票'}`,
        publicStage: round === 1 ? '警长投票中' : '警长 PK 投票中',
        hear: 'public',
      });
    },
    ack: (_c, _s, _seat, call) =>
      call.args.target === null ? '你选择了弃票。' : `你投给了 ${seatLabel(call.args.target as Seat)}。`,
    decide(ctx, step, subs) {
      const round = step.round as number;
      const normal = ctx.opt<number>('vote.normalWeight');
      const ballots: Ballot[] = Object.entries(subs)
        .map(([voter, call]) => {
          const target = (call.args.target as Seat | null) ?? null;
          return { voter: Number(voter), target, weight: target === null ? 0 : normal };
        })
        .sort((a, b) => a.voter - b.voter);
      const t = tally(ballots);
      const verdict = judgeSheriffVote(ctx, round, t);
      if (verdict.outcome === 'elected') grantSheriff(ctx, verdict.seat);
      else if (verdict.outcome === 'pk') {
        ctx.pushFront(
          ...verdict.order.flatMap((seat) => speechSteps(ctx, seat, 'sheriff_pk')),
          { type: 'sheriff.vote', round: 2, tied: verdict.seats, cancelOnExplode: true },
        );
      } else closeElection(ctx);
      const label = round === 1 ? '警长投票' : '警长 PK 投票';
      ctx.pub('vote.result', `${label}结果：${describeTally(t, null)}。${verdict.conclusion}`, {
        ...tallyPayload('sheriff', round, t, null),
        outcome: verdict.outcome,
        conclusion: verdict.conclusion,
        ...(verdict.outcome === 'elected' ? { seat: verdict.seat } : {}),
        ...(verdict.outcome === 'pk' ? { seats: verdict.seats, order: verdict.order } : {}),
        ...(verdict.outcome === 'lost' && verdict.seats ? { seats: verdict.seats } : {}),
      });
    },
    fallback: () => ({ tool: 'sheriff_vote', args: { target: null } }),
  },
};
