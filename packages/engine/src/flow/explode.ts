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
      ctx.ask({
        step,
        actors: wolves,
        simultaneous: true,
        tools: () => [
          {
            name: 'wolf_explode_decision',
            title: '是否自爆',
            description: '下一段发言开始前，决定是否自爆。自爆会立刻出局并公开狼人身份，当天剩余流程取消。',
            params: [{ kind: 'boolean', name: 'explode', label: '是否自爆', trueLabel: '自爆', falseLabel: '不自爆' }],
          },
        ],
        prompt: () => '下一段发言即将开始。是否现在自爆？',
        title: `第${ctx.state.day}天 · 自爆询问`,
        publicStage: ctx.state.stage,
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
    if (ctx.opt<string>('sheriff.explodeInElection') === 'postpone' && el.explosions === 0) {
      el.explosions += 1;
      el.status = 'pending';
      el.postponed = true;
      el.postponedCandidates = el.candidates.length ? remaining : null;
      ctx.pub('sheriff.postponed', '警长竞选尚未结束有人自爆，竞选推迟到下一个白天。', {});
    } else {
      el.explosions += 1;
      el.status = 'done';
      el.postponed = false;
      ctx.pub('sheriff.lost', '警长竞选尚未产生警长时有人自爆，警徽流失，本局没有警长。', {});
    }
  }
  ctx.pushFront({ type: 'deaths.batch', batch, mode: 'explode' });
}
