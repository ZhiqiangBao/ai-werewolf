import { gameText } from '@werewolf/protocol';
import type { Seat, ToolSpec } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { directionLabel, orderList, seatLabel, seatList } from '../text';
import { seatParam } from '../tools';
import type { InterruptDef, StepHandler } from '../types';
import { speechSteps } from './day';
import { pkOrder, randomDirection, ringOrder } from './order';
import { describeTally, tally, tallyPayload, type Ballot, type Tally } from './tally';

const silentWithdraw: ToolSpec = {
  name: 'sheriff_withdraw', title: '退水',
  description: '退出警长竞选。当前不是你的竞选发言，不能附带发言，填写 {"content":""}。',
  params: [{ kind: 'text', name: 'content', label: '留空', minLength: 0, maxLength: 0 }],
};
const stayTool: ToolSpec = {
  name: 'sheriff_stay', title: '继续竞选',
  description: '竞选发言结束后的最终确认：保留候选资格。没有参数，填写 {}。', params: [],
};

function withdraw(ctx: Ctx, seat: Seat): void {
  ctx.state.election.withdrawn.push(seat);
  ctx.pub('sheriff.withdraw', gameText(ctx.rules.locale, "{0}退水。", seatLabel(seat, ctx.rules.locale)), { seat });
}

/** 不打断其他人的发言，也不把口头声明当作行动。 */
export const withdrawInterrupt: InterruptDef = {
  tool: 'sheriff_withdraw',
  available(ctx, seat) {
    const s = ctx.state;
    return s.rules.electionVersion === 3 && !s.result && !s.ending && ctx.isAlive(seat)
      && s.election.status === 'running' && s.election.candidates.includes(seat)
      && !s.election.withdrawn.includes(seat)
      && s.pending?.step.type === 'speech' && s.pending.step.kind === 'campaign'
      && s.pending.step.seat !== seat;
  },
  spec: () => silentWithdraw,
  apply: withdraw,
};

function grantSheriff(ctx: Ctx, seat: Seat): void {
  const s = ctx.state;
  s.sheriff = seat;
  s.election.status = 'done';
  s.history.badge.push(gameText(ctx.rules.locale, "第{0}天 {1}当选警长", s.day, seatLabel(seat, ctx.rules.locale)));
}

function elect(ctx: Ctx, seat: Seat, note?: string): void {
  grantSheriff(ctx, seat);
  ctx.pub('sheriff.elected', gameText(ctx.rules.locale, "{0}{1}当选警长。", note ? `${note}` : '', seatLabel(seat, ctx.rules.locale)), { seat });
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
    return { outcome: 'elected', seat, conclusion: gameText(ctx.rules.locale, "{0}当选警长。", seatLabel(seat, ctx.rules.locale)) };
  }
  if (t.top.length > 1 && round === 1) {
    const order = pkOrder(ctx, t.top);
    return {
      outcome: 'pk',
      seats: t.top,
      order,
      conclusion: gameText(ctx.rules.locale, "{0}平票，进入竞选 PK。发言顺序：{1}。", seatList(t.top, ctx.rules.locale), orderList(order, ctx.rules.locale)),
    };
  }
  const again = t.top.length > 1 ? gameText(ctx.rules.locale, "{0}再次平票，", seatList(t.top, ctx.rules.locale)) : '';
  return { outcome: 'lost', seats: t.top.length > 1 ? t.top : undefined, conclusion: gameText(ctx.rules.locale, "{0}警徽流失，本局没有警长。", again) };
}

function startCampaign(ctx: Ctx): void {
  const s = ctx.state;
  const el = s.election;
  const cands = el.candidates.filter((c) => ctx.isAlive(c) && !el.withdrawn.includes(c));
  if (!cands.length) return noSheriff(ctx, gameText(ctx.rules.locale, "没有候选人，本局没有警长。"));
  if (cands.length === 1) return elect(ctx, cands[0], gameText(ctx.rules.locale, "只有一名候选人，直接当选："));
  const first = ctx.pick(cands);
  const dir = randomDirection(ctx);
  const order = ringOrder(ctx.playerCount, first, dir, cands);
  s.dayState.direction = dir;
  s.dayState.firstSpeaker = first;
  ctx.pub('sheriff.order', gameText(ctx.rules.locale, "竞选发言从{0}开始，{1}：{2}。", seatLabel(first, ctx.rules.locale), directionLabel(dir, ctx.rules.locale), orderList(order, ctx.rules.locale)), {
    order,
    direction: dir,
  });
  ctx.pushFront(
    ...order.flatMap((seat) => speechSteps(ctx, seat, 'campaign')),
    ...(s.rules.electionVersion === 3 ? [{ type: 'sheriff.withdraw', cancelOnExplode: true }] : []),
    { type: 'sheriff.vote', round: 1, cancelOnExplode: true },
  );
}

