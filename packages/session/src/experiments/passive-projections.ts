import { createHash } from 'node:crypto';
import { buildRules, createGame, projectSeat, submit } from '@werewolf/engine';
import type { GameEvent } from '@werewolf/protocol';

/** Fixed engine-generated inputs: stub responses never advance these frames. */
export function fixedProjections(seed: string): Record<string, [string, string]> {
  const rules = buildRules('standard12', {}); const initial = createGame({ id: 'passive-fixed', rules, seed });
  let state = initial.state; const events: GameEvent[] = [...initial.events];
  const first = Array.from({ length: 12 }, (_, i) => JSON.stringify(projectSeat(state, events, i + 1)));
  const window = state.pending?.id;
  for (let count = 0; count < 50 && state.pending?.id === window; count++) {
    const pending = state.pending!; const seat = pending.actors.find(actor => !pending.submissions[actor]);
    if (seat === undefined) throw new Error('fixed projection could not advance');
    const result = submit(state, { seat, call: { tool: '', args: {} }, auto: true });
    if (result.error) throw new Error(result.error.reason); state = result.state; events.push(...result.events);
  }
  if (state.pending?.id === window) throw new Error('fixed projection window did not advance');
  return Object.fromEntries(first.map((value, i) => [String(i + 1), [value, JSON.stringify(projectSeat(state, events, i + 1))]]));
}
export function projectionHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
