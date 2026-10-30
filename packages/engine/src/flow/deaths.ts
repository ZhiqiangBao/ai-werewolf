import type { Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { seatLabel } from '../text';
import { seatParam } from '../tools';
import type { Step, StepHandler } from '../types';
import { speechSteps } from './day';
import { evaluateWin } from './win';

/**
 * 一批死亡的统一处理：先执行各身份的出局职责（例如猎人开枪，可能追加新的死亡），
 * 再按顺序走 胜负检查 → 警徽 → 遗言。自爆批次的顺序是 警徽 → 遗言 → 胜负检查。
 */
export const deathSteps: Record<string, StepHandler> = {
  'deaths.batch': {
    run(ctx, step) {
      const batch = step.batch as number;
      const fresh = ctx.state.deaths.filter((d) => d.batch === batch && !d.hooked).sort((a, b) => a.seat - b.seat);
      if (fresh.length) {
        const duties: Step[] = [];
        for (const d of fresh) {
          d.hooked = true;
          duties.push(...(ctx.roleOf(d.seat).onDeath?.(ctx, d) ?? []));
        }
        ctx.pushFront(...duties, step);
        return;
      }
      if (step.mode === 'explode') {
        ctx.pushFront(
          { type: 'badge.duty', batch },
          { type: 'lastwords', batch, allowExplode: false },
          { type: 'win.check', batch },
        );
      } else {
        ctx.pushFront(
          { type: 'win.check', batch },
          { type: 'badge.duty', batch },
          { type: 'lastwords', batch, allowExplode: true },
        );
      }
    },
  },

  'win.check': {
    run(ctx, step) {
      const result = evaluateWin(ctx);
      if (!result) return;
      const s = ctx.state;
      s.ending = true;
      s.agenda = s.agenda
        .filter((x) => x.type === 'lastwords' && x.batch === step.batch)
        .map((x) => ({ ...x, allowExplode: false }));
      s.agenda.push({ type: 'game.end', winner: result.winner, reason: result.reason });
      const pendingWords = ctx.state.deaths.some((d) => d.batch === step.batch && d.lastWords) && s.agenda.length > 1;
      ctx.pub('game.decided', pendingWords ? '胜负已分。有遗言的玩家发表遗言后公布结果。' : '胜负已分。', {});
    },
  },

  'badge.duty': {
    run(ctx, step) {
      const s = ctx.state;
      const sheriff = s.sheriff;
      if (sheriff === null || s.ending) return;
      if (!s.deaths.some((d) => d.batch === step.batch && d.seat === sheriff)) return;
      const targets = ctx.alive().filter((x) => x !== sheriff);
      if (!targets.length) {
        tearBadge(ctx, sheriff);
        return;
      }
      ctx.ask({
        step,
        actors: [sheriff],
        tools: () => [
          {
            name: 'badge_dispose',
            title: '处理警徽',
            description: '你已出局。把警徽移交给一名存活玩家，或撕毁警徽。',
            params: [seatParam('target', '移交给', targets, '撕毁警徽')],
          },
        ],
        prompt: () => '你是警长并且已经出局。请把警徽移交给一名存活玩家，或者撕毁警徽。移交不限阵营，不能移交给自己。',
        title: `第${s.day}天 · 警徽`,
        publicStage: `${seatLabel(sheriff)}处理警徽`,
        publicActor: sheriff,
      });
    },
    decide(ctx, _step, subs) {
      const sheriff = ctx.state.sheriff as Seat;
      const target = subs[sheriff].args.target as Seat | null;
      if (target === null) tearBadge(ctx, sheriff);
      else {
        ctx.state.sheriff = target;
        ctx.state.history.badge.push(`第${ctx.state.day}天 ${seatLabel(sheriff)}将警徽移交给${seatLabel(target)}`);
        ctx.pub('badge.transfer', `${seatLabel(sheriff)}将警徽移交给${seatLabel(target)}。`, { from: sheriff, to: target });
      }
    },
    fallback: () => ({ tool: 'badge_dispose', args: { target: null } }),
  },

  lastwords: {
    run(ctx, step) {
      const batch = step.batch as number;
      const seats = ctx.state.deaths
        .filter((d) => d.batch === batch && d.lastWords)
        .map((d) => d.seat)
        .sort((a, b) => a - b);
      const allowExplode = !!step.allowExplode && !ctx.state.ending;
      const steps: Step[] = [];
      for (const seat of seats) {
        steps.push(...speechSteps(ctx, seat, 'lastwords', { allowExplode, cancelOnExplode: allowExplode }));
      }
      ctx.pushFront(...steps);
    },
  },

  'game.end': {
    run(ctx, step) {
      const s = ctx.state;
      const winner = step.winner as string;
      const winnerName = winner === 'good' ? '好人阵营' : winner === 'wolf' ? '狼人阵营' : '无人';
      const reason = step.reason as string;
      s.phase = 'end';
      s.stage = '游戏结束';
      s.ending = false;
      s.agenda = [];
      s.pending = null;
      s.result = { winner, winnerName, reason };
      ctx.pub(
        'game.end',
        winner === 'draw' ? `游戏结束：流局。${reason}` : `游戏结束：${winnerName}获胜。${reason}`,
        { result: s.result },
      );
      const review = buildReview(ctx);
      ctx.pub('review', review.text, review.payload);
    },
  },
};

export function tearBadge(ctx: Ctx, sheriff: Seat): void {
  ctx.state.sheriff = null;
  ctx.state.history.badge.push(`第${ctx.state.day}天 ${seatLabel(sheriff)}撕毁警徽`);
  ctx.pub('badge.tear', `${seatLabel(sheriff)}撕毁了警徽，本局不再有警长。`, { from: sheriff });
}

function buildReview(ctx: Ctx) {
  const s = ctx.state;
  const roles = s.players.map((p) => ({ seat: p.seat, role: p.role, roleName: ctx.roleOf(p.seat).name, alive: p.alive }));
  const lines: string[] = ['【终局复盘】'];
  lines.push(`身份：${roles.map((r) => `${seatLabel(r.seat)}${r.roleName}`).join('，')}。`);
  for (const n of s.history.nights) lines.push(`第${n.n}夜：${n.lines.join('；')}。`);
  if (s.history.badge.length) lines.push(`警徽：${s.history.badge.join('；')}。`);
  if (s.history.shots.length) lines.push(`开枪：${s.history.shots.join('；')}。`);
  return {
    text: lines.join('\n'),
    payload: { roles, nights: s.history.nights, badge: s.history.badge, shots: s.history.shots },
  };
}
