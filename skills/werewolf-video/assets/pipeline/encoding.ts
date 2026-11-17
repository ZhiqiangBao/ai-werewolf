import { execFileSync, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export interface EncodingSettings {
  profile: 'upload' | 'compact';
  encoder: 'h264_nvenc' | 'libx264';
  videoKbps: number;
  maxVideoKbps: number;
  maxTotalKbps?: number;
  bufferKbits: number;
  quality: number;
  audioKbps: number;
  gop: number;
  strictGpu: boolean;
}
function numberOption(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value < min || value > max) throw Error(`Invalid ${name}`);
  return value;
}
export function encodingSettings(env: NodeJS.ProcessEnv = process.env): EncodingSettings {
  const profile = env.VIDEO_ENCODING_PROFILE || 'compact';
  if (profile !== 'upload' && profile !== 'compact') throw Error('Unsupported video encoding profile');
  const encoder = env.VIDEO_ENCODER || 'h264_nvenc';
  if (encoder !== 'h264_nvenc' && encoder !== 'libx264') throw Error('Unsupported video encoder');
  const compact = profile === 'compact';
  const videoKbps = numberOption(env, 'VIDEO_BITRATE_KBPS', compact ? 750 : 8000, 200, 10000);
  const maxVideoKbps = numberOption(env, 'VIDEO_MAXRATE_KBPS', Math.max(videoKbps, compact ? 1200 : 12000), videoKbps, 20000);
  const maxTotalKbps = env.VIDEO_MAX_TOTAL_KBPS === undefined ? undefined : numberOption(env, 'VIDEO_MAX_TOTAL_KBPS', 0, 1, 30000);
  const audioKbps = numberOption(env, 'VIDEO_AUDIO_KBPS', 96, 64, 320);
  if (maxTotalKbps !== undefined && maxTotalKbps <= audioKbps * 1.1) throw Error('VIDEO_MAX_TOTAL_KBPS must leave room for video and container overhead');
  return { profile, encoder, videoKbps, maxVideoKbps, ...(maxTotalKbps === undefined ? {} : { maxTotalKbps }),
    bufferKbits: numberOption(env, 'VIDEO_BUFFER_KBITS', maxVideoKbps * .5, 1, 40000),
    quality: numberOption(env, 'VIDEO_QUALITY', compact ? 30 : 21, 15, 40),
    audioKbps, gop: compact ? 240 : 60,
    strictGpu: env.VIDEO_REQUIRE_GPU === '1' };
}
export function videoEncodingArgs(settings: EncodingSettings, encoder = settings.encoder): string[] {
  // A small VBV constrains CRF's local excursions; the final file remains authoritative.
  const budget = settings.maxTotalKbps === undefined ? settings.videoKbps : Math.min(settings.videoKbps, settings.maxTotalKbps * .95 - settings.audioKbps);
  const maxrate = Math.max(1, Math.floor(Math.min(budget * .95, settings.maxVideoKbps * .95)));
  const buffer = Math.max(1, Math.floor(Math.min(settings.bufferKbits, maxrate * .25)));
  const rate = ['-maxrate', `${maxrate}k`, '-bufsize', `${buffer}k`];
  const codec = encoder === 'h264_nvenc'
    ? ['-c:v', encoder, '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-b:v', `${maxrate}k`, '-cq', String(settings.quality),
      '-multipass', 'qres', '-rc-lookahead', '16', '-surfaces', '32', '-spatial-aq', '1', '-temporal-aq', '1', '-aq-strength', '8']
    : ['-c:v', 'libx264', '-preset', 'medium', '-tune', 'stillimage', '-crf', String(settings.quality - 2), '-threads', '2'];
  return [...codec, ...rate, '-g', String(settings.gop), '-bf', '2', '-pix_fmt', 'yuv420p', '-video_track_timescale', '90000'];
}

