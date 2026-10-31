// Keep the offline renderer usable when bootstrapped into a checkout with an older web UI.
export function seatPosition(index: number, count: number) {
  const twelve = [-80, -55, -22, 22, 55, 80, 100, 125, 158, 202, 235, 260];
  const degrees = count === 12 ? twelve[index] : -90 + 360 * (index + .5) / Math.max(1, count);
  const angle = degrees * Math.PI / 180;
  return { cos: Math.cos(angle), sin: Math.sin(angle) };
}
