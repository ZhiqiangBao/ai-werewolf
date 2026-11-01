export interface EncodingSettings {
  encoder: 'h264_nvenc' | 'libx264';
  videoKbps: number;
  maxVideoKbps: number;
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
  const encoder = env.VIDEO_ENCODER || 'h264_nvenc';
  if (encoder !== 'h264_nvenc' && encoder !== 'libx264') throw Error('Unsupported video encoder');
  const videoKbps = numberOption(env, 'VIDEO_BITRATE_KBPS', 750, 200, 10000);
  const maxVideoKbps = numberOption(env, 'VIDEO_MAXRATE_KBPS', 1200, videoKbps, 20000);
  return { encoder, videoKbps, maxVideoKbps,
    bufferKbits: numberOption(env, 'VIDEO_BUFFER_KBITS', maxVideoKbps * 2, maxVideoKbps, 40000),
    quality: numberOption(env, 'VIDEO_QUALITY', 30, 15, 40),
    audioKbps: numberOption(env, 'VIDEO_AUDIO_KBPS', 96, 64, 320), gop: 240,
    strictGpu: env.VIDEO_REQUIRE_GPU === '1' };
}
export function videoEncodingArgs(settings: EncodingSettings, encoder = settings.encoder): string[] {
  const rate = ['-b:v', `${settings.videoKbps}k`, '-maxrate', `${settings.maxVideoKbps}k`, '-bufsize', `${settings.bufferKbits}k`];
  const codec = encoder === 'h264_nvenc'
    ? ['-c:v', encoder, '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', String(settings.quality),
      '-multipass', 'qres', '-rc-lookahead', '16', '-surfaces', '32', '-spatial-aq', '1', '-temporal-aq', '1', '-aq-strength', '8']
    : ['-c:v', 'libx264', '-preset', 'medium', '-tune', 'stillimage', '-crf', String(settings.quality - 2), '-threads', '2'];
  return [...codec, ...rate, '-g', String(settings.gop), '-bf', '2', '-pix_fmt', 'yuv420p', '-video_track_timescale', '90000'];
}
