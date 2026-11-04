import { gameText } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { seatLabel } from '../text';
import { explodeTool } from '../tools';
import type { InterruptDef, StepHandler } from '../types';
import type { SpeechKind } from './day';

function canExplodeNow(ctx: Ctx, seat: Seat): boolean {
  const s = ctx.state;
  return (
    ctx.opt<boolean>('explode.enabled') &&
    !s.result &&
    !s.ending &&
    s.phase === 'day' &&
    ctx.isAlive(seat) &&
    !!ctx.roleOf(seat).canExplode
  );
}

/** 「只能自己发言时」与「随时可爆」两种模式下，狼人轮到自己发言时可以直接选择自爆。 */
export function explodeOnOwnTurn(ctx: Ctx, seat: Seat, kind: SpeechKind): boolean {
  if (kind === 'lastwords') return false;
  const window = ctx.opt<string>('explode.window');
  return (window === 'speaker_only' || window === 'interrupt') && canExplodeNow(ctx, seat);
}

/** 「随时可爆」：发言类决策进行中，存活狼人不需要等待询问就能提交自爆。 */
export const explodeInterrupt: InterruptDef = {
  tool: 'wolf_explode',
  available(ctx, seat) {
    return (
      ctx.opt<string>('explode.window') === 'interrupt' &&
      !!ctx.state.pending?.speechWindow &&
      canExplodeNow(ctx, seat)
    );
  },
  spec: () => explodeTool,
  apply(ctx, seat) {
    applyExplosion(ctx, seat);
  },
};

export const explodeSteps: Record<string, StepHandler> = {
  /** 「每段发言前询问」：存活狼人同时决定是否自爆，多人选择时座位号最小者执行。 */
  'explode.window': {
    run(ctx, step) {
      if (!ctx.opt<boolean>('explode.enabled') || ctx.state.ending) return;
      const wolves = ctx.alive().filter((x) => canExplodeNow(ctx, x));
      if (!wolves.length) return;
      const resume = step.electionResume === true;
      ctx.ask({
        step,
        actors: wolves,
        simultaneous: true,
        tools: () => [
          {
            name: 'wolf_explode_decision',
            title: gameText(ctx.rules.locale, "是否自爆"),
            description: resume ? gameText(ctx.rules.locale, "警长延期续选投票前，决定是否自爆。再次自爆则警徽流失，并取消当天剩余流程。") : gameText(ctx.rules.locale, "下一段发言开始前，决定是否自爆。自爆会立刻出局并公开狼人身份，当天剩余流程取消。"),
            params: [{ kind: 'boolean', name: 'explode', label: gameText(ctx.rules.locale, "是否自爆"), trueLabel: gameText(ctx.rules.locale, "自爆"), falseLabel: gameText(ctx.rules.locale, "不自爆") }],
          },
        ],
        prompt: () => resume ? gameText(ctx.rules.locale, "警长延期续选即将直接投票，不再竞选发言。是否现在自爆？再次自爆将使警徽流失。") : gameText(ctx.rules.locale, "下一段发言即将开始。是否现在自爆？"),
        title: gameText(ctx.rules.locale, "第{0}天 · 自爆询问", ctx.state.day),
        publicStage: resume ? gameText(ctx.rules.locale, "警长续选：投票前确认") : ctx.state.stage,
        speechWindow: false,
      });
    },
    ack: (_c, _s, _seat, call) => (call.args.explode ? gameText(_c.rules.locale, "你选择了自爆。") : gameText(_c.rules.locale, "你选择不自爆。")),
    decide(ctx, _step, subs) {
      const choosers = Object.entries(subs)
        .filter(([, call]) => call.args.explode === true)
        .map(([seat]) => Number(seat))
        .sort((a, b) => a - b);
      if (!choosers.length) return;
      const [first, ...rest] = choosers;
      for (const r of rest) {
        ctx.priv([r], 'explode.preempted', gameText(ctx.rules.locale, "本次由座位号更小的{0}执行自爆，你仍然存活。", seatLabel(first, ctx.rules.locale)), { by: first });
      }
      applyExplosion(ctx, first);
    },
    fallback: (ctx) => ({ tool: 'wolf_explode_decision', args: { explode: false } }),
  },
  'sheriff.announcePostponement': {
    run(ctx, step) {
      ctx.pub('sheriff.postponed', step.text as string, {});
    },
  },
};

