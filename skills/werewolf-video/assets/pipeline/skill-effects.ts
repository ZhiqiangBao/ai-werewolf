import { skillEffectFrame, type SkillEffectKind } from './skill-effects-core';
export { skillEffectForEvent, SKILL_EFFECT_DURATION_MS } from './skill-effects-core';
export type { SkillEffect, SkillEffectKind } from './skill-effects-core';

/** Canvas 的 Path2D 由调用方注入，兼容浏览器和 @napi-rs/canvas。 */
export function drawSkillEffect(g: CanvasRenderingContext2D, Path: typeof Path2D, kind: SkillEffectKind, elapsedMs: number, x: number, y: number, size: number): void {
  g.save();
  g.translate(x, y);
  g.scale(size / 100, size / 100);
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const shape of skillEffectFrame(kind, elapsedMs)) {
    g.save();
    for (const match of shape.transform?.matchAll(/(translate|scale)\(([-.\d]+)(?:[ ,]+([-.\d]+))?\)/g) ?? []) {
      const a = Number(match[2]), b = match[3] === undefined ? undefined : Number(match[3]);
      if (match[1] === 'translate') g.translate(a, b ?? 0);
      else g.scale(a, b ?? a);
    }
    const p = new Path(shape.path);
    g.globalAlpha *= shape.opacity ?? 1;
    if (shape.fill) { g.fillStyle = shape.fill; g.fill(p); }
    if (shape.stroke) { g.strokeStyle = shape.stroke; g.lineWidth = shape.width ?? 1; g.stroke(p); }
    g.restore();
  }
  g.restore();
}
