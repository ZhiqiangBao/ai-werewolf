import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';

it('encodes all five animations changing and then disappearing', async () => {
  const root = process.cwd(), base = resolve(root, 'data/video-skill-tests');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'encoded-')), video = join(dir, 'effects.mp4');
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/video/skill-effects-demo.ts', `--output=${video}`], { cwd: root, timeout: 60000 });
  const frame = (time: number) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 2_000_000 });
  const a = frame(.3), b = frame(.9), gone = frame(1.9), stillGone = frame(2.1);
  expect(a.length).toBe(1200 * 300 * 3);
  for (let tile = 0; tile < 5; tile++) {
    const distance = (left: Buffer, right: Buffer) => {
      let sum = 0, n = 0;
      for (let y = 30; y < 215; y++) for (let x = tile * 240 + 25; x < tile * 240 + 215; x++) for (let c = 0; c < 3; c++) {
        const i = (y * 1200 + x) * 3 + c; sum += Math.abs(left[i] - right[i]); n++;
      }
      return sum / n;
    };
    expect(distance(a, b), `tile ${tile} must change`).toBeGreaterThan(.3);
    expect(distance(a, gone), `tile ${tile} must be visible`).toBeGreaterThan(.3);
    expect(distance(b, gone), `tile ${tile} must be visible later`).toBeGreaterThan(.3);
    expect(distance(gone, stillGone), `tile ${tile} must disappear`).toBeLessThan(.5);
  }
}, 90000);
