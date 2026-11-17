import { spawn, execFileSync } from 'node:child_process';
import { stat, rename, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { projectDir, ffmpeg, ffprobe } from './project';
import { encodingCliOverrides, encodingSettings, verifyEncodingRate, videoEncodingArgs } from './encoding';
import { readProjectEncodingEnvironment } from './production-settings';
const get = (name: string) => process.argv.find((s) => s.startsWith(name + '='))?.slice(name.length + 1);
const directory = resolve(get('--project-dir') || projectDir);
const input = resolve(get('--input') || `${directory}/output/latest-match.mp4`);
const output = resolve(get('--output') || `${directory}/output/latest-match-share.mp4`);
if (input === output) throw Error('Keep the source video; choose a different output file');
const environment = { ...await readProjectEncodingEnvironment(directory), ...encodingCliOverrides(process.argv.slice(2)) };
const requestedSettings = encodingSettings({ ...environment, VIDEO_ENCODER: 'libx264', VIDEO_REQUIRE_GPU: '0' });
const requestedCrf = get('--crf');
const crf = requestedCrf === undefined ? requestedSettings.quality - 2 : Number(requestedCrf);
if (!Number.isFinite(crf) || (requestedCrf !== undefined && (crf < 18 || crf > 35))) throw Error('CRF must be between 18 and 35');
const settings = { ...requestedSettings, quality: crf + 2 };
const seconds = Number(get('--seconds') || 0); if (!Number.isFinite(seconds) || seconds < 0) throw Error('Invalid trial duration');
const start = Number(get('--start') || 0); if (!Number.isFinite(start) || start < 0) throw Error('Invalid start time');
const threads = Number(get('--threads') || 4); if (!Number.isInteger(threads) || threads < 1 || threads > 16) throw Error('Invalid thread count');
const pending = output.replace(/\.mp4$/i, '') + `.${randomUUID()}.partial.mp4`;
if (pending === input || pending === output) throw Error('Source, output and pending files must be distinct');
const videoArgs = videoEncodingArgs(settings, 'libx264');
try {
await new Promise<void>((ok, fail) => {
  const options = ['-hide_banner', '-loglevel', 'warning', '-y', '-threads', String(threads), ...(start ? ['-ss', String(start)] : []), '-i', input, ...(seconds ? ['-t', String(seconds)] : []), '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '0', '-map_chapters', seconds ? '-1' : '0',
    ...videoArgs, '-threads', String(threads), '-c:a', 'aac', '-b:a', `${settings.audioKbps}k`, '-movflags', '+faststart', pending];
  const child = spawn(ffmpeg, options, { windowsHide: true, stdio: 'inherit' }); child.on('error', fail); child.on('close', (code) => code === 0 ? ok() : fail(Error(`Compression stopped with code ${code}`)));
});
const bitrate = await verifyEncodingRate(pending, settings, ffprobe);
const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', pending], { encoding: 'utf8', windowsHide: true }));
await rename(pending, output);
const report = { input, output, crf, encoding: settings, bitrate, resolution: 'source retained', codec: 'H.264', audio: `AAC ${settings.audioKbps}kbps`, trialSeconds: seconds || null, startSeconds: start, threads,
  sourceBytes: (await stat(input)).size, outputBytes: (await stat(output)).size, duration: Number(info.format.duration), streams: info.streams };
await writeFile(output + '.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await rm(pending, { force: true }); }
