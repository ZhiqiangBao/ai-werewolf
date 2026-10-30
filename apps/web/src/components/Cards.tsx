import type { Catalog, GameResult, MeInfo } from '@werewolf/protocol';
import { roleTone, seatName } from '../util';

export function IdentityCard({ me, catalog }: { me: MeInfo; catalog: Catalog | null }) {
  const tone = roleTone(catalog, me.role);
  return (
    <div className={`panel identity ${tone}`}>
      <div className="row">
        <div>
          <div className="small muted">
            {seatName(me.seat)}
            {me.name !== seatName(me.seat) ? ` · ${me.name}` : ''} 的身份
          </div>
          <div className="role">{me.roleName}</div>
        </div>
        <span className="spacer" />
        <span className={`tag ${tone}`}>{me.factionName}</span>
        <span className={`tag ${me.alive ? 'ok' : 'bad'}`}>{me.alive ? '存活' : '已出局'}</span>
      </div>
      {!!me.teammates?.length && (
        <div className="small" style={{ marginTop: 8 }}>
          狼队友：{me.teammates.map(seatName).join('、')}
        </div>
      )}
      <pre className="small muted" style={{ marginTop: 8 }}>
        {me.appendix}
      </pre>
    </div>
  );
}

export function RuleCard({ text, open = false }: { text: string; open?: boolean }) {
  return (
    <details className="panel" open={open}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>本局规则卡</summary>
      <pre className="rulecard" style={{ marginTop: 10 }}>
        {text}
      </pre>
    </details>
  );
}

export function ResultBanner({ result }: { result: GameResult }) {
  return (
    <div className="result-banner">
      <h2>{result.winner === 'draw' ? '流局' : `${result.winnerName}获胜`}</h2>
      <div className="muted" style={{ marginTop: 6 }}>
        {result.reason}
      </div>
    </div>
  );
}
