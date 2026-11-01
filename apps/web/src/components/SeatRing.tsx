import { useLayoutEffect, useState, type CSSProperties } from 'react';
import type { Catalog, GodSeatInfo, Projection, RoomBrief } from '@werewolf/protocol';
import { publicActivity, publicElection, seatIdentity, seatPosition } from '../game-ui';
import { roleTone, seatStyle } from '../util';
import { Icon, PhaseIcon, RoleIcon } from './Icons';
import { Avatar } from './Avatar';

interface Props {
  projection: Projection;
  room: RoomBrief;
  catalog: Catalog | null;
  roles?: GodSeatInfo[];
}

const art = '/art/moon-village/';

export function SeatRing({ projection: p, room, catalog, roles }: Props) {
  const [picked, setPicked] = useState<number | null>(null);
  useLayoutEffect(() => { window.scrollTo(0, 0); }, [p.gameId]);
  const n = p.seats.length;
  const me = p.me?.seat;
  const election = publicElection(p.events);
  const alive = p.seats.filter((s) => s.alive).length;
  const dayLabel = p.status === 'ended' ? '终局' : p.day === 0 ? '静候入席' : '第 ' + String(p.day).padStart(2, '0') + (p.phase === 'night' ? ' 夜' : ' 天');
  const selected = p.seats.find((s) => s.seat === picked);
  const roleFor = (seat: number) => {
    const info = p.seats.find((s) => s.seat === seat);
    return info ? seatIdentity(p, info, roles) : {};
  };
  const selectedRole = selected ? roleFor(selected.seat) : null;

  return (
    <section className={['council-scene', p.phase, room.paused ? 'is-paused' : ''].join(' ')} aria-label="对局圆桌" data-players={n}>
      <header className="scene-caption">
        <div><span className="eyebrow">THE MOONLIT VILLAGE</span><h2>月影议事桌</h2></div>
        <span className="scene-view"><Icon name="eye" size={15} />{roles ? '上帝视角' : me ? me + ' 号座位' : '公开观战'}</span>
      </header>
      <div className="council-board" style={{ '--players': n } as CSSProperties}>
        <div className="table-fallback" aria-hidden="true" />
        <img className="council-table" src={art + 'table-' + (p.phase === 'day' ? 'day' : 'night') + '-v1.webp'} alt="" draggable={false} />
        <div className="table-center">
          <span className="table-ornament" aria-hidden="true">✦</span>
          <PhaseIcon phase={p.status === 'ended' ? 'end' : p.phase} size={30} />
          <div className="day-label">{dayLabel}</div>
          <div className="table-rule" />
          <div className="table-stage" aria-live="polite">{p.stage}</div>
          {room.paused && p.status !== 'ended' && <span className="table-paused"><Icon name="pause" size={12} />对局已暂停</span>}
          <span className="table-ornament bottom" aria-hidden="true">◆</span>
        </div>
        {p.seats.map((s, i) => {
          const position = seatPosition(i, n);
          const identity = roleFor(s.seat);
          const { role, name: roleName } = identity;
          const activity = publicActivity(p, s);
          const candidate = election.phase === 'running' && election.candidates.has(s.seat) && !election.withdrawn.has(s.seat);
          const withdrawn = election.phase === 'running' && election.withdrawn.has(s.seat);
          const states = [s.alive ? '存活' : '出局', s.sheriff ? '警长' : '', candidate ? '已上警' : '', withdrawn ? '已退水' : '', activity === 'speech' ? '正在发言' : activity === 'action' ? p.stage : '', roleName ?? '', s.seat === me ? '我' : ''].filter(Boolean);
          const cls = ['council-seat', position.cos > .8 ? 'seat-side-right' : position.cos < -.8 ? 'seat-side-left' : '', !s.alive ? 'dead' : '', s.seat === me ? 'me' : '', activity === 'speech' ? 'speaking' : activity === 'action' ? 'acting' : '', s.sheriff ? 'is-sheriff' : '', picked === s.seat ? 'selected' : ''].filter(Boolean).join(' ');
          return (
            <button key={s.seat} className={cls} style={{ '--cos': position.cos, '--sin': position.sin, '--speech-side-offset': '0px', '--seat-outset-y': position.sin < -.7 ? '-10px' : '14px', '--mobile-outset-y': position.sin < -.7 ? '-6px' : '0px', '--mx': position.mobileX + '%', '--my': position.mobileY + '%', ...seatStyle(s.seat) } as CSSProperties}
              aria-label={s.seat + '号 ' + s.name + '，' + states.join('，')} aria-pressed={picked === s.seat} onClick={() => setPicked(picked === s.seat ? null : s.seat)}>
              {activity && <span className={'seat-activity ' + activity}><span className="speaker-mic"><Icon name={activity === 'speech' ? 'mic' : 'spark'} size={14} /></span><span>{activity === 'speech' ? room.paused ? '发言暂停' : '正在发言' : '行动中'}</span>{activity === 'speech' && <span className="speaking-bars" aria-hidden="true"><i /><i /><i /><i /></span>}</span>}
              <span className="seat-portrait"><Avatar seat={s.seat} size={90} /><span className="seat-number">{String(s.seat).padStart(2, '0')}</span>
                {s.sheriff && <span className="sheriff-badge" title="警长"><Icon name="sheriff" size={26} /></span>}
                {s.seat === me && <span className="self-badge">我</span>}
                {roleName && <span className={'seat-role role-corner ' + (identity.tone ?? roleTone(catalog, role))} title={(identity.source === 'inspection' ? '查验结果：' : identity.source === 'teammate' ? '狼队同伴：' : '') + roleName + (identity.source === 'god' ? '' : '（仅你可见）')}>{roleName}</span>}
                {candidate ? <span className="candidate-mark seat-election" title="已上警"><Icon name="flag" size={11} />上警</span> : withdrawn ? <span className="withdrawn-mark seat-election" title="已退水"><Icon name="withdraw" size={11} />退水</span> : null}
                {!s.alive && <span className="dead-badge"><Icon name="close" size={10} />出局</span>}
              </span>
              <span className="seat-name" title={s.name === s.seat + '号' ? '可在开局前设置昵称' : s.name}>{s.name === s.seat + '号' ? '未命名' : s.name}</span>
            </button>
          );
        })}
      </div>
      {selected && <div className="seat-inspector" aria-label={selected.seat + '号座位详情'}>
        <RoleIcon role={selectedRole?.role} size={24} /><div><b>{selected.seat} 号 · {selected.name}</b><span>{selected.alive ? '存活' : '已出局'}{selected.sheriff ? ' · 警长' : ''} · {selectedRole?.name ?? '身份隐藏'} · {room.seats.find((s) => s.seat === selected.seat)?.controller === 'human' ? '真人操作' : 'AI 控制'}</span></div>
        <button className="icon-button" aria-label="关闭座位详情" onClick={() => setPicked(null)}><Icon name="close" size={17} /></button>
      </div>}
      <footer className="scene-footer"><span><i className="live-dot" />存活 <b>{alive}</b><span className="dim"> / {n}</span></span><span className="scene-legend"><Icon name="mic" size={12} />发言<Icon name="flag" size={12} />上警<Icon name="sheriff" size={14} />警长</span><span className="scene-hint">点按座位查看详情</span></footer>
    </section>
  );
}
