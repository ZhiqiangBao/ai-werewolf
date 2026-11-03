import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { GameEvent, SeatInfo } from '@werewolf/protocol';
import { gameRecordEvents } from '@werewolf/protocol';
import { gameText } from '@werewolf/protocol';
import { useI18n } from '../i18n';
import { audienceText, phaseLabel, seatName, seatStyle } from '../util';
import { PhaseIcon } from './Icons';
import { VoteChart } from './VoteChart';
import { Avatar } from './Avatar';

export type LogMode = 'seat' | 'spectator' | 'god';

interface Props {
  events: GameEvent[];
  seats: SeatInfo[];
  mode: LogMode;
  mySeat?: number;
  onRead?: (event: GameEvent) => void;
  controls?: ReactNode;
  locale: string | undefined;
}

const SPEECH_KIND: Record<string, string> = {
  discussion: '普通发言',
  campaign: '竞选发言',
  pk: 'PK 发言',
  sheriff_pk: '竞选 PK 发言',
  lastwords: '遗言',
};

const DEATH_TYPES = new Set(['exile', 'explode', 'hunter.shot', 'idiot.flip']);

export function EventLog({ events, seats, mode, mySeat, onRead, controls, locale }: Props) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const [onlyPublic, setOnlyPublic] = useState(false);
  const shown = gameRecordEvents(events, locale).filter((e) => !onlyPublic || e.audience === 'public');

  const nameOf = (seat: number) => {
    const s = seats.find((x) => x.seat === seat);
    const label = gameText(locale, '{0}号', seat);
    return s && s.name !== seatName(seat) && s.name !== label ? `${label} ${s.name}` : label;
  };

  const scopeLabel = (e: GameEvent): string | null => {
    if (e.audience === 'public') return null;
    if (mode === 'god') return audienceText(e.audience, locale);
    if (e.audience.length === 1 && e.audience[0] === mySeat) return gameText(locale, '仅你可见');
    return gameText(locale, '{0}可见', e.audience.map((s) => gameText(locale, '{0}号', s)).join(gameText(locale, '、')));
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, onlyPublic]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setAway(!stick.current);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  let lastKey = '';

  return (
    <div className="panel event-log">
      <h3>
        {t('对局记录')}
        <span className="spacer" />
        {mode !== 'spectator' && (
          <label className="row small muted" style={{ gap: 6, fontWeight: 400 }}>
            <input type="checkbox" checked={onlyPublic} onChange={(e) => setOnlyPublic(e.target.checked)} />
            {t('只看公开信息')}
          </label>
        )}
      </h3>
      {controls}
      <div className="log-wrap">
        <div className="log" ref={box} role="region" aria-label={t('发言与对局记录')} tabIndex={0}>
          {!shown.length && <div className="muted small">{t('还没有记录。')}</div>}
          {shown.map((e) => {
            const key = `${e.day}:${e.phase}`;
            const divider =
              key !== lastKey && e.phase !== 'setup' ? (
                <div className={`log-divider ${e.phase}`}>
                  {e.phase !== 'end' && <PhaseIcon phase={e.phase} size={14} />}
                  {phaseLabel(e.day, e.phase, locale)}
                </div>
              ) : null;
            lastKey = key;
            return (
              <Fragment key={e.seq}>
                {divider}
                {e.type !== 'phase' && <EventItem e={e} nameOf={nameOf} scope={scopeLabel(e)} onRead={onRead} locale={locale} />}
              </Fragment>
            );
          })}
        </div>
        {away && (
          <button
            className="btn sm jump"
            onClick={() => {
              const el = box.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            {t('回到最新')}
          </button>
        )}
      </div>
    </div>
  );
}

function EventItem({ e, nameOf, scope, onRead, locale }: { e: GameEvent; nameOf: (s: number) => string; scope: string | null; onRead?: (event: GameEvent) => void; locale?: string }) {
  const { t } = useI18n();
  const p = e.payload;
  const meta = scope ? <span className="meta">{scope}</span> : null;

  if (e.type === 'speech' || e.type === 'wolf.chat') {
    const seat = p.seat as number;
    const wolf = e.type === 'wolf.chat';
    const kind = gameText(locale, wolf ? '狼队密谈' : (SPEECH_KIND[p.kind as string] ?? '普通发言'));
    return (
      <div className={`speech ${wolf ? 'wolfchat' : (p.kind as string)}`} style={seatStyle(seat)}>
        <span className="log-avatar"><Avatar seat={seat} size={34} /><b>{seat}</b></span>
        <div>
          <div className="who">
            {nameOf(seat)} · {kind}
            {meta}
            {!wolf && onRead && <button className="btn sm ghost speech-read" aria-label={t('朗读 {0} 的{1}', seat, kind)} onClick={() => onRead(e)}>{t('朗读')}</button>}
          </div>
          <div className="bubble">{p.content as string}</div>
        </div>
      </div>
    );
  }

  if (e.type === 'vote.result') return <VoteChart event={e} locale={locale} />;

  if (e.type === 'review') {
    return (
      <div className="review">
        <pre>{e.text}</pre>
      </div>
    );
  }

  const cls = ['ev', 'system'];
  if (e.type === 'game.end' || e.type === 'game.start') cls.push('major');
  if (DEATH_TYPES.has(e.type) || (e.type === 'dawn' && ((p.deaths as number[] | undefined)?.length ?? 0) > 0)) cls.push('death');
  if (e.type.startsWith('sheriff.') || e.type.startsWith('badge.')) cls.push('sheriff');
  if (e.audience !== 'public') cls.push('private');
  return (
    <div className={cls.join(' ')}>
      <pre style={{ display: 'inline' }}>{e.text}</pre>
      {meta}
    </div>
  );
}
