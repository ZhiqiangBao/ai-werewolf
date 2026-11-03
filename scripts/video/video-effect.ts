import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import type { GameEvent, Viewer } from '../../packages/protocol/src/index';
import { seatPosition } from './geometry';
import { drawSkillEffect, skillEffectForEvent, SKILL_EFFECT_DURATION_MS } from './skill-effects';
import { FPS, type Script, type TimedClip } from './project';

const require = createRequire(import.meta.url);
const { createCanvas, Path2D } = require(process.env.VIDEO_CANVAS_MODULE || '@napi-rs/canvas');
export const videoEffectVersion = 'skill-overlay-v1';

/** Only documented action types receive a target label; unrelated targets are not wolf attacks. */
export function actionTargetLabel(type: string): string | undefined {
  return ({ 'guard.protect': '守护目标', 'seer.result': '查验目标', 'mirror.result': '查验目标', 'witch.save': '使用解药',
    'witch.poison': '使用毒药', 'wolf.kill.result': '狼刀目标', 'awakened.knife': '狼刀目标', 'hunter.shot': '开枪目标', 'shot': '开枪目标' } as Record<string, string>)[type];
}

/** Only animate the actual recorded event, never a preceding cue or a later replay. */
export function clipSkillEffect(script: Script, clip: TimedClip) {
  if (clip.data.presentationOnly || clip.part !== 1) return null;
  const fact = script.events.find((event) => event.sourceSeq === clip.sourceSeq && event.type === clip.type);
  if (!fact) return null;
  const viewer: Viewer = script.perspective === 'player' && script.playerSeat ? { kind: 'seat', seat: script.playerSeat } : { kind: 'god' };
  const event = { seq: fact.sourceSeq, day: fact.day, phase: fact.phase, type: fact.type, audience: fact.audience, text: fact.text, payload: fact.data } as GameEvent;
  const effect = skillEffectForEvent(event, viewer, clip.data.replayThrough ?? clip.sourceSeq);
  if (!effect) return null;
  const index = script.cast.findIndex((seat) => seat.seat === effect.target);
  if (index < 0) return null;
  const { cos, sin } = seatPosition(index, script.cast.length);
  return { ...effect, x: Math.round(714 + cos * 565 - 75), y: Math.round(520 + sin * 292 + (sin < -.7 ? -12 : 10) - 75) };
}

/** Transparent, time-varying frames; ffmpeg overlays these on the static scene. */
export async function writeSkillFrames(directory: string, effect: NonNullable<ReturnType<typeof clipSkillEffect>>, clipFrames: number) {
  await mkdir(directory, { recursive: true });
  const canvas = createCanvas(150, 150), context = canvas.getContext('2d');
  const frames = Math.min(clipFrames, Math.ceil(SKILL_EFFECT_DURATION_MS * FPS / 1000));
  for (let frame = 0; frame < frames; frame++) {
    context.clearRect(0, 0, 150, 150);
    drawSkillEffect(context, Path2D, effect.kind, frame * 1000 / FPS, 0, 0, 150);
    await writeFile(`${directory}/${String(frame).padStart(3, '0')}.png`, await canvas.encode('png'));
  }
}
