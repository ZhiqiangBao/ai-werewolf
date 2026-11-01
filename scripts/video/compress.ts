import { spawn, execFileSync } from 'node:child_process';
import { stat, rename, writeFile } from 'node:fs/promises';
import { projectDir, ffmpeg, ffprobe } from './project';
const get = (name: string) => process.argv.find((s) => s.startsWith(name + '='))?.slice(name.length + 1);
const input = get('--input') || `${projectDir}/output/latest-match.mp4`;
const output = get('--output') || `${projectDir}/output/latest-match-share.mp4`;
if (input === output) throw Error('Keep the source video; choose a different output file');
const crf = Number(get('--crf') ?? 28); if (!Number.isFinite(crf) || crf < 18 || crf > 35) throw Error('CRF must be between 18 and 35');
const seconds = Number(get('--seconds') || 0); if (!Number.isFinite(seconds) || seconds < 0) throw Error('Invalid trial duration');
const start = Number(get('--start') || 0); if (!Number.isFinite(start) || start < 0) throw Error('Invalid start time');
const threads = Number(get('--threads') || 4); if (!Number.isInteger(threads) || threads < 1 || threads > 16) throw Error('Invalid thread count');
const pending = output.replace(/\.mp4$/i, '') + '.partial.mp4';
await new Promise<void>((ok, fail) => {
  const options = ['-hide_banner', '-loglevel', 'warning', '-y', '-threads', String(threads), ...(start ? ['-ss', String(start)] : []), '-i', input, ...(seconds ? ['-t', String(seconds)] : []), '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '0', '-map_chapters', seconds ? '-1' : '0',
    '-c:v', 'libx264', '-preset', 'medium', '-tune', 'stillimage', '-crf', String(crf), '-threads', String(threads), '-g', '240', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', pending];
  const child = spawn(ffmpeg, options, { windowsHide: true, stdio: 'inherit' }); child.on('error', fail); child.on('close', (code) => code === 0 ? ok() : fail(Error(`Compression stopped with code ${code}`)));
});
await rename(pending, output);
const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', output], { encoding: 'utf8', windowsHide: true }));
const report = { input, output, crf, resolution: 'source retained', codec: 'H.264', audio: 'AAC 96kbps', trialSeconds: seconds || null, startSeconds: start, threads,
  sourceBytes: (await stat(input)).size, outputBytes: (await stat(output)).size, duration: Number(info.format.duration), streams: info.streams };
await writeFile(output + '.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
