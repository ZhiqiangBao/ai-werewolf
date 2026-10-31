import { useEffect, useState } from 'react';
import { recordedBadgeOutcome, type GameEvent, type SeatInfo, type Thought } from '@werewolf/protocol';
import { seatName, seatStyle } from '../util';

function StreamingText({ text, live }: { text: string; live: boolean }) {
  const [n, setN] = useState(live ? 0 : text.length);
  useEffect(() => {
    if (!live || n >= text.length) return;
    const step = Math.max(1, Math.ceil((text.length - n) / 8));
    const id = window.setTimeout(() => setN((c) => Math.min(text.length, c + step)), 20);
    return () => clearTimeout(id);
  }, [text, live, n]);
  if (!live) return <>{text}</>;
  return (
    <>
      {text.slice(0, n)}
      <span className="thought-caret" />
    </>
  );
}

function ThoughtBody({ thought, events }: { thought: Thought; events: GameEvent[] }) {
  const outcome = recordedBadgeOutcome(thought, events);
  return (
    <>
      {(thought.thinking || (thought.live && !thought.reply)) && (
        <div className="thought-mind">
          <div className="thought-kicker">思考</div>
          {thought.thinking ? <StreamingText text={thought.thinking} live={thought.live && !thought.reply} /> : <span className="thought-caret" />}
        </div>
      )}
      {thought.reply && (
        <div className="thought-body">
          <div className="thought-kicker">正文</div>
          <StreamingText text={thought.reply} live={thought.live} />
        </div>
      )}
      {outcome && (
        <div className="thought-body">
          <div className="thought-kicker">本轮实际结果{outcome.automatic ? ' · 系统托管' : ''}</div>
          {outcome.text}
        </div>
      )}
    </>
  );
}

const SHOW_KEY = 'werewolf-show-thoughts';

/** 思考用虚线浅底，正文用实线正文块。发言气泡仍在对局记录里，样式不混用。默认收起。 */
export function ThoughtFeed({ thoughts, seats, events = [] }: { thoughts?: Thought[]; seats: SeatInfo[]; events?: GameEvent[] }) {
  const list = (thoughts ?? []).filter((t) => t.live || t.thinking || t.reply);
  const [open, setOpen] = useState(() => localStorage.getItem(SHOW_KEY) === '1');
  if (!list.length) return null;
  const nameOf = (seat: number) => {
    const s = seats.find((x) => x.seat === seat);
    return s && s.name !== seatName(seat) ? `${seatName(seat)} ${s.name}` : seatName(seat);
  };
  const done = list.filter((t) => !t.live);
  const live = list.filter((t) => t.live);
  const toggle = (on: boolean) => {
    setOpen(on);
    localStorage.setItem(SHOW_KEY, on ? '1' : '0');
  };

  return (
    <div className="panel thought-panel">
      <h3>
        模型输出
        <span className="spacer" />
        <label className="row small muted" style={{ gap: 6, fontWeight: 400 }}>
          <input type="checkbox" checked={open} onChange={(e) => toggle(e.target.checked)} />
          显示
        </label>
      </h3>
      {!open && live.length > 0 && <div className="muted small">{live.map((t) => nameOf(t.seat)).join('、')}正在写</div>}
      {open && done.length > 0 && (
        <div className="thought-history">
          {done.map((t) => (
            <details key={`${t.decisionId}:${t.seat}`}>
              <summary style={seatStyle(t.seat)}>
                {nameOf(t.seat)}
                {t.thinking ? ' · 思考' : ''}
                {t.reply ? ' · 正文' : ''}
              </summary>
              <ThoughtBody thought={t} events={events} />
            </details>
          ))}
        </div>
      )}
      {open && live.map((t) => (
        <article key={`${t.decisionId}:${t.seat}`} className="thought-live" style={seatStyle(t.seat)}>
          <div className="thought-who">{nameOf(t.seat)} · 正在写</div>
          <ThoughtBody thought={t} events={events} />
        </article>
      ))}
    </div>
  );
}
