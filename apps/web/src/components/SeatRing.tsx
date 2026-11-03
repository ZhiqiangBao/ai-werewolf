import { deathLabel, gameText, type SeatDeathView } from '@werewolf/protocol';
import { useI18n } from '../i18n';
import { DeathMark } from './DeathMark';
import { useLayoutEffect, useState, type CSSProperties } from 'react';
import type { Catalog, GodSeatInfo, Projection, RoomBrief } from '@werewolf/protocol';
import { publicActivity, publicElection, seatIdentity, seatPosition } from '../game-ui';
import { phaseLabel, roleTone, seatStyle } from '../util';
import { Icon, PhaseIcon, RoleIcon } from './Icons';
import { Avatar } from './Avatar';

interface Props {
  projection: Projection;
  room: RoomBrief;
  catalog: Catalog | null;
  roles?: GodSeatInfo[];
  deaths?: SeatDeathView[];
}

const art = '/art/moon-village/';

export function SeatRing({ projection: p, room, catalog, roles, deaths = [] }: Props) {
  const { t } = useI18n();
  const locale = p.locale ?? room.locale;
  const gt = (source: string, ...args: unknown[]) => gameText(locale, source, ...args);
  const [picked, setPicked] = useState<number | null>(null);
  useLayoutEffect(() => { window.scrollTo(0, 0); }, [p.gameId]);
  const n = p.seats.length;
  const me = p.me?.seat;
  const election = publicElection(p.events);
  const alive = p.seats.filter((s) => s.alive).length;
  const dayLabel = p.status === 'ended' ? gt('终局') : p.day === 0 ? gt('静候入席') : phaseLabel(p.day, p.phase, locale);
  const selected = p.seats.find((s) => s.seat === picked);
  const roleFor = (seat: number) => {
    const info = p.seats.find((s) => s.seat === seat);
    return info ? seatIdentity(p, info, roles, p.locale ?? room.locale) : {};
  };
  const selectedRole = selected ? roleFor(selected.seat) : null;
  const deathFor = (seat: number) => deaths.find((d) => d.seat === seat)?.causes ?? ['other' as const];

  return (
    <section className={['council-scene', p.phase, room.paused ? 'is-paused' : ''].join(' ')} aria-label={t('对局圆桌')} data-players={n}>
      <header className="scene-caption">
        <div><span className="eyebrow">THE MOONLIT VILLAGE</span><h2>{t('月影议事桌')}</h2></div>
        <span className="scene-view"><Icon name="eye" size={15} />{roles ? t('上帝视角') : me ? gt('{0} 号座位', me) : t('公开观战')}</span>
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
          {room.paused && p.status !== 'ended' && <span className="table-paused"><Icon name="pause" size={12} />{gt('对局已暂停')}</span>}
          <span className="table-ornament bottom" aria-hidden="true">◆</span>
        </div>
        {p.seats.map((s, i) => {
          const position = seatPosition(i, n);
          const identity = roleFor(s.seat);
          const { role, name: roleName } = identity;
          const activity = publicActivity({ ...p, locale }, s);
          const candidate = election.phase === 'running' && election.candidates.has(s.seat) && !election.withdrawn.has(s.seat);
          const withdrawn = election.phase === 'running' && election.withdrawn.has(s.seat);
          const states = [s.alive ? gt('存活') : deathLabel(deathFor(s.seat), locale), s.sheriff ? gt('警长') : '', candidate ? gt('已上警') : '', withdrawn ? gt('已退水') : '', activity === 'speech' ? gt('正在发言') : activity === 'action' ? p.stage : '', roleName ?? '', s.seat === me ? t('我') : ''].filter(Boolean);
          const cls = ['council-seat', position.cos > .8 ? 'seat-side-right' : position.cos < -.8 ? 'seat-side-left' : '', !s.alive ? 'dead' : '', s.seat === me ? 'me' : '', activity === 'speech' ? 'speaking' : activity === 'action' ? 'acting' : '', s.sheriff ? 'is-sheriff' : '', picked === s.seat ? 'selected' : ''].filter(Boolean).join(' ');
          return (
            <button key={s.seat} className={cls} style={{ '--cos': position.cos, '--sin': position.sin, '--speech-side-offset': '0px', '--seat-outset-y': position.sin < -.7 ? '-10px' : '14px', '--mobile-outset-y': position.sin < -.7 ? '-6px' : '0px', '--mx': position.mobileX + '%', '--my': position.mobileY + '%', ...seatStyle(s.seat) } as CSSProperties}
              aria-label={t('{0} {1}，{2}', gt('{0}号', s.seat), s.name, states.join('，'))} aria-pressed={picked === s.seat} onClick={() => setPicked(picked === s.seat ? null : s.seat)}>
              {activity && <span className={'seat-activity ' + activity}><span className="speaker-mic"><Icon name={activity === 'speech' ? 'mic' : 'spark'} size={14} /></span><span>{gt(activity === 'speech' ? room.paused ? '发言暂停' : '正在发言' : '行动中')}</span>{activity === 'speech' && <span className="speaking-bars" aria-hidden="true"><i /><i /><i /><i /></span>}</span>}
              <span className="seat-portrait"><Avatar seat={s.seat} size={90} /><span className="seat-number">{String(s.seat).padStart(2, '0')}</span>
                {s.sheriff && <span className="sheriff-badge" title={gt('警长')}><Icon name="sheriff" size={26} /></span>}
                {s.seat === me && <span className="self-badge">{t('我')}</span>}
                {roleName && <span className={'seat-role role-corner ' + (identity.tone ?? roleTone(catalog, role))} title={identity.source === 'god' || identity.source === 'public' ? roleName : t('{0}（仅你可见）', identity.source === 'inspection' ? t('查验结果：{0}', roleName) : identity.source === 'teammate' ? t('狼队同伴：{0}', roleName) : roleName)}>{roleName}</span>}
                {candidate ? <span className="candidate-mark seat-election" title={gt('已上警')}><Icon name="flag" size={11} />{gt('上警')}</span> : withdrawn ? <span className="withdrawn-mark seat-election" title={gt('已退水')}><Icon name="withdraw" size={11} />{gt('退水')}</span> : null}
                {!s.alive && <span className="dead-badge"><DeathMark causes={deathFor(s.seat)} locale={locale} /></span>}
              </span>
              <span className="seat-name" title={s.name === s.seat + '号' || s.name === gt('{0}号', s.seat) ? t('可在开局前设置昵称') : s.name}>{s.name === s.seat + '号' || s.name === gt('{0}号', s.seat) ? t('未命名') : s.name}</span>
            </button>
          );
        })}
      </div>
      {selected && <div className="seat-inspector" aria-label={t('{0}座位详情', gt('{0}号', selected.seat))}>
        <RoleIcon role={selectedRole?.role} size={24} /><div><b>{gt('{0}号', selected.seat)} · {selected.name}</b><span>{selected.alive ? gt('存活') : deathLabel(deathFor(selected.seat), locale)}{selected.sheriff ? ` · ${gt('警长')}` : ''} · {selectedRole?.name ?? gt('身份隐藏')} · {room.seats.find((s) => s.seat === selected.seat)?.controller === 'human' ? t('真人操作') : t('AI 控制')}</span></div>
        <button className="icon-button" aria-label={t('关闭座位详情')} onClick={() => setPicked(null)}><Icon name="close" size={17} /></button>
      </div>}
      <footer className="scene-footer"><span><i className="live-dot" />{gt('存活')} <b>{alive}</b><span className="dim"> / {n}</span></span><span className="scene-legend"><Icon name="mic" size={12} />{gt('普通发言')}<Icon name="flag" size={12} />{gt('上警')}<Icon name="sheriff" size={14} />{gt('警长')}</span><span className="scene-hint">{t('点按座位查看详情')}</span></footer>
    </section>
  );
}
