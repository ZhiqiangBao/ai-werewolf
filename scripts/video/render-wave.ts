import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { FPS } from './project';
import { avatarWaveSize, createAvatarWaveRgba } from './vertical-scene';

/** Decode the plate once, then repeat it at the source frame rate inside the graph. */
export function stillSceneArgs(plate: string, filters: string, wave?: 'raw' | { pngSequence: string }) {
  const frameRate = String(FPS);
  const plateInput = ['-threads', '1', '-framerate', frameRate, '-i', plate];
  const loop = 'loop=loop=-1:size=1:start=0';
  if (!wave) return [...plateInput, '-filter_threads', '1', '-vf', `${loop},${filters}`];
  const waveInput = wave === 'raw'
    ? ['-thread_queue_size', '4', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${avatarWaveSize}x${avatarWaveSize}`, '-i', 'pipe:0']
    : ['-i', wave.pngSequence];
  const alpha = wave === 'raw' ? ':alpha=straight' : '';
  return [...plateInput, '-threads', '1', '-framerate', frameRate, ...waveInput,
    '-filter_complex_threads', '1', '-filter_complex',
    `[0:v]${loop}[plate];[plate][1:v]overlay=130:370:shortest=1${alpha},${filters}[v]`, '-map', '[v]'];
}

export async function renderWave(args: string[], cwd: string, pcm: Int16Array, frames: number) {
  const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let log = ''; child.stderr.on('data', b => { log = (log + b).slice(-10000); });
  const ended = new Promise<void>((ok, fail) => {
    child.once('error', fail);
    child.once('close', (code, signal) => code === 0 ? ok() : fail(Error(`ffmpeg exited ${code ?? signal}: ${log}`)));
  });
  void ended.catch(() => {});
  function* waveFrames() {
    const rgba = createAvatarWaveRgba(pcm);
    for (let i = 0; i < frames; i++) yield rgba(i);
  }
  try {
    // Each frame exceeds stdin's high-water mark. Wait for it to drain before generating the next.
    await pipeline(waveFrames(), child.stdin);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ['EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED'].includes(code)) {
      // Keep FFmpeg's encoder or filter error when the child closed its input early.
      await ended;
    } else {
      child.kill();
      await ended.catch(() => {});
    }
    throw error;
  }
  await ended;
}
