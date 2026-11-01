import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve, relative } from 'node:path';
import { audioInspectionVersion, inspectAudio, type AudioInspection } from './audio-inspection';
import { readPcm, wavHeader } from './audio';
import { captionsFromWords } from './timeline';
import { FPS, projectDir, type Clip } from './project';
import type { AudioMeta } from './tts-types';

export const audioDigest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface AuditedClip {
  id: string; sourceSeq: number; voiceKey: string; seat?: number; audioFile: string;
  digest: string; cacheKey: string; startFrame: number; inspection: AudioInspection;
  alignmentError?: string;
}
export interface AudioAudit {
  format: 'werewolf-audio-audit'; version: 1; detector: string; roomId: string;
  generatedAt: string; clipCount: number; failedClipIds: string[]; clips: AuditedClip[];
}
export const timecode = (seconds: number) => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

export async function auditAudio(directory: string, reportFile = resolve(directory, 'output/audio-audit.json'), excerpts = true): Promise<AudioAudit> {
  const clips = JSON.parse(await readFile(resolve(directory, 'clips.json'), 'utf8')) as Clip[];
  const script = JSON.parse(await readFile(resolve(directory, 'script.json'), 'utf8')) as { roomId: string };
  const findings: AuditedClip[] = []; let cursor = 0;
  const reviewDir = resolve(dirname(reportFile), `${basename(reportFile, '.json')}-review`);
  await mkdir(dirname(reportFile), { recursive: true });
  const lines = ['# 配音自动检查', '', '检测原始 PCM，时间位置由实际音频长度及制作停顿计算。可识别非零平段、削波与近乎静音；不把音量触顶一两次直接判成破音。此报告不替代语义、音色及主观听感审核。', '', '| 片段 | 发言者 | 成片位置 | 异常 | 持续时间 | 样音 |', '| --- | --- | --- | --- | --- | --- |'];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i], bytes = await readFile(clip.audioFile);
    if (!/^[a-zA-Z0-9_-]+$/.test(clip.id)) throw Error('Invalid audio clip ID');
    const { samples, sampleRate } = await readPcm(clip.audioFile), inspection = inspectAudio(samples, sampleRate);
    const meta = JSON.parse(await readFile(clip.audioFile + '.json', 'utf8')) as AudioMeta;
    let alignmentError: string | undefined;
    try {
      if (meta.text !== clip.spokenText) throw Error('Audio text differs from the recorded script');
      if (meta.bytes !== bytes.length) throw Error('Audio bytes differ from the saved metadata');
      captionsFromWords(meta, inspection.duration);
    } catch (error) { alignmentError = error instanceof Error ? error.message : String(error); }
    const item: AuditedClip = { id: clip.id, sourceSeq: clip.sourceSeq, voiceKey: clip.voiceKey, ...(clip.seat === undefined ? {} : { seat: clip.seat }),
      audioFile: clip.audioFile, digest: audioDigest(bytes), cacheKey: meta.cacheKey, startFrame: cursor, inspection, ...(alignmentError ? { alignmentError } : {}) };
    findings.push(item);
    for (const [n, event] of inspection.issues.entries()) {
      let preview = '';
      if (excerpts) {
        await mkdir(reviewDir, { recursive: true });
        const start = Math.max(0, Math.floor((event.start - .6) * sampleRate));
        const end = Math.min(samples.length, Math.ceil((Math.min(event.end, event.start + 4) + .6) * sampleRate));
        const gain = Math.min(1, .65 / Math.max(.001, inspection.peak));
        const pcm = Buffer.alloc((end - start) * 2);
        for (let j = start; j < end; j++) pcm.writeInt16LE(Math.round(samples[j] * gain), (j - start) * 2);
        const file = resolve(reviewDir, `${clip.id}-${n + 1}.wav`);
        await writeFile(file, Buffer.concat([wavHeader(end - start, sampleRate), pcm]));
        preview = `[试听](${relative(dirname(reportFile), file).replace(/\\/g, '/')})`;
      }
      lines.push(`| ${clip.id} | ${clip.seat ? `${clip.seat}号` : clip.voiceKey} | ${timecode(cursor / FPS + event.start)} | ${event.kind}：${event.detail} | ${(event.end - event.start).toFixed(3)}秒 | ${preview} |`);
    }
    if (alignmentError) lines.push(`| ${clip.id} | ${clip.voiceKey} | ${timecode(cursor / FPS)} | 时间戳／原稿校验失败 | — | — |`);
    const next = clips[i + 1];
    const pause = !next || next.chapter !== clip.chapter ? .8 : next.sourceSeq !== clip.sourceSeq ? .36 : .14;
    cursor += Math.ceil((inspection.duration + pause) * FPS);
  }
  const failedClipIds = findings.filter((c) => c.inspection.issues.length || c.alignmentError).map((c) => c.id);
  const report: AudioAudit = { format: 'werewolf-audio-audit', version: 1, detector: audioInspectionVersion, roomId: script.roomId,
    generatedAt: new Date().toISOString(), clipCount: clips.length, failedClipIds, clips: findings };
  lines.splice(4, 0, `共检查 ${clips.length} 段，发现 ${failedClipIds.length} 段异常。`, '');
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  await writeFile(reportFile.replace(/\.json$/, '') + '.md', lines.join('\n') + '\n');
  return report;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/audit-audio.ts')) {
  const unknown = process.argv.slice(2).filter((a) => !a.startsWith('--report=') && a !== '--fail-on-error' && a !== '--no-excerpts');
  if (unknown.length) throw Error(`Unknown audio audit option ${unknown[0]}`);
  const file = process.argv.find((a) => a.startsWith('--report='))?.slice(9) ?? 'output/audio-audit.json';
  const report = await auditAudio(projectDir, resolve(projectDir, file), !process.argv.includes('--no-excerpts'));
  console.log(JSON.stringify({ roomId: report.roomId, checked: report.clipCount, failedClipIds: report.failedClipIds, report: resolve(projectDir, file) }));
  if (report.failedClipIds.length && process.argv.includes('--fail-on-error')) process.exitCode = 1;
}
