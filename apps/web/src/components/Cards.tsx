import type { Catalog, GameResult, MeInfo } from '@werewolf/protocol';
import { gameText } from '@werewolf/protocol';
import { roleTone, seatName } from '../util';
import { RoleIcon } from './Icons';

export function IdentityCard({ me, catalog, locale }: { me: MeInfo; catalog: Catalog | null; locale?: string }) {
  const tone = roleTone(catalog, me.role);
  return (
    <div className={`panel identity ${tone}`}>
      <div className="row">
        <span className="identity-symbol"><RoleIcon role={me.role} size={31} /></span>
        <div>
          <div className="small muted">
            {gameText(locale, '{0}的身份', `${gameText(locale, '{0}号', me.seat)}${me.name !== seatName(me.seat) && me.name !== gameText(locale, '{0}号', me.seat) ? ` · ${me.name}` : ''}`)}
          </div>
          <div className="role">{me.roleName}</div>
        </div>
        <span className="spacer" />
        <span className={`tag ${tone}`}>{me.factionName}</span>
        <span className={`tag ${me.alive ? 'ok' : 'bad'}`}>{gameText(locale, me.alive ? '存活' : '已出局')}</span>
      </div>
      {!!me.teammates?.length && (
        <div className="small" style={{ marginTop: 8 }}>
          {gameText(locale, '狼队友：{0}', me.teammates.map((s) => gameText(locale, '{0}号', s)).join('、'))}
        </div>
      )}
      <pre className="small muted" style={{ marginTop: 8 }}>
        {me.appendix}
      </pre>
    </div>
  );
}

export function RuleCard({ text, open = false, locale }: { text: string; open?: boolean; locale: string | undefined }) {
  return (
    <details className="panel" open={open}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{gameText(locale, '本局规则卡')}</summary>
      <pre className="rulecard" style={{ marginTop: 10 }}>
        {text}
      </pre>
    </details>
  );
}

export function ResultBanner({ result, locale }: { result: GameResult; locale?: string }) {
  return (
    <div className="result-banner">
      <h2>{result.winner === 'draw' ? gameText(locale, '流局') : gameText(locale, '{0}获胜', result.winnerName)}</h2>
      <div className="muted" style={{ marginTop: 6 }}>
        {result.reason}
      </div>
    </div>
  );
}
