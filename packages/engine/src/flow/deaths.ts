import { gameText } from '@werewolf/protocol';
import type { Seat } from '@werewolf/protocol';
import type { Ctx } from '../context';
import { seatLabel, seatList } from '../text';
import { seatParam } from '../tools';
import type { Step, StepHandler } from '../types';
import { speechSteps } from './day';
import { evaluateWin } from './win';
import { abilityDeathSteps } from '../abilities';

/**
 * 一批死亡的统一处理：新版议程先检查胜负，胜负未分才执行出局职责（例如猎人开枪），
 * 每项职责执行前也重新检查，终局不再发动后续技能；旧版保留先技能后判胜负。
 * 再按顺序走 胜负检查 → 警徽 → 遗言。自爆批次的顺序是 警徽 → 遗言 → 胜负检查。
 * 胜负已经成立时不再发表遗言，直接公布结果。
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
          duties.push(...(ctx.roleOf(d.seat).onDeath?.(ctx, d) ?? []).map((duty) => ({ ...duty, dutySeat: d.seat })));
          duties.push(...abilityDeathSteps(ctx, d));
        }
        ctx.pushFront(...duties, step);
        return;
      }
      if (step.mode === 'explode') {
        ctx.pushFront(
          { type: 'badge.duty', batch },
          { type: 'lastwords', batch, allowExplode: false, first: step.firstLastWords },
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
      s.agenda = [{ type: 'game.end', winner: result.winner, reason: result.reason }];
      ctx.pub('game.decided', gameText(ctx.rules.locale, "胜负已分。"), {});
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
            title: gameText(ctx.rules.locale, "处理警徽"),
            description: gameText(ctx.rules.locale, "你已出局。把警徽移交给一名存活玩家，或撕毁警徽。"),
            params: [seatParam('target', gameText(ctx.rules.locale, "移交给"), targets, gameText(ctx.rules.locale, "撕毁警徽"))],
          },
        ],
        prompt: () => gameText(ctx.rules.locale, "你是警长并且已经出局。请把警徽移交给一名存活玩家，或者撕毁警徽。可移交座位：{0}。", seatList(targets, ctx.rules.locale)) +
          (s.rules.toolsetVersion === 2 ? gameText(ctx.rules.locale, "移交时调用 badge_transfer，recipientSeat 填最终接收者的整数座位号；撕毁时调用 badge_tear，填写 {}。") : gameText(ctx.rules.locale, "target 填最终选择的座位号，null 表示撕毁。")) +
          gameText(ctx.rules.locale, "移交不限阵营，不能移交给自己。"),
        title: gameText(ctx.rules.locale, "第{0}天 · 警徽", s.day),
        publicStage: gameText(ctx.rules.locale, "{0}处理警徽", seatLabel(sheriff, ctx.rules.locale)),
        publicActor: sheriff,
        hear: 'actors',
      });
    },
    decide(ctx, _step, subs) {
      const sheriff = ctx.state.sheriff as Seat;
      const target = subs[sheriff].args.target as Seat | null;
      if (target === null) tearBadge(ctx, sheriff);
      else {
        ctx.state.sheriff = target;
        ctx.state.history.badge.push(gameText(ctx.rules.locale, "第{0}天 {1}将警徽移交给{2}", ctx.state.day, seatLabel(sheriff, ctx.rules.locale), seatLabel(target, ctx.rules.locale)));
        ctx.pub('badge.transfer', gameText(ctx.rules.locale, "{0}将警徽移交给{1}。", seatLabel(sheriff, ctx.rules.locale), seatLabel(target, ctx.rules.locale)), { from: sheriff, to: target });
      }
    },
    fallback: (ctx) => ({ tool: 'badge_dispose', args: { target: null } }),
  },

  lastwords: {
    run(ctx, step) {
      if (ctx.state.ending || evaluateWin(ctx)) return;
      const batch = step.batch as number;
      const seats = ctx.state.deaths
        .filter((d) => d.batch === batch && d.lastWords)
        .map((d) => d.seat)
        .sort((a, b) => a === step.first ? -1 : b === step.first ? 1 : a - b);
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
      const winnerName = winner === 'good' ? gameText(ctx.rules.locale, "好人阵营") : winner === 'wolf' ? gameText(ctx.rules.locale, "狼人阵营") : gameText(ctx.rules.locale, "无人");
      const reason = step.reason as string;
      s.phase = 'end';
      s.stage = gameText(ctx.rules.locale, "游戏结束");
      s.ending = false;
      s.agenda = [];
      s.pending = null;
      s.result = { winner, winnerName, reason };
      ctx.pub(
        'game.end',
        winner === 'draw' ? gameText(ctx.rules.locale, "游戏结束：流局。{0}", reason) : gameText(ctx.rules.locale, "游戏结束：{0}获胜。{1}", winnerName, reason),
        { result: s.result },
      );
      const review = buildReview(ctx);
      ctx.pub('review', review.text, review.payload);
    },
  },
};

export function tearBadge(ctx: Ctx, sheriff: Seat): void {
  ctx.state.sheriff = null;
  ctx.state.history.badge.push(gameText(ctx.rules.locale, "第{0}天 {1}撕毁警徽", ctx.state.day, seatLabel(sheriff, ctx.rules.locale)));
  ctx.pub('badge.tear', gameText(ctx.rules.locale, "{0}撕毁了警徽，本局不再有警长。", seatLabel(sheriff, ctx.rules.locale)), { from: sheriff });
}

function buildReview(ctx: Ctx) {
  const s = ctx.state;
  const roles = s.players.map((p) => ({ seat: p.seat, role: p.role, roleName: gameText(ctx.rules.locale, ctx.roleOf(p.seat).name), alive: p.alive }));
  const lines: string[] = [gameText(ctx.rules.locale, "【终局复盘】")];
  lines.push(gameText(ctx.rules.locale, "身份：{0}。", roles.map((r) => `${seatLabel(r.seat, ctx.rules.locale)}${r.roleName}`).join('，')));
  for (const n of s.history.nights) lines.push(gameText(ctx.rules.locale, "第{0}夜：{1}。", n.n, n.lines.join('；')));
  if (s.history.badge.length) lines.push(gameText(ctx.rules.locale, "警徽：{0}。", s.history.badge.join('；')));
  if (s.history.shots.length) lines.push(gameText(ctx.rules.locale, "开枪：{0}。", s.history.shots.join('；')));
  return {
    text: lines.join('\n'),
    payload: { roles, nights: s.history.nights, badge: s.history.badge, shots: s.history.shots },
  };
}
