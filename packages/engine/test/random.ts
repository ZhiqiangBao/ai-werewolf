import type { ToolCall, ToolSpec } from '@werewolf/protocol';

export type Rand = () => number;

export function makeRand(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: Rand, list: T[]): T => list[Math.floor(r() * list.length)];

/** 在工具参数范围内随机生成一次合法调用。 */
export function randomCall(r: Rand, tools: ToolSpec[]): ToolCall {
  const usable = tools.filter((t) => t.name !== 'wolf_explode' || r() < 0.05);
  const spec = pick(r, usable.length ? usable : tools);
  const args: Record<string, unknown> = {};
  for (const p of spec.params) {
    switch (p.kind) {
      case 'seat': {
        const options: (number | null)[] = [...p.options];
        if (p.nullable) options.push(null);
        args[p.name] = options.length ? pick(r, options) : null;
        break;
      }
      case 'seats': {
        const n = p.min + Math.floor(r() * (p.max - p.min + 1));
        args[p.name] = [...p.options].sort(() => r() - 0.5).slice(0, n);
        break;
      }
      case 'boolean':
        args[p.name] = r() < 0.5;
        break;
      case 'text':
        args[p.name] = p.minLength > 0 ? '我是好人，听我说。' : r() < 0.5 ? '' : '我退水。';
        break;
      case 'choice':
        args[p.name] = pick(r, p.options).value;
        break;
    }
  }
  return { tool: spec.name, args };
}
