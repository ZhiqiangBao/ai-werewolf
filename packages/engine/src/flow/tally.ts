import type { Seat } from '@werewolf/protocol';
import { seatLabel, seatList, weightLabel } from '../text';

export interface Ballot {
  voter: Seat;
  target: Seat | null;
  /** 内部整数权重：普通票 2，警长票 3，弃票 0。 */
  weight: number;
}

export interface TallyRow {
  target: Seat;
  weight: number;
  voters: Seat[];
}

export interface Tally {
  ballots: Ballot[];
  rows: TallyRow[];
  abstain: Seat[];
  top: Seat[];
  topWeight: number;
}

export function tally(ballots: Ballot[]): Tally {
  const map = new Map<Seat, TallyRow>();
  const abstain: Seat[] = [];
  for (const b of ballots) {
    if (b.target === null || b.weight <= 0) {
      abstain.push(b.voter);
      continue;
    }
    const row = map.get(b.target) ?? { target: b.target, weight: 0, voters: [] };
    row.weight += b.weight;
    row.voters.push(b.voter);
    map.set(b.target, row);
  }
  const rows = [...map.values()].sort((a, b) => b.weight - a.weight || a.target - b.target);
  const topWeight = rows[0]?.weight ?? 0;
  const top = topWeight > 0 ? rows.filter((r) => r.weight === topWeight).map((r) => r.target) : [];
  return { ballots, rows, abstain: abstain.sort((a, b) => a - b), top: top.sort((a, b) => a - b), topWeight };
}

export function describeTally(t: Tally, sheriff: Seat | null): string {
  const mark = (s: Seat) => (s === sheriff ? `${seatLabel(s)}(警长)` : seatLabel(s));
  const parts = t.rows.map(
    (r) => `${seatLabel(r.target)} ${weightLabel(r.weight)} 票（${[...r.voters].sort((a, b) => a - b).map(mark).join('、')}）`,
  );
  if (t.abstain.length) parts.push(`弃票：${seatList(t.abstain)}`);
  return parts.length ? parts.join('；') : '无人投票';
}

export function tallyPayload(kind: string, round: number, t: Tally, sheriff: Seat | null) {
  return {
    kind,
    round,
    sheriff,
    ballots: t.ballots.map((b) => ({ voter: b.voter, target: b.target, weight: b.weight / 2 })),
    rows: t.rows.map((r) => ({ target: r.target, weight: r.weight / 2, voters: r.voters })),
    abstain: t.abstain,
  };
}
