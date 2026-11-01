import type { Seat } from '@werewolf/protocol';
import { seatLabel, seatList } from '../text';
import type { ResolutionRow, StepHandler } from '../types';

const CAUSE_LABEL: Record<string, string> = {
  wolf: '狼刀',
  poison: '毒药',
  guard_and_save: '同守同救',
};

export const nightSteps: Record<string, StepHandler> = {
  'night.start': {
    run(ctx) {
      const s = ctx.state;
      const maxDays = ctx.opt<number>('limits.maxDays');
      if (s.phase !== 'setup' && s.day >= maxDays) {
        ctx.pushFront({ type: 'game.end', winner: 'draw', reason: `超过 ${maxDays} 个白天仍未分出胜负。` });
        return;
      }
      s.day = s.phase === 'setup' ? 1 : s.day + 1;
      s.phase = 'night';
      s.stage = `第${s.day}夜`;
      s.night = { n: s.day, attacks: [], protections: [], lines: [] };
      s.dayState = { direction: null, firstSpeaker: null, anchor: null, electionToday: false };
      ctx.pub('phase', `第${s.day}夜，天黑请闭眼。`, { phase: 'night' });
      for (const mod of ctx.modulesInGame()) mod.nightStart?.(ctx);
      ctx.pushFront(
        ...s.rules.nightOrder.map((id) => ({ type: `night:${id}` })),
        { type: 'night.resolve' },
        { type: 'day.start' },
      );
    },
  },

  /** 守卫、落刀、查验、用药都结束后一次结算。攻击被对应种类的保护挡住；身份模块可以修正（例如同守同救）。 */
  'night.resolve': {
    run(ctx) {
      const s = ctx.state;
      const night = s.night;
      if (!night) throw new Error('night.resolve 缺少夜晚状态');
      const rows: ResolutionRow[] = night.attacks.map((attack) => {
        const blockers = night.protections.filter((p) => p.target === attack.target && p.blocks.includes(attack.kind));
        return { attack, blockers, blocked: blockers.length > 0, causes: [attack.kind] };
      });
      for (const mod of ctx.modulesInGame()) mod.resolveNight?.(ctx, rows);

      const byTarget = new Map<Seat, Set<string>>();
      for (const r of rows) {
        if (r.blocked) continue;
        const set = byTarget.get(r.attack.target) ?? new Set<string>();
        for (const c of r.causes) set.add(c);
        byTarget.set(r.attack.target, set);
      }
      const deaths = [...byTarget.entries()]
        .filter(([seat]) => ctx.isAlive(seat))
        .map(([seat, causes]) => ({ seat, causes: [...causes] }))
        .sort((a, b) => a.seat - b.seat);

      s.pendingDeaths = { night: night.n, deaths, knife: night.knife ?? null };
      const summary = deaths.length
        ? deaths.map((d) => `${seatLabel(d.seat)}（${d.causes.map((c) => CAUSE_LABEL[c] ?? c).join('+')}）`).join('、')
        : '无人出局';
      night.lines.push(`结算：${summary}`);
      s.history.nights.push({ n: night.n, lines: [...night.lines], deaths: deaths.map((d) => d.seat) });
      ctx.god('night.resolution', `第${night.n}夜结算：${summary}`, {
        rows: rows.map((r) => ({ ...r.attack, blocked: r.blocked, blockers: r.blockers.map((b) => b.kind), causes: r.causes })),
        deaths,
      });
      for (const mod of ctx.modulesInGame()) mod.afterNight?.(ctx);
      s.night = null;
    },
  },
};

export const describeDeaths = (seats: Seat[]): string => (seats.length ? seatList(seats) : '无');
