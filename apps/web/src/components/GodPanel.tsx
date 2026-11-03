import { gameText, type SeatDeathView } from '@werewolf/protocol';
import { useI18n } from '../i18n';
import { DeathMark } from './DeathMark';
import type { Catalog, GodProjection, RoomBrief } from '@werewolf/protocol';
import { roleTone, seatName, seatStyle } from '../util';

/** 上帝视角：全部身份、当前决策里谁还没提交。 */
export function GodPanel({ projection: p, room, catalog, deaths = [] }: { projection: GodProjection; room: RoomBrief; catalog: Catalog | null; deaths?: SeatDeathView[] }) {
  const { t } = useI18n();
  const locale = p.locale ?? room.locale;
  const gt = (source: string, ...args: unknown[]) => gameText(locale, source, ...args);
  const pending = p.god.pending;
  const controllerOf = (seat: number) => room.seats.find((s) => s.seat === seat)?.controller;
  return (
    <div className="panel">
      <h3>
        {t('上帝视角')}
        <span className="spacer" />
        <span className="tiny dim">{t('种子 {0}', p.god.seed)}</span>
      </h3>
      {pending ? (
        <div className="note-box small" style={{ marginBottom: 12 }}>
          <div>
            {gt('等待中：{0}', pending.title)}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            {pending.actors.map((a) => (
              <span key={a.seat} className={`tag ${a.submitted ? 'ok' : ''}`} title={a.tools.join('、')}>
                {gt('{0}号', a.seat)} {gt(a.submitted ? '已提交' : controllerOf(a.seat) === 'human' ? '等待真人操作' : '思考中')}
              </span>
            ))}
          </div>
        </div>
      ) : (
        p.status !== 'ended' && <div className="note-box small" style={{ marginBottom: 12 }}>{gt('法官结算中…')}</div>
      )}
      <table className="god-table">
        <thead>
          <tr>
            <th>{gt('座位')}</th>
            <th>{gt('身份')}</th>
            <th>{gt('阵营')}</th>
            <th>{t('控制')}</th>
            <th>{gt('状态')}</th>
          </tr>
        </thead>
        <tbody>
          {p.god.roles.map((r) => {
            const seat = p.seats.find((s) => s.seat === r.seat);
            return (
              <tr key={r.seat} className={r.alive ? '' : 'dead'}>
                <td>
                  <i className="seat-dot" style={seatStyle(r.seat)} />
                  {gt('{0}号', r.seat)}
                  {seat && seat.name !== seatName(r.seat) && seat.name !== gt('{0}号', r.seat) ? ` ${seat.name}` : ''}
                  {seat?.sheriff ? ' ★' : ''}
                </td>
                <td>
                  <span className={`tag ${roleTone(catalog, r.role)}`}>{r.roleName}</span>
                </td>
                <td className="muted">{r.factionName}</td>
                <td className="muted">{controllerOf(r.seat) === 'human' ? t('真人') : 'AI'}</td>
                <td>{r.alive ? gt('存活') : <DeathMark causes={deaths.find((d) => d.seat === r.seat)?.causes} locale={locale} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
