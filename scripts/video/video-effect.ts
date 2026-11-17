import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import type { GameEvent, Viewer } from '../../packages/protocol/src/index';
import { seatPosition } from './geometry';
import { drawSkillEffect, skillEffectForEvent, SKILL_EFFECT_DURATION_MS } from './skill-effects';
import { FPS, type Script, type TimedClip } from './project';
import { hostingChoice } from './hosting';
import { videoText } from './video-locale';

const require = createRequire(import.meta.url);
const { createCanvas, Path2D } = require(process.env.VIDEO_CANVAS_MODULE || '@napi-rs/canvas');
export const videoEffectVersion = 'skill-overlay-v3';

/** Only documented action types receive a target label; unrelated targets are not wolf attacks. */
export function actionTargetLabel(type: string): string | undefined {
  return ({ 'guard.protect': '守护目标', 'seer.result': '查验目标', 'mirror.result': '查验目标', 'witch.save': '使用解药',
    'lucky.poison': '使用毒药', 'lucky.guard': '守护目标', 'lucky.inspect': '查验目标', 'witch.poison': '使用毒药', 'wolf.kill.result': '狼刀目标', 'awakened.knife': '狼刀目标', 'wolf_king.shot': '开枪目标', 'hunter.shot': '开枪目标', 'shot': '开枪目标' } as Record<string, string>)[type];
}

type EffectClip = Pick<TimedClip, 'sourceSeq' | 'type' | 'data' | 'text' | 'part' | 'seat' | 'startFrame'>;
const awakenedActions = new Set(['awakened.mimic', 'awakened.skill', 'mirror.result', 'awakened.knife']);

/** A cue can disclose the recorded target, but never advances the replay state. */
function disclosedCue(script: Script, clip: EffectClip, fact: Script['events'][number]): boolean {
  if (script.perspective !== 'god' || clip.part !== 1 || !clip.data.presentationOnly ||
      clip.sourceSeq !== fact.sourceSeq || clip.data.replayThrough !== fact.sourceSeq - 1 ||
      !awakenedActions.has(fact.type) || typeof fact.data.target !== 'number') return false;
  const actor = Array.isArray(fact.audience) && fact.audience.length === 1 ? fact.audience[0] : undefined;
  if (actor === undefined) return false;
  if (fact.type === 'mirror.result' && fact.data.round?.roundKind !== 'awakened' &&
      !script.cast.some((player) => player.seat === actor && player.role === 'awakened_wolf')) return false;
  const fallback = !!fact.data.systemFallback || (Array.isArray(fact.data.fallbackSeats) && fact.data.fallbackSeats.includes(actor));
  if (clip.type === 'hosting.choice' && !fallback && clip.seat === actor && clip.data.target === fact.data.target &&
      clip.data.presentationKey === (fact.type === 'awakened.knife' ? 'wolf-choice' : 'awakened-choice')) {
    return clip.text === hostingChoice(script.locale ?? 'zh-CN', fact.type, fact.data);
  }
  return fact.type === 'awakened.knife' && fallback && clip.type === 'hosting.judge' &&
    clip.data.presentationKey === 'wolf-summary' && clip.data.actionSummary === true &&
    clip.text === videoText(script.locale ?? 'zh-CN', '系统托管，{0}号的攻击目标记为{1}号。', actor, fact.data.target);
}

/** Animate a recorded fact or its validated target disclosure, once per included timeline. */
export function clipSkillEffect(script: Script, clip: TimedClip, clips: readonly EffectClip[] = []) {
  if (clip.part !== 1) return null;
  const fact = script.events.find((event) => event.sourceSeq === clip.sourceSeq && (clip.data.presentationOnly || event.type === clip.type));
  if (!fact) return null;
  const cue = disclosedCue(script, clip, fact);
  if (clip.data.presentationOnly && !cue) return null;
  if (!cue && script.perspective === 'god' && awakenedActions.has(fact.type) &&
      clips.some((other) => other.sourceSeq === fact.sourceSeq && other.startFrame < clip.startFrame && disclosedCue(script, other, fact))) return null;
  const viewer: Viewer = script.perspective === 'player' && script.playerSeat ? { kind: 'seat', seat: script.playerSeat } : { kind: 'god' };
  const event = { seq: fact.sourceSeq, day: fact.day, phase: fact.phase, type: fact.type, audience: fact.audience, text: fact.text, payload: fact.data } as GameEvent;
  const effect = skillEffectForEvent(event, viewer, cue ? fact.sourceSeq : (clip.data.replayThrough ?? clip.sourceSeq));
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
