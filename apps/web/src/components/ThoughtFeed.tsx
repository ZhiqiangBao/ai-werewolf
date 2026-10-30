import { useEffect, useState } from 'react';
import type { SeatInfo, Thought } from '@werewolf/protocol';
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

function ThoughtBody({ thought }: { thought: Thought }) {
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
    </>
  );
}

/** 思考用虚线浅底，正文用实线正文块。发言气泡仍在对局记录里，样式不混用。 */
export function ThoughtFeed({ thoughts, seats }: { thoughts?: Thought[]; seats: SeatInfo[] }) {
  const list = (thoughts ?? []).filter((t) => t.live || t.thinking || t.reply);
  if (!list.length) return null;
  const nameOf = (seat: number) => {
    const s = seats.find((x) => x.seat === seat);
    return s && s.name !== seatName(seat) ? `${seatName(seat)} ${s.name}` : seatName(seat);
  };
  const done = list.filter((t) => !t.live);
  const live = list.filter((t) => t.live);

  return (
    <div className="panel thought-panel">
      <h3>
        模型输出
        <span className="spacer" />
        <span className="muted tiny">只在页面上显示</span>
      </h3>
      {done.length > 0 && (
        <div className="thought-history">
          {done.map((t) => (
            <details key={`${t.decisionId}:${t.seat}`}>
              <summary style={seatStyle(t.seat)}>
                {nameOf(t.seat)}
                {t.thinking ? ' · 思考' : ''}
                {t.reply ? ' · 正文' : ''}
              </summary>
              <ThoughtBody thought={t} />
            </details>
          ))}
        </div>
      )}
      {live.map((t) => (
        <article key={`${t.decisionId}:${t.seat}`} className="thought-live" style={seatStyle(t.seat)}>
          <div className="thought-who">{nameOf(t.seat)} · 正在写</div>
          <ThoughtBody thought={t} />
        </article>
      ))}
    </div>
  );
}
