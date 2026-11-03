/** 独立素材样片：node node_modules/tsx/dist/cli.mjs scripts/video/skill-effects-demo.ts */
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { drawSkillEffect, SKILL_EFFECT_DURATION_MS, type SkillEffectKind } from './skill-effects';

const require = createRequire(import.meta.url);
const { createCanvas, Path2D } = require(process.env.VIDEO_CANVAS_MODULE || '@napi-rs/canvas');
const kinds: SkillEffectKind[] = ['poison', 'shot', 'inspect', 'guard', 'wolf'];
const output = resolve(process.argv.find((arg) => arg.startsWith('--output='))?.slice(9) || 'data/video/skill-effects-demo/skill-effects.mp4');
await mkdir(dirname(output), { recursive: true });
const encoder = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'png', '-r', '30', '-i', '-', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output], { stdio: ['pipe', 'ignore', 'inherit'] });
const done = once(encoder, 'close');
const canvas = createCanvas(1200, 300), g = canvas.getContext('2d');
for (let frame = 0; frame < Math.ceil((SKILL_EFFECT_DURATION_MS + 500) / 1000 * 30); frame++) {
  g.fillStyle = '#11192a'; g.fillRect(0, 0, 1200, 300);
  kinds.forEach((kind, i) => {
    g.fillStyle = '#1e2c40'; g.beginPath(); g.roundRect(i * 240 + 10, 15, 220, 270, 20); g.fill();
    drawSkillEffect(g, Path2D, kind, frame * 1000 / 30, i * 240 + 25, 25, 190);
    g.fillStyle = '#e1e9f4'; g.font = '20px sans-serif'; g.textAlign = 'center'; g.fillText(kind.toUpperCase(), i * 240 + 120, 255);
  });
  if (!encoder.stdin.write(canvas.toBuffer('image/png'))) await once(encoder.stdin, 'drain');
}
encoder.stdin.end();
const [code] = await done;
if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
console.log(output);
