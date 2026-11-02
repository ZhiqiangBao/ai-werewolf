export type ActionKind = 'speech' | 'vote' | 'skill';
export interface ActionTiming { limitSec: number; intervalMs: number }
export type GameTiming = Record<ActionKind, ActionTiming>;
export const ACTION_KINDS: readonly ActionKind[] = ['speech', 'vote', 'skill'];
export const DEFAULT_GAME_TIMING: Readonly<GameTiming> = Object.freeze({
  speech: Object.freeze({ limitSec: 180, intervalMs: 1200 }),
  vote: Object.freeze({ limitSec: 90, intervalMs: 1200 }),
  skill: Object.freeze({ limitSec: 90, intervalMs: 1200 }),
});
export const defaultGameTiming = (): GameTiming => structuredClone(DEFAULT_GAME_TIMING);
export function actionKind(step: string): ActionKind {
  if (step === 'speech' || step === 'wolf.discuss') return 'speech';
  if (step === 'exile.vote' || step === 'sheriff.vote') return 'vote';
  return 'skill';
}
export function parseGameTiming(value: unknown): GameTiming {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('无效的节奏与时限设置');
  const result = defaultGameTiming();
  for (const kind of ACTION_KINDS) {
    const entry = (value as Record<string, unknown>)[kind];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('缺少行动类型的时间设置');
    const { limitSec, intervalMs } = entry as Record<string, unknown>;
    if (typeof limitSec !== 'number' || !Number.isInteger(limitSec) || limitSec < 1 || limitSec > 3600 ||
        typeof intervalMs !== 'number' || !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000) throw Error('行动时限为 1–3600 秒，推进间隔为 0–60000 毫秒');
    result[kind] = { limitSec, intervalMs };
  }
  return result;
}
