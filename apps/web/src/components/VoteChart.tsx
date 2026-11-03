import type { GameEvent } from '@werewolf/protocol';
import { gameText } from '@werewolf/protocol';
import { seatStyle } from '../util';

interface Payload {
  kind: 'exile' | 'sheriff';
  round: number;
  sheriff: number | null;
  rows: { target: number; weight: number; voters: number[] }[];
  ballots: { voter: number; target: number | null; weight: number }[];
  abstain: number[];
  conclusion?: string;
}

/** 票型图：谁投给了谁，警长的票标出 1.5。 */
export function VoteChart({ event, locale }: { event: GameEvent; locale?: string }) {
  const p = event.payload as unknown as Payload;
  const title = gameText(locale, p.kind === 'sheriff' ? (p.round > 1 ? '警长 PK 投票' : '警长投票') : (p.round > 1 ? '放逐 PK 投票' : '放逐投票'));
  const max = Math.max(1, ...p.rows.map((r) => r.weight));
  const top = p.rows[0]?.weight ?? 0;
  const weightOf = (voter: number) => p.ballots.find((b) => b.voter === voter)?.weight ?? 1;
  return (
    <div className="votes">
      <div className="title">{title}</div>
      {p.rows.map((r) => (
        <div key={r.target} className="vote-row">
          <div className="target" style={seatStyle(r.target)}>
            {gameText(locale, '{0}号', r.target)}
          </div>
          <div className={`vote-bar ${r.weight === top ? 'top' : ''}`}>
            <div className="fill" style={{ width: `${(r.weight / max) * 100}%` }} />
            {[...r.voters].sort((a, b) => a - b).map((v) => {
              const w = weightOf(v);
              return (
                <span key={v} className={`voter ${w !== 1 ? 'sheriff' : ''}`} style={seatStyle(v)} title={w !== 1 ? gameText(locale, '警长 {0} 票', w) : undefined}>
                  {gameText(locale, '{0}号', v)}
                  {w !== 1 ? ` ×${w}` : ''}
                </span>
              );
            })}
            <span className="weight">{r.weight === 1 ? gameText(locale, '1 票') : gameText(locale, '{0} 票', r.weight)}</span>
          </div>
        </div>
      ))}
      {!p.rows.length && <div className="muted small">{gameText(locale, '无人投票')}</div>}
      {p.abstain.length > 0 && <div className="muted small">{gameText(locale, '弃票：{0}', p.abstain.map((s) => gameText(locale, '{0}号', s)).join('、'))}</div>}
      {p.conclusion && <div className="conclusion">{p.conclusion}</div>}
    </div>
  );
}
