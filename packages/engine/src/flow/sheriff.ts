import type { Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { directionLabel, orderList, seatLabel, seatList } from '../text';
import { seatParam } from '../tools';
import type { StepHandler } from '../types';
import { speechSteps } from './day';
import { pkOrder, randomDirection, ringOrder } from './order';
import { describeTally, tally, tallyPayload, type Ballot } from './tally';

function elect(ctx: Ctx, seat: Seat, note?: string): void {
  const s = ctx.state;
  s.sheriff = seat;
  s.election.status = 'done';
  s.history.badge.push(`第${s.day}天 ${seatLabel(seat)}当选警长`);
  ctx.pub('sheriff.elected', `${note ? `${note}` : ''}${seatLabel(seat)}当选警长。`, { seat });
}

function noSheriff(ctx: Ctx, text: string): void {
  ctx.state.election.status = 'done';
  ctx.pub('sheriff.none', text, {});
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
      el.withdrawn = [];
      s.stage = `第${s.day}天 · 警长竞选`;
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
      ctx.pub('sheriff.start', '开始竞选警长。', {});
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
      const voters = ctx
        .alive()
        .filter((x) => !el.candidates.includes(x) || (withdrawnVote && el.withdrawn.includes(x)));
      if (!voters.length) return noSheriff(ctx, '没有可以投票的警下玩家，本局没有警长。');
      const allowAbstain = ctx.opt<boolean>('vote.allowAbstain');
      ctx.ask({
        step,
        actors: voters,
        simultaneous: true,
        tools: () => [
          {
            name: 'sheriff_vote',
            title: round === 1 ? '警长投票' : '警长 PK 投票',
            description: '同时秘密投票选警长，每人 1 票，票齐后公开。',
            params: [seatParam('target', '投给', pool, allowAbstain ? '弃票' : undefined)],
          },
        ],
        prompt: () => `请在候选人 ${seatList(pool)} 中投票选出警长。`,
        title: `第${s.day}天 · ${round === 1 ? '警长投票' : '警长 PK 投票'}`,
        publicStage: round === 1 ? '警长投票中' : '警长 PK 投票中',
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
      ctx.pub(
        'vote.result',
        `${round === 1 ? '警长投票' : '警长 PK 投票'}结果：${describeTally(t, null)}。`,
        tallyPayload('sheriff', round, t, null),
      );
      if (!t.top.length) return noSheriff(ctx, '无人投票，本局没有警长。');
      if (t.top.length === 1) return elect(ctx, t.top[0]);
      if (round === 1) {
        const order = pkOrder(ctx, t.top);
        ctx.pub('sheriff.pk', `${seatList(t.top)}平票，进入竞选 PK。发言顺序：${orderList(order)}。`, {
          seats: t.top,
          order,
        });
        ctx.pushFront(
          ...order.flatMap((seat) => speechSteps(ctx, seat, 'sheriff_pk')),
          { type: 'sheriff.vote', round: 2, tied: t.top, cancelOnExplode: true },
        );
        return;
      }
      noSheriff(ctx, `${seatList(t.top)}再次平票，本局没有警长。`);
    },
    fallback: () => ({ tool: 'sheriff_vote', args: { target: null } }),
  },
};
