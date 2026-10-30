import type { Catalog, GodProjection, RoomBrief } from '@werewolf/protocol';
import { roleTone, seatName, seatStyle } from '../util';

/** 上帝视角：全部身份、当前决策里谁还没提交。 */
export function GodPanel({ projection: p, room, catalog }: { projection: GodProjection; room: RoomBrief; catalog: Catalog | null }) {
  const pending = p.god.pending;
  const controllerOf = (seat: number) => room.seats.find((s) => s.seat === seat)?.controller;
  return (
    <div className="panel">
      <h3>
        上帝视角
        <span className="spacer" />
        <span className="tiny dim">种子 {p.god.seed}</span>
      </h3>
      {pending ? (
        <div className="note-box small" style={{ marginBottom: 12 }}>
          <div>
            等待中：<b>{pending.title}</b>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            {pending.actors.map((a) => (
              <span key={a.seat} className={`tag ${a.submitted ? 'ok' : ''}`} title={a.tools.join('、')}>
                {seatName(a.seat)} {a.submitted ? '已提交' : controllerOf(a.seat) === 'human' ? '等待真人操作' : '思考中'}
              </span>
            ))}
          </div>
        </div>
      ) : (
        p.status !== 'ended' && <div className="note-box small" style={{ marginBottom: 12 }}>法官结算中…</div>
      )}
      <table className="god-table">
        <thead>
          <tr>
            <th>座位</th>
            <th>身份</th>
            <th>阵营</th>
            <th>控制</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {p.god.roles.map((r) => {
            const seat = p.seats.find((s) => s.seat === r.seat);
            return (
              <tr key={r.seat} className={r.alive ? '' : 'dead'}>
                <td>
                  <i className="seat-dot" style={seatStyle(r.seat)} />
                  {seatName(r.seat)}
                  {seat && seat.name !== seatName(r.seat) ? ` ${seat.name}` : ''}
                  {seat?.sheriff ? ' ★' : ''}
                </td>
                <td>
                  <span className={`tag ${roleTone(catalog, r.role)}`}>{r.roleName}</span>
                </td>
                <td className="muted">{r.factionName}</td>
                <td className="muted">{controllerOf(r.seat) === 'human' ? '真人' : 'AI'}</td>
                <td>{r.alive ? '存活' : '出局'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
