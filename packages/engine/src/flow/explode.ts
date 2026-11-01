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
            title: '是否自爆',
            description: resume ? '警长延期续选投票前，决定是否自爆。再次自爆则警徽流失，并取消当天剩余流程。' : '下一段发言开始前，决定是否自爆。自爆会立刻出局并公开狼人身份，当天剩余流程取消。',
            params: [{ kind: 'boolean', name: 'explode', label: '是否自爆', trueLabel: '自爆', falseLabel: '不自爆' }],
          },
        ],
        prompt: () => resume ? '警长延期续选即将直接投票，不再竞选发言。是否现在自爆？再次自爆将使警徽流失。' : '下一段发言即将开始。是否现在自爆？',
        title: `第${ctx.state.day}天 · 自爆询问`,
        publicStage: resume ? '警长续选：投票前确认' : ctx.state.stage,
        speechWindow: false,
      });
    },
    ack: (_c, _s, _seat, call) => (call.args.explode ? '你选择了自爆。' : '你选择不自爆。'),
    decide(ctx, _step, subs) {
      const choosers = Object.entries(subs)
        .filter(([, call]) => call.args.explode === true)
        .map(([seat]) => Number(seat))
        .sort((a, b) => a - b);
      if (!choosers.length) return;
      const [first, ...rest] = choosers;
      for (const r of rest) {
        ctx.priv([r], 'explode.preempted', `本次由座位号更小的${seatLabel(first)}执行自爆，你仍然存活。`, { by: first });
      }
      applyExplosion(ctx, first);
    },
    fallback: () => ({ tool: 'wolf_explode_decision', args: { explode: false } }),
  },
};

/** 自爆：立刻出局并公开狼人身份，取消当天剩余发言、竞选和放逐，然后按 警徽 → 遗言 → 胜负 处理。 */
export function applyExplosion(ctx: Ctx, seat: Seat): void {
  const s = ctx.state;
  const vote = s.agenda.find((x) => x.type === 'sheriff.vote');
  s.pending = null;
  s.agenda = s.agenda.filter((x) => !x.cancelOnExplode);
  const batch = ctx.newBatch();
  const p = ctx.player(seat);
  p.revealed = true;
  ctx.kill(seat, { via: 'explode', causes: ['explode'], batch });
  ctx.pub('explode', `${seatLabel(seat)}自爆出局。`, { seat, role: p.role, roleName: ctx.roleOf(seat).name });

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
        ? '首次警上自爆，竞选延期；下一白天先确认自爆并直接续投，不再竞选发言，警徽落地或再次自爆后才通报昨夜情况；再次竞选自爆则警徽流失。'
        : '首次警上自爆，竞选延期；下一白天公布昨夜情况后直接续投，不再竞选发言，再次竞选自爆则警徽流失。';
      ctx.pub('sheriff.postponed', policy === 'postpone_vote' ? postponedText : '警长竞选尚未结束有人自爆，竞选推迟到下一个白天。', {});
    } else {
      el.explosions += 1;
      el.status = 'done';
      el.postponed = false;
      delete el.postponedVote;
      ctx.pub('sheriff.lost', '警长竞选尚未产生警长时有人自爆，警徽流失，本局没有警长。', {});
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
