import { spawn } from 'node:child_process';
import { avatarWaveFrame } from './vertical-scene';

export async function renderWave(args: string[], cwd: string, pcm: Int16Array, frames: number) {
  const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let log = ''; child.stderr.on('data', b => { log = (log + b).slice(-10000); });
  let error: Error | undefined; child.on('error', e => { error = e; }); child.stdin.on('error', e => { error = e; });
  const ended = new Promise<void>((ok, fail) => { child.once('error', fail); child.once('close', code => code === 0 ? ok() : fail(Error(`ffmpeg exited ${code}: ${log}`))); });
  void ended.catch(() => {});
  try {
    for (let i = 0; i < frames; i++) {
      if (error) throw error;
      await new Promise<void>((ok, fail) => child.stdin.write(avatarWaveFrame(pcm, i), e => e ? fail(e) : ok()));
    }
    child.stdin.end(); await ended;
  } catch (e) { child.kill(); await ended.catch(() => {}); throw e; }
}
