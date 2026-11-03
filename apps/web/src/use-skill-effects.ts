import { useCallback, useEffect, useRef, useState } from 'react';
import type { Projection } from '@werewolf/protocol';
import type { SkillEffect } from '../../../packages/protocol/src/skill-effects';
import { SkillEffectQueue, visibleSkillEffect } from './skill-effect-queue';

export function useSkillEffects(scope: string, projection: Projection) {
  const tracker = useRef<SkillEffectQueue>(null);
  if (!tracker.current) tracker.current = new SkillEffectQueue();
  const [snapshot, setSnapshot] = useState<{ scope: string; queue: SkillEffect[] }>({ scope, queue: [] });
  useEffect(() => {
    const queue = tracker.current!.update(scope, projection.viewer, projection.events, projection.seats.map((s) => s.seat));
    setSnapshot({ scope, queue });
  }, [scope, projection]);
  const complete = useCallback((sourceSeq: number) => {
    const queue = tracker.current!.complete(scope, sourceSeq);
    setSnapshot({ scope, queue });
  }, [scope]);
  const active = snapshot.scope === scope
    ? visibleSkillEffect(snapshot.queue[0], projection.viewer, projection.events, projection.seats.map((s) => s.seat)) : null;
  return { active, complete };
}
