import { createCanvas, Path2D } from '@napi-rs/canvas';
import { expect, it } from 'vitest';
import { drawSkillEffect, type SkillEffectKind } from '../../../scripts/video/skill-effects';

it.each<SkillEffectKind>(['poison', 'shot', 'inspect', 'guard', 'wolf'])('%s renders changing offline frames', (kind) => {
  const canvas = createCanvas(100, 100);
  const g = canvas.getContext('2d');
  const frame = (time: number) => {
    g.clearRect(0, 0, 100, 100);
    drawSkillEffect(g as unknown as CanvasRenderingContext2D, Path2D as unknown as typeof globalThis.Path2D, kind, time, 0, 0, 100);
    return g.getImageData(0, 0, 100, 100).data;
  };
  const first = frame(300), second = frame(900);
  expect(first.some((pixel) => pixel !== 0)).toBe(true);
  expect(first).not.toEqual(second);
  expect(frame(1800).every((pixel) => pixel === 0)).toBe(true);
});