// Peak is the largest packet-byte sum in any decode-time window, divided by
// min(2 seconds, video duration). A short video is measured over its full duration.
export async function verifyEncodingRate(file: string, settings: EncodingSettings, probe = process.env.FFPROBE_PATH || 'ffprobe') {
  const info = JSON.parse(execFileSync(probe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,bit_rate,duration', '-of', 'json', file], { encoding: 'utf8', windowsHide: true }));
  const video = info.streams.find((stream: any) => stream.codec_type === 'video');
  const duration = Number(video?.duration), averageVideoKbps = Number(video?.bit_rate) / 1000;
  const totalDuration = Number(info.format?.duration), bytes = (await stat(file)).size;
  if (!(duration > 0 && totalDuration > 0 && averageVideoKbps > 0)) throw Error('Cannot measure final video bitrate');
  const windowSeconds = Math.min(2, duration);
  const child = spawn(probe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=dts_time,size', '-of', 'compact=p=0:nk=0', file], { windowsHide: true });
  let errorText = ''; child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); });
  const closed = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(Error(`ffprobe exited ${code}: ${errorText}`))); });
  void closed.catch(() => {});
  const window: { time: number; bytes: number }[] = []; let sum = 0, peakBytes = 0, count = 0, lastTime = -Infinity;
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const fields = Object.fromEntries(line.split('|').map(part => part.split('=')));
      const time = Number(fields.dts_time), size = Number(fields.size);
      if (!Number.isFinite(time) || !Number.isFinite(size) || size < 0 || fields.dts_time === undefined) throw Error('Cannot measure video packet rate');
      if (time < lastTime) throw Error('Video packet timestamps are out of order');
      lastTime = time; window.push({ time, bytes: size }); sum += size; count++;
      while (window.length && time - window[0].time >= windowSeconds) sum -= window.shift()!.bytes;
      peakBytes = Math.max(peakBytes, sum);
    }
    await closed;
  } catch (error) { child.kill(); await closed.catch(() => {}); throw error; }
  if (!count) throw Error('No video packets');
  const peakVideoKbps = peakBytes * 8 / (windowSeconds * 1000), averageTotalKbps = bytes * 8 / totalDuration / 1000;
  if (averageVideoKbps > settings.videoKbps || peakVideoKbps > settings.maxVideoKbps || (settings.maxTotalKbps !== undefined && averageTotalKbps > settings.maxTotalKbps))
    throw Error(`Final video bitrate exceeds limit: average ${averageVideoKbps.toFixed(1)}/${settings.videoKbps} kbps, ${windowSeconds}s peak ${peakVideoKbps.toFixed(1)}/${settings.maxVideoKbps} kbps, total ${averageTotalKbps.toFixed(1)}/${settings.maxTotalKbps ?? 'unlimited'} kbps`);
  return { bytes, durationSeconds: totalDuration, averageVideoKbps, averageTotalKbps, peakVideoKbps, peakWindowSeconds: windowSeconds };
}

/** Apply explicit job/CLI values before resolving the shared environment. */
export function applyEncodingOptions(options: unknown) {
  if (options === undefined) return;
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('Invalid encoding options');
  const names: Record<string, string> = { profile: 'VIDEO_ENCODING_PROFILE', videoKbps: 'VIDEO_BITRATE_KBPS', maxVideoKbps: 'VIDEO_MAXRATE_KBPS', maxTotalKbps: 'VIDEO_MAX_TOTAL_KBPS', audioKbps: 'VIDEO_AUDIO_KBPS', quality: 'VIDEO_QUALITY', bufferKbits: 'VIDEO_BUFFER_KBITS' };
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(names, key) || (typeof value !== 'string' && typeof value !== 'number')) throw Error(`Invalid encoding option: ${key}`);
    process.env[names[key]] = String(value);
  }
}
export function encodingCliOverrides(args: string[]): NodeJS.ProcessEnv {
  const names: Record<string, string> = { 'encoding-profile': 'VIDEO_ENCODING_PROFILE', 'video-kbps': 'VIDEO_BITRATE_KBPS', 'max-video-kbps': 'VIDEO_MAXRATE_KBPS', 'max-total-kbps': 'VIDEO_MAX_TOTAL_KBPS', 'audio-kbps': 'VIDEO_AUDIO_KBPS', 'video-quality': 'VIDEO_QUALITY', 'buffer-kbits': 'VIDEO_BUFFER_KBITS' };
  const result: NodeJS.ProcessEnv = {};
  for (const arg of args) { const match = /^--([^=]+)=(.*)$/.exec(arg); if (match && Object.hasOwn(names, match[1])) result[names[match[1]]] = match[2]; }
  return result;
}
export function applyEncodingCli(args: string[]) {
  Object.assign(process.env, encodingCliOverrides(args));
}