export const sheriffSteps: Record<string, StepHandler> = {
  'sheriff.election': {
    run(ctx) {
      const s = ctx.state;
      const el = s.election;
      el.status = 'running';
      s.stage = gameText(ctx.rules.locale, "第{0}天 · 警长竞选", s.day);
      if (el.postponed && ctx.opt<string>('sheriff.explodeInElection') === 'postpone_vote' && el.postponedVote) {
        const vote = el.postponedVote;
        const candidates = vote.candidates.filter((c) => ctx.isAlive(c) && !el.withdrawn.includes(c));
        el.postponed = false;
        el.postponedCandidates = null;
        delete el.postponedVote;
        ctx.pub('sheriff.resume', gameText(ctx.rules.locale, "延期竞选直接续投，不再竞选发言。{0}候选人：{1}。", s.pendingDeaths ? gameText(ctx.rules.locale, "昨夜出局情况尚未公布；先完成警上环节，再通报。") : '', candidates.length ? seatList(candidates, ctx.rules.locale) : gameText(ctx.rules.locale, "无")), {
          candidates, withdrawn: [...el.withdrawn], mode: 'vote', round: vote.round,
        });
        if (!candidates.length) return noSheriff(ctx, gameText(ctx.rules.locale, "续选候选人均已出局或退水，本局没有警长。"));
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
        ctx.pub('sheriff.resume', gameText(ctx.rules.locale, "继续警长竞选，候选人：{0}。", el.candidates.length ? seatList(el.candidates, ctx.rules.locale) : gameText(ctx.rules.locale, "无")), {
          candidates: el.candidates,
        });
        startCampaign(ctx);
        return;
      }
      el.postponed = false;
      el.candidates = [];
      ctx.pub('sheriff.start', gameText(ctx.rules.locale, "开始竞选警长。") + (s.pendingDeaths ? gameText(ctx.rules.locale, "{0}出局情况尚未公布，将在竞选结束或自爆中断后通报；尚未通报不代表平安夜。", (s.rules.electionVersion ?? 1) >= 2 ? gameText(ctx.rules.locale, "昨夜") : gameText(ctx.rules.locale, "首夜")) : ''), {});
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
            title: gameText(ctx.rules.locale, "上警"),
            description: gameText(ctx.rules.locale, "同时选择是否竞选警长。全部提交后公开谁上警。"),
            params: [{ kind: 'boolean', name: 'run', label: gameText(ctx.rules.locale, "是否上警"), trueLabel: gameText(ctx.rules.locale, "上警"), falseLabel: gameText(ctx.rules.locale, "不上警") }],
          },
        ],
        prompt: () => gameText(ctx.rules.locale, "是否上警竞选警长？警长放逐投票记 1.5 票，并决定白天发言方向。"),
        title: gameText(ctx.rules.locale, "第{0}天 · 上警", ctx.state.day),
        publicStage: gameText(ctx.rules.locale, "警长竞选：上警"),
      });
    },
    ack: (_c, _s, _seat, call) => (call.args.run ? gameText(_c.rules.locale, "你选择了上警。") : gameText(_c.rules.locale, "你选择不上警。")),
    decide(ctx, _step, subs) {
      const all = Object.keys(subs).map(Number).sort((a, b) => a - b);
      const cands = all.filter((x) => subs[x].args.run === true);
      if (!cands.length) return noSheriff(ctx, gameText(ctx.rules.locale, "无人上警，本局没有警长。"));
      ctx.state.election.candidates = cands;
      if (cands.length === all.length) {
        ctx.pub('sheriff.signup', gameText(ctx.rules.locale, "全员上警：{0}。", seatList(cands, ctx.rules.locale)), { candidates: cands });
        return noSheriff(ctx, gameText(ctx.rules.locale, "全员上警，没有警下玩家投票，本局没有警长。"));
      }
      const others = all.filter((x) => !cands.includes(x));
      ctx.pub('sheriff.signup', gameText(ctx.rules.locale, "上警：{0}；警下：{1}。", seatList(cands, ctx.rules.locale), seatList(others, ctx.rules.locale)), { candidates: cands });
      startCampaign(ctx);
    },
    fallback: (ctx) => ({ tool: 'sheriff_signup', args: { run: false } }),
  },

  'sheriff.withdraw': {
    run(ctx, step) {
      const el = ctx.state.election;
      const actors = el.candidates.filter((c) => ctx.isAlive(c) && !el.withdrawn.includes(c));
      if (!actors.length) return;
      ctx.pub('sheriff.withdraw.window', gameText(ctx.rules.locale, "竞选发言结束，候选人同时确认继续竞选或退水；全部确认后公布退水并开始警长投票。"), {});
      ctx.ask({
        step, actors, simultaneous: true,
        tools: () => [stayTool, silentWithdraw],
        prompt: () => gameText(ctx.rules.locale, "警长投票尚未开始。请最终确认继续竞选或退水；此处不再发言。全部确认后才开放投票，超时默认继续竞选。"),
        title: gameText(ctx.rules.locale, "第{0}天 · 退水确认", ctx.state.day), publicStage: gameText(ctx.rules.locale, "警长竞选：投票前退水确认"), hear: 'actors',
      });
    },
    ack: (_c, _s, _seat, call) => call.tool === 'sheriff_withdraw' ? gameText(_c.rules.locale, "你已确认退水，全部确认后公布。") : gameText(_c.rules.locale, "你已确认继续竞选。"),
    decide(ctx, _step, subs) {
      for (const seat of Object.keys(subs).map(Number).sort((a, b) => a - b)) {
        if (subs[seat].tool === 'sheriff_withdraw') withdraw(ctx, seat);
      }
    },
    fallback: (ctx) => ({ tool: 'sheriff_stay', args: {} }),
  },

  'sheriff.vote': {
    run(ctx, step) {
      const s = ctx.state;
      const el = s.election;
      const round = step.round as number;
      const pool = (round === 1 ? el.candidates : (step.tied as Seat[])).filter(
        (c) => ctx.isAlive(c) && !el.withdrawn.includes(c),
      );
      if (!pool.length) return noSheriff(ctx, gameText(ctx.rules.locale, "候选人全部退水，本局没有警长。"));
      if (pool.length === 1) return elect(ctx, pool[0], gameText(ctx.rules.locale, "其余候选人已退水："));
      const withdrawnVote = ctx.opt<boolean>('sheriff.withdrawnCanVote');
      const voters =
        round === 1
          ? ctx.alive().filter((x) => !el.candidates.includes(x) || (withdrawnVote && el.withdrawn.includes(x)))
          : ctx.alive().filter((x) => !pool.includes(x));
      if (!voters.length) {
        return noSheriff(ctx, round === 1 ? gameText(ctx.rules.locale, "没有可以投票的警下玩家，本局没有警长。") : gameText(ctx.rules.locale, "没有可以投票的玩家，本局没有警长。"));
      }
      const allowAbstain = ctx.opt<boolean>('vote.allowAbstain');
      ctx.ask({
        step,
        actors: voters,
        simultaneous: true,
        tools: () => [
          {
            name: 'sheriff_vote',
            title: round === 1 ? gameText(ctx.rules.locale, "警长投票") : gameText(ctx.rules.locale, "警长 PK 投票"),
            description:
              round === 1
                ? gameText(ctx.rules.locale, "同时秘密投票选警长，每人 1 票，票齐后公开。")
                : gameText(ctx.rules.locale, "在平票的候选人中再投一次。除仍在平票台上的玩家外，其余存活玩家都可以投票。每人 1 票，票齐后公开。"),
            params: [seatParam('target', gameText(ctx.rules.locale, "投给"), pool, allowAbstain ? gameText(ctx.rules.locale, "弃票") : undefined)],
          },
        ],
        prompt: () =>
          round === 1
            ? gameText(ctx.rules.locale, "请在候选人 {0} 中投票选出警长。", seatList(pool, ctx.rules.locale))
            : gameText(ctx.rules.locale, "请在平票的 {0} 中再投一次。除平票台上的玩家外，其余存活玩家都可以投票。", seatList(pool, ctx.rules.locale)),
        title: gameText(ctx.rules.locale, "第{0}天 · {1}", s.day, round === 1 ? gameText(ctx.rules.locale, "警长投票") : gameText(ctx.rules.locale, "警长 PK 投票")),
        publicStage: round === 1 ? gameText(ctx.rules.locale, "警长投票中") : gameText(ctx.rules.locale, "警长 PK 投票中"),
        hear: 'public',
      });
    },
    ack: (_c, _s, _seat, call) =>
      call.args.target === null ? gameText(_c.rules.locale, "你选择了弃票。") : gameText(_c.rules.locale, "你投给了 {0}。", seatLabel(call.args.target as Seat, _c.rules.locale)),
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
      const label = round === 1 ? gameText(ctx.rules.locale, "警长投票") : gameText(ctx.rules.locale, "警长 PK 投票");
      ctx.pub('vote.result', gameText(ctx.rules.locale, "{0}结果：{1}。{2}", label, describeTally(t, null, ctx.rules.locale), verdict.conclusion), {
        ...tallyPayload('sheriff', round, t, null),
        outcome: verdict.outcome,
        conclusion: verdict.conclusion,
        ...(verdict.outcome === 'elected' ? { seat: verdict.seat } : {}),
        ...(verdict.outcome === 'pk' ? { seats: verdict.seats, order: verdict.order } : {}),
        ...(verdict.outcome === 'lost' && verdict.seats ? { seats: verdict.seats } : {}),
      });
    },
    fallback: (ctx) => ({ tool: 'sheriff_vote', args: { target: null } }),
  },
};