/** 自爆立即公开，出局、胜负和后续流程交由议程结算。 */
export function applyExplosion(ctx: Ctx, seat: Seat): void {
  const s = ctx.state;
  const vote = s.agenda.find((x) => x.type === 'sheriff.vote');
  s.pending = null;
  s.agenda = s.agenda.filter((x) => !x.cancelOnExplode);
  const batch = ctx.newBatch();
  const p = ctx.player(seat);
  p.revealed = true;
  ctx.kill(seat, { via: 'explode', causes: ['explode'], batch });
  ctx.pub('explode', gameText(ctx.rules.locale, "{0}自爆出局。", seatLabel(seat, ctx.rules.locale)), { seat, role: p.role, roleName: ctx.roleOf(seat).name });

  const el = s.election;
  if (ctx.opt<boolean>('sheriff.enabled') && s.dayState.electionToday && el.status !== 'done') {
    const remaining = el.candidates.filter((c) => c !== seat && !el.withdrawn.includes(c));
    const policy = ctx.opt<string>('sheriff.explodeInElection');
    if ((policy === 'postpone' || policy === 'postpone_vote') && el.explosions === 0) {
      el.explosions += 1;
      el.status = 'pending';
      el.postponed = true;
      el.postponedCandidates = el.candidates.length ? remaining : null;
      if (policy === 'postpone_vote' && el.candidates.length) {
        const round = vote?.round === 2 ? 2 : 1;
        el.postponedVote = { round, candidates: (round === 2 ? vote!.tied as Seat[] : remaining).filter((c) => c !== seat && !el.withdrawn.includes(c)) };
      }
      const postponedText = (s.rules.electionVersion ?? 1) >= 2
        ? gameText(ctx.rules.locale, "首次警上自爆，竞选延期；下一白天先确认自爆并直接续投，不再竞选发言，警徽落地或再次自爆后才通报昨夜情况；再次竞选自爆则警徽流失。")
        : gameText(ctx.rules.locale, "首次警上自爆，竞选延期；下一白天公布昨夜情况后直接续投，不再竞选发言，再次竞选自爆则警徽流失。");
      const text = policy === 'postpone_vote' ? postponedText : gameText(ctx.rules.locale, "警长竞选尚未结束有人自爆，竞选推迟到下一个白天。");
      if (s.rules.electionExplosionVersion === 2 && s.rules.deathResolutionVersion === 2) {
        // 等本次出局和仍待公告的夜间出局结算完毕。终局或再次自爆会移除此步骤。
        const dawnIndex = s.agenda.findIndex((step) => step.type === 'dawn.announce');
        s.agenda.splice(dawnIndex + 1, 0, { type: 'sheriff.announcePostponement', text, cancelOnExplode: true });
      } else {
        ctx.pub('sheriff.postponed', text, {});
      }
    } else {
      el.explosions += 1;
      el.status = 'done';
      el.postponed = false;
      delete el.postponedVote;
      ctx.pub('sheriff.lost', gameText(ctx.rules.locale, "警长竞选尚未产生警长时有人自爆，警徽流失，本局没有警长。"), {});
    }
  }
  // 新规则把尚未公布的夜间死亡合入同一批：先公布，再复用猎枪职责，最后处理遗言。
  if (ctx.opt<string>('sheriff.explodeInElection') === 'postpone_vote' && s.agenda.some((x) => x.type === 'dawn.announce')) {
    s.agenda = s.agenda.filter((x) => x.type !== 'dawn.announce');
    ctx.pushFront({ type: 'dawn.announce', batch, deathMode: 'explode', firstLastWords: seat });
    return;
  }
  ctx.pushFront({ type: 'deaths.batch', batch, mode: 'explode' });
}
