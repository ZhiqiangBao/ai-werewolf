import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GameEvent, SeatInfo } from '@werewolf/protocol';
import { gameRecordEvents } from '@werewolf/protocol';
import { audienceText, phaseLabel, seatName, seatStyle } from '../util';
import { PhaseIcon } from './Icons';
import { VoteChart } from './VoteChart';

export type LogMode = 'seat' | 'spectator' | 'god';

interface Props {
  events: GameEvent[];
  seats: SeatInfo[];
  mode: LogMode;
  mySeat?: number;
}

const SPEECH_KIND: Record<string, string> = {
  discussion: '发言',
  campaign: '竞选发言',
  pk: 'PK 发言',
  sheriff_pk: '竞选 PK 发言',
  lastwords: '遗言',
};

const DEATH_TYPES = new Set(['exile', 'explode', 'hunter.shot', 'idiot.flip']);

export function EventLog({ events, seats, mode, mySeat }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const [onlyPublic, setOnlyPublic] = useState(false);
  const shown = gameRecordEvents(events).filter((e) => !onlyPublic || e.audience === 'public');

  const nameOf = (seat: number) => {
    const s = seats.find((x) => x.seat === seat);
    return s && s.name !== seatName(seat) ? `${seatName(seat)} ${s.name}` : seatName(seat);
  };

  const scopeLabel = (e: GameEvent): string | null => {
    if (e.audience === 'public') return null;
    if (mode === 'god') return audienceText(e.audience);
    if (e.audience.length === 1 && e.audience[0] === mySeat) return '仅你可见';
    return `${e.audience.map(seatName).join('、')}可见`;
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
    <div className="panel">
      <h3>
        对局记录
        <span className="spacer" />
        {mode !== 'spectator' && (
          <label className="row small muted" style={{ gap: 6, fontWeight: 400 }}>
            <input type="checkbox" checked={onlyPublic} onChange={(e) => setOnlyPublic(e.target.checked)} />
            只看公开信息
          </label>
        )}
      </h3>
      <div className="log-wrap">
        <div className="log" ref={box}>
          {!shown.length && <div className="muted small">还没有记录。</div>}
          {shown.map((e) => {
            const key = `${e.day}:${e.phase}`;
            const divider =
              key !== lastKey && e.phase !== 'setup' ? (
                <div className={`log-divider ${e.phase}`}>
                  {e.phase !== 'end' && <PhaseIcon phase={e.phase} size={14} />}
                  {phaseLabel(e.day, e.phase)}
                </div>
              ) : null;
            lastKey = key;
            return (
              <Fragment key={e.seq}>
                {divider}
                {e.type !== 'phase' && <EventItem e={e} nameOf={nameOf} scope={scopeLabel(e)} />}
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
            回到最新
          </button>
        )}
      </div>
    </div>
  );
}

function EventItem({ e, nameOf, scope }: { e: GameEvent; nameOf: (s: number) => string; scope: string | null }) {
  const p = e.payload;
  const meta = scope ? <span className="meta">{scope}</span> : null;

  if (e.type === 'speech' || e.type === 'wolf.chat') {
    const seat = p.seat as number;
    const wolf = e.type === 'wolf.chat';
    const kind = wolf ? '狼队密谈' : (SPEECH_KIND[p.kind as string] ?? '发言');
    return (
      <div className={`speech ${wolf ? 'wolfchat' : (p.kind as string)}`} style={seatStyle(seat)}>
        <div className="avatar">{seat}</div>
        <div>
          <div className="who">
            {nameOf(seat)} · {kind}
            {meta}
          </div>
          <div className="bubble">{p.content as string}</div>
        </div>
      </div>
    );
  }

  if (e.type === 'vote.result') return <VoteChart event={e} />;

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
