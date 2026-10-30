export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 不透明但可重放的决策编号：连续计数会让玩家从编号跳跃推算夜里有几次隐藏决策。 */
export function decisionId(seed: string, n: number): string {
  return `d${hashSeed(`${seed}#${n}`).toString(36)}${hashSeed(`${n}#${seed}`).toString(36)}`;
}

/** mulberry32。返回 [0,1) 的随机数与下一个内部状态，状态可以序列化进对局状态。 */
export function nextRandom(state: number): [number, number] {
  const t = (state + 0x6d2b79f5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), t | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, t];
}
