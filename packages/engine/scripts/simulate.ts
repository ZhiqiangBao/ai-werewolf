/**
 * 用随机合法行动打一局，打印旁观者能看到的公共日志。
 * 用法：pnpm simulate [版型 id] [种子]
 */
import type { GameEvent } from '@werewolf/protocol';
import { buildRules, createGame, getPreset, submit, waitingSeats } from '../src/index';
import { makeRand, randomCall } from '../test/random';

const presetId = process.argv[2] ?? 'standard12';
const seed = process.argv[3] ?? 'demo';
const rules = buildRules(getPreset(presetId).id);
const r = makeRand([...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));

let { state, events } = createGame({ id: 'sim', rules, seed });
const log: GameEvent[] = [...events];
let steps = 0;
while (!state.result && steps++ < 20000) {
  const seat = waitingSeats(state)[0];
  const tools = state.pending!.tools[seat];
  let res = submit(state, { seat, call: randomCall(r, tools) });
  if (res.error) res = submit(state, { seat, call: { tool: '', args: {} }, auto: true });
  state = res.state;
  log.push(...res.events);
}

for (const e of log) {
  if (e.audience !== 'public') continue;
  console.log(e.type === 'review' ? `\n${e.text}` : `[第${e.day}${e.phase === 'night' ? '夜' : '天'}] ${e.text}`);
}
console.log(`\n共 ${steps} 次行动，${log.length} 条事件。`);
