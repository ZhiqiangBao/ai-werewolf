// Keep the offline renderer usable when bootstrapped into a checkout with an older web UI.
export function seatPosition(index: number, count: number) {
  const twelve = [-80, -55, -22, 22, 55, 80, 100, 125, 158, 202, 235, 260];
  const degrees = count === 12 ? twelve[index] : -90 + 360 * (index + .5) / Math.max(1, count);
  const angle = degrees * Math.PI / 180;
  return { cos: Math.cos(angle), sin: Math.sin(angle) };
}

export function voteCardLayout(rowCount: number) {
  const rows = Math.max(1, Math.min(4, rowCount));
  const height = 112 + rows * 52;
  return { x: 509, y: 520 - height / 2, width: 410, height, waveY: 520 + height / 2 + 12 };
}

// The scene and ASS captions share these bounds so text never covers the speaker.
export const subtitleLayout = {
  panel: { x: 28, y: 942, width: 1864, height: 111 },
  avatar: { x: 50, y: 956, size: 84 },
  identity: { x: 152, titleY: 980, nameY: 1017, width: 252 },
  divider: { x: 426, y: 961, height: 73 },
  caption: { x: 454, y: 956, width: 1410, height: 83, centerX: 1159, centerY: 998 },
} as const;
