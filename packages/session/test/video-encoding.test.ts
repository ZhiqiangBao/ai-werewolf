import { describe, expect, it } from 'vitest';
import { encodingSettings, videoEncodingArgs } from '../../../scripts/video/encoding';
import { sceneTransition } from '../../../scripts/video/transitions';

describe('video encoding profiles', () => {
  it('defaults to upload quality and allows selecting compact explicitly', () => {
    expect(encodingSettings({})).toMatchObject({ profile: 'upload', encoder: 'h264_nvenc', videoKbps: 8000, maxVideoKbps: 12000, bufferKbits: 24000, quality: 21, audioKbps: 96, gop: 60 });
    expect(encodingSettings({ VIDEO_ENCODING_PROFILE: 'compact' })).toMatchObject({ profile: 'compact', videoKbps: 750, maxVideoKbps: 1200, bufferKbits: 2400, quality: 30, audioKbps: 96, gop: 240 });
  });

  it('preserves explicit overrides and keeps the default max rate at least the target', () => {
    expect(encodingSettings({ VIDEO_ENCODING_PROFILE: 'compact', VIDEO_BITRATE_KBPS: '9000', VIDEO_QUALITY: '18' })).toMatchObject({ videoKbps: 9000, maxVideoKbps: 9000, bufferKbits: 18000, quality: 18 });
    expect(encodingSettings({ VIDEO_BITRATE_KBPS: '6000', VIDEO_MAXRATE_KBPS: '9000', VIDEO_BUFFER_KBITS: '20000', VIDEO_AUDIO_KBPS: '128', VIDEO_REQUIRE_GPU: '1' })).toMatchObject({ videoKbps: 6000, maxVideoKbps: 9000, bufferKbits: 20000, audioKbps: 128, strictGpu: true });
  });

  it('rejects invalid profiles, encoders, and numeric limits', () => {
    for (const env of [
      { VIDEO_ENCODING_PROFILE: 'unknown' }, { VIDEO_ENCODER: 'unknown' },
      { VIDEO_BITRATE_KBPS: 'NaN' }, { VIDEO_BITRATE_KBPS: '199' },
      { VIDEO_BITRATE_KBPS: '8000', VIDEO_MAXRATE_KBPS: '7999' },
      { VIDEO_MAXRATE_KBPS: '12000', VIDEO_BUFFER_KBITS: '11999' },
      { VIDEO_QUALITY: '41' }, { VIDEO_AUDIO_KBPS: '63' },
    ]) expect(() => encodingSettings(env)).toThrow();
  });

  it('uses the selected GPU quality or CPU fallback CRF with matching rate controls', () => {
    const settings = encodingSettings({ VIDEO_QUALITY: '23' });
    const gpu = videoEncodingArgs(settings);
    expect(gpu).toEqual(expect.arrayContaining(['h264_nvenc', '-cq', '23', '-b:v', '8000k', '-maxrate', '12000k', '-bufsize', '24000k', '-g', '60']));
    expect(gpu.slice(gpu.indexOf('-cq'), gpu.indexOf('-cq') + 2)).toEqual(['-cq', '23']);
    expect(gpu).not.toContain('-crf');
    const cpu = videoEncodingArgs(settings, 'libx264');
    expect(cpu).toEqual(expect.arrayContaining(['libx264', '-crf', '21', '-b:v', '8000k', '-maxrate', '12000k', '-bufsize', '24000k', '-g', '60']));
    expect(cpu.slice(cpu.indexOf('-crf'), cpu.indexOf('-crf') + 2)).toEqual(['-crf', '21']);
    expect(cpu).not.toContain('-cq');
  });
});

describe('scene transitions', () => {
  const base = { phase: 'day', chapter: 'Day 1', frames: 30, voiceKey: 'seat-1', type: 'speech', sourceSeq: 1, text: 'First' };
  it('does not fade at the ends or when speakers, text, or event types change in the same scene', () => {
    const next = { ...base, voiceKey: 'seat-2', type: 'vote', sourceSeq: 2, text: 'Second' };
    expect(sceneTransition(base, undefined, next)).toEqual({ fadeIn: false, fadeOut: false, frames: 4 });
    expect(sceneTransition(next, base, undefined)).toEqual({ fadeIn: false, fadeOut: false, frames: 4 });
  });

  it('fades only at phase or chapter boundaries', () => {
    const previous = { ...base, phase: 'night' }, next = { ...base, chapter: 'Day 2' };
    expect(sceneTransition(base, previous, next)).toEqual({ fadeIn: true, fadeOut: true, frames: 4 });
    expect(sceneTransition(base, previous, base)).toEqual({ fadeIn: true, fadeOut: false, frames: 4 });
    expect(sceneTransition(base, base, next)).toEqual({ fadeIn: false, fadeOut: true, frames: 4 });
  });

  it('does not apply overlapping fades to clips of eight frames or fewer', () => {
    const other = { ...base, phase: 'night' };
    for (const frames of [1, 4, 8]) expect(sceneTransition({ ...base, frames }, other, other)).toEqual({ fadeIn: false, fadeOut: false, frames: 4 });
    expect(sceneTransition({ ...base, frames: 9 }, other, other)).toEqual({ fadeIn: true, fadeOut: true, frames: 4 });
    const short = { ...other, frames: 8 };
    expect(sceneTransition(base, short, other)).toEqual({ fadeIn: false, fadeOut: true, frames: 4 });
    expect(sceneTransition(base, other, short)).toEqual({ fadeIn: true, fadeOut: false, frames: 4 });
  });
});
