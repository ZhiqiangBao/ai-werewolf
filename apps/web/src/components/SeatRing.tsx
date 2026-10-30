import type { Catalog, GodSeatInfo, Projection, RoomBrief } from '@werewolf/protocol';
import { roleTone, seatStyle } from '../util';
import { PhaseIcon } from './Icons';

interface Props {
  projection: Projection;
  room: RoomBrief;
  catalog: Catalog | null;
  /** 上帝视角传入全部身份。 */
  roles?: GodSeatInfo[];
}

export function SeatRing({ projection: p, room, catalog, roles }: Props) {
  const n = p.seats.length;
  const me = p.me?.seat;
  const mates = new Set(p.me?.teammates ?? []);
  const dayLabel = p.status === 'ended' ? '终局' : p.day === 0 ? '准备' : `第 ${p.day} ${p.phase === 'night' ? '夜' : '天'}`;
  return (
    <div className={`ring ${p.phase === 'night' ? 'night' : 'day'}`}>
      <div className="ring-center">
        <PhaseIcon phase={p.phase} size={34} />
        <div className="day-label">{dayLabel}</div>
        <div className="stage muted">{p.stage}</div>
        {room.paused && p.status !== 'ended' && <div className="tag gold" style={{ marginTop: 8 }}>已暂停</div>}
      </div>
      {p.seats.map((s, i) => {
        const angle = (-90 + (360 / n) * i) * (Math.PI / 180);
        const left = 50 + 41 * Math.cos(angle);
        const top = 50 + 41 * Math.sin(angle);
        const god = roles?.find((r) => r.seat === s.seat);
        const role = god?.role ?? s.revealedRole ?? (s.seat === me ? p.me?.role : undefined);
        const roleName = god?.roleName ?? s.revealedRoleName ?? (s.seat === me ? p.me?.roleName : undefined);
        const controller = room.seats.find((x) => x.seat === s.seat)?.controller;
        const cls = ['seat', s.alive ? '' : 'dead', s.seat === me ? 'me' : '', mates.has(s.seat) ? 'mate' : '', s.active ? 'active' : '']
          .filter(Boolean)
          .join(' ');
        return (
          <div key={s.seat} className={cls} style={{ left: `${left}%`, top: `${top}%`, ...seatStyle(s.seat) }}>
            <div className="disc">
              {s.seat}
              {s.sheriff && <span className="badge" title="警长">警</span>}
            </div>
            <div className="name" title={s.name}>
              {s.name}
              {s.seat === me ? '（我）' : ''}
            </div>
            <div className="tags">
              {roleName && <span className={`tag ${roleTone(catalog, role)}`}>{roleName}</span>}
              {mates.has(s.seat) && !roleName && <span className="tag wolf">狼队友</span>}
              {controller && <span className="tag">{controller === 'ai' ? 'AI' : '真人'}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
