import { useEffect, useRef, useState } from 'react';
import { SKILL_EFFECT_DURATION_MS, skillEffectFrame, type SkillEffectKind } from '../../../../packages/protocol/src/skill-effects';
import './skill-animation.css';

/** key 应随事件变化；调用方只传入已授权事件转换得到的 kind。 */
export function SkillAnimation({ kind, onComplete }: { kind: SkillEffectKind; onComplete?: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const completed = useRef(onComplete);
  completed.current = onComplete;
  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const time = now - start;
      setElapsed(time);
      if (time < SKILL_EFFECT_DURATION_MS) frame = requestAnimationFrame(tick);
      else completed.current?.();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [kind]);
  return <svg className="skill-animation" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    {skillEffectFrame(kind, elapsed).map((s, i) => <path key={i} d={s.path} fill={s.fill ?? 'none'} stroke={s.stroke ?? 'none'} strokeWidth={s.width} opacity={s.opacity} transform={s.transform} strokeLinecap="round" strokeLinejoin="round" />)}
  </svg>;
}
