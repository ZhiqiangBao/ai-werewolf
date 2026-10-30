import type { GameEvent } from '@werewolf/protocol';
import { seatName, seatStyle } from '../util';

interface Payload {
  kind: 'exile' | 'sheriff';
  round: number;
  sheriff: number | null;
  rows: { target: number; weight: number; voters: number[] }[];
  ballots: { voter: number; target: number | null; weight: number }[];
  abstain: number[];
}

/** 票型图：谁投给了谁，警长的票标出 1.5。 */
export function VoteChart({ event }: { event: GameEvent }) {
  const p = event.payload as unknown as Payload;
  const title = `${p.kind === 'sheriff' ? '警长' : '放逐'}${p.round > 1 ? ' PK' : ''}投票`;
  const max = Math.max(1, ...p.rows.map((r) => r.weight));
  const top = p.rows[0]?.weight ?? 0;
  const weightOf = (voter: number) => p.ballots.find((b) => b.voter === voter)?.weight ?? 1;
  return (
    <div className="votes">
      <div className="title">{title}</div>
      {p.rows.map((r) => (
        <div key={r.target} className="vote-row">
          <div className="target" style={seatStyle(r.target)}>
            {seatName(r.target)}
          </div>
          <div className={`vote-bar ${r.weight === top ? 'top' : ''}`}>
            <div className="fill" style={{ width: `${(r.weight / max) * 100}%` }} />
            {[...r.voters].sort((a, b) => a - b).map((v) => {
              const w = weightOf(v);
              return (
                <span key={v} className={`voter ${w !== 1 ? 'sheriff' : ''}`} style={seatStyle(v)} title={w !== 1 ? `警长 ${w} 票` : undefined}>
                  {seatName(v)}
                  {w !== 1 ? ` ×${w}` : ''}
                </span>
              );
            })}
            <span className="weight">{r.weight} 票</span>
          </div>
        </div>
      ))}
      {!p.rows.length && <div className="muted small">无人投票</div>}
      {p.abstain.length > 0 && <div className="muted small">弃票：{p.abstain.map(seatName).join('、')}</div>}
    </div>
  );
}
