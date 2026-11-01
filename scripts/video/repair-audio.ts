import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioDigest, auditAudio, type AudioAudit } from './audit-audio';
import { audioInspectionVersion, inspectAudio } from './audio-inspection';
import { readPcm } from './audio';
import { captionsFromWords } from './timeline';
import { assertPlayerSources } from './integrity';
import { synthesizeSpeech } from './tts';
import { clipVoiceProfile, projectDir, type Clip, type Script, type VoiceCatalog } from './project';
import type { SpeechSynthesizer } from './tts-types';

interface RepairEntry {
  id: string; status: 'pending' | 'replaced' | 'failed'; oldDigest: string;
  newDigest?: string; seed?: number; backup?: string;
  attempts: { seed: number; status: 'accepted' | 'rejected'; reason?: string }[];
}
export interface AudioRepairReport {
  format: 'werewolf-audio-repair'; version: 1; roomId: string; runDirectory: string;
  originalTextAndVoicePreserved: true; entries: RepairEntry[]; complete: boolean;
}
interface RepairOptions {
  auto?: boolean; ids?: string[]; audit?: AudioAudit; maxAttempts?: number;
  synthesize?: SpeechSynthesizer;
}
const fatal = (reason: string) => /401|403|429|key is unavailable|quota|insufficient|billing/i.test(reason);

/** A replacement is promoted only after PCM, original text and real word times pass. */
export async function repairAudio(directory: string, options: RepairOptions): Promise<AudioRepairReport> {
  const provider = process.env.VIDEO_TTS_PROVIDER || 'qwen-token-plan';
  if (provider !== 'qwen-token-plan' && !options.synthesize) throw Error('Automatic fresh-seed repair currently supports qwen-token-plan only');
  const attempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw Error('Repair attempts must be between 1 and 5');
  if (!options.auto && !options.ids?.length) throw Error('Select --auto or explicit --clips=IDs');
  const source = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8')) as Script;
  const script = JSON.parse(await readFile(join(directory, 'script.json'), 'utf8')) as Script;
  const clips = JSON.parse(await readFile(join(directory, 'clips.json'), 'utf8')) as Clip[];
  assert.equal(source.status, 'ended', 'Repair requires an ended match');
  assert.equal(source.perspective, 'god', 'Repair requires the authorized god-view project');
  assert.equal(script.roomId, source.roomId, 'Script and source room differ');
  assert.deepEqual(script.events, source.events, 'Project facts changed');
  assertPlayerSources(source, script, clips);
  const audit = options.audit ?? await auditAudio(directory, resolve(directory, 'output/audio-audit-before-repair.json'));
  assert.equal(audit.roomId, source.roomId, 'Audio audit belongs to another room');
  assert.equal(audit.detector, audioInspectionVersion, 'Re-run the audio audit with the current detector');
  const ids = options.ids ?? audit.failedClipIds;
  assert.equal(new Set(ids).size, ids.length, 'Duplicate repair clip IDs');
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('Invalid repair clip ID');
    const clip = clips.find((c) => c.id === id), inspected = audit.clips.find((c) => c.id === id);
    if (!clip || !inspected) throw Error(`Unknown repair clip ${id}`);
    assert.equal(resolve(clip.audioFile), resolve(directory, 'audio', `${id}.wav`), 'Repair target must be in this project audio directory');
    assert.equal(audioDigest(await readFile(clip.audioFile)), inspected.digest, `Stale audio audit for ${id}`);
  }
  const runDirectory = resolve(directory, 'audio-repairs', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
  await mkdir(runDirectory, { recursive: true });
  const report: AudioRepairReport = { format: 'werewolf-audio-repair', version: 1, roomId: source.roomId, runDirectory,
    originalTextAndVoicePreserved: true, entries: [], complete: false };
  const persist = async () => {
    const text = JSON.stringify(report, null, 2) + '\n';
    await writeFile(join(runDirectory, 'report.json'), text);
    await mkdir(join(directory, 'output'), { recursive: true });
    await writeFile(join(directory, 'output/audio-repair-report.json'), text);
  };
  await persist();
  for (const id of ids) {
    const clip = clips.find((c) => c.id === id)!, inspected = audit.clips.find((c) => c.id === id)!;
    const voicesFile = join(directory, 'voices.json');
    const voicesText = await readFile(voicesFile, 'utf8'), voices = JSON.parse(voicesText) as VoiceCatalog;
    const profile = clipVoiceProfile(voices, clip), entry: RepairEntry = { id, status: 'pending', oldDigest: inspected.digest, attempts: [] };
    report.entries.push(entry); await persist();
    const folder = join(runDirectory, id); await mkdir(folder, { recursive: true });
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const seed = ((profile.seed ?? 31415) + attempt) % 2147483648;
      const candidate = join(folder, `attempt-${attempt}.wav`);
      try {
        const meta = await (options.synthesize ?? synthesizeSpeech)(clip.spokenText, { ...profile, seed }, voices.model, candidate);
        assert.equal(meta.text, clip.spokenText, 'Replacement changed the submitted text');
        assert.equal(meta.voice, profile.voice, 'Replacement changed the speaker voice');
        const bytes = await readFile(candidate), pcm = await readPcm(candidate);
        assert.equal(bytes.length, meta.bytes, 'Incomplete replacement audio');
        assert.equal(pcm.sampleRate, 24000, 'Unexpected replacement sample rate');
        const quality = inspectAudio(pcm.samples, pcm.sampleRate);
        assert.equal(quality.issues.length, 0, `Replacement failed audio inspection: ${quality.issues.map((e) => e.kind).join(', ')}`);
        captionsFromWords(meta, quality.duration);
        // Recheck both inputs after the external call, before changing any project data.
        assert.equal(audioDigest(await readFile(clip.audioFile)), inspected.digest, 'Audio changed during repair');
        assert.equal(await readFile(voicesFile, 'utf8'), voicesText, 'Voice settings changed during repair');
        const backup = join(folder, 'original.wav');
        await copyFile(clip.audioFile, backup); await copyFile(clip.audioFile + '.json', backup + '.json');
        await writeFile(join(folder, 'voices-before.json'), voicesText);
        const next: VoiceCatalog = { ...voices, clipSeeds: { ...voices.clipSeeds, [id]: seed } };
        await writeFile(voicesFile + '.repair-partial', JSON.stringify(next, null, 2) + '\n');
        await copyFile(candidate, clip.audioFile + '.repair-partial');
        await writeFile(clip.audioFile + '.json.repair-partial', JSON.stringify(meta, null, 2) + '\n');
        try {
          // Persist the new request first: an interrupted resume cannot resurrect the bad seed.
          await rename(voicesFile + '.repair-partial', voicesFile);
          await rename(clip.audioFile + '.repair-partial', clip.audioFile);
          await rename(clip.audioFile + '.json.repair-partial', clip.audioFile + '.json');
        } catch (error) {
          await copyFile(backup, clip.audioFile); await copyFile(backup + '.json', clip.audioFile + '.json');
          await writeFile(voicesFile, voicesText); throw error;
        }
        entry.status = 'replaced'; entry.seed = seed; entry.backup = backup; entry.newDigest = audioDigest(bytes);
        entry.attempts.push({ seed, status: 'accepted' }); await persist();
        console.log(JSON.stringify({ repaired: id, seed, attempts: attempt, waveformIssues: 0, originalTextPreserved: true }));
        break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        entry.attempts.push({ seed, status: 'rejected', reason });
        if (fatal(reason) || /changed during repair/.test(reason) || ['EACCES', 'EPERM', 'ENOSPC'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          entry.status = 'failed'; await persist(); throw error;
        }
        console.log(JSON.stringify({ repair: id, attempt, rejected: reason }));
        if (attempt === attempts) entry.status = 'failed';
        await persist();
      }
    }
  }
  report.complete = report.entries.every((c) => c.status === 'replaced'); await persist();
  return report;
}

export async function rebuildAudioVideo(directory: string) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const settingsFile = join(directory, 'encoding-settings.json');
  const encoding = existsSync(settingsFile) ? JSON.parse(await readFile(settingsFile, 'utf8')) : {};
  const script = JSON.parse(await readFile(join(directory, 'script.json'), 'utf8')) as Script;
  const env = { ...process.env, VIDEO_ROOM: script.roomId, VIDEO_PROJECT_DIR: directory,
    ...(encoding.encoder ? { VIDEO_ENCODER: encoding.encoder } : {}),
    ...(encoding.strictGpu ? { VIDEO_REQUIRE_GPU: '1' } : {}),
    ...(encoding.videoKbps ? { VIDEO_BITRATE_KBPS: String(encoding.videoKbps) } : {}),
    ...(encoding.maxVideoKbps ? { VIDEO_MAXRATE_KBPS: String(encoding.maxVideoKbps) } : {}),
    ...(encoding.audioKbps ? { VIDEO_AUDIO_KBPS: String(encoding.audioKbps) } : {}) };
  const video = join(directory, 'output/latest-match.mp4');
  if (existsSync(video)) {
    const backup = join(directory, 'output/latest-match-before-audio-repair.mp4');
    if (!existsSync(backup)) await copyFile(video, backup);
  }
  for (const stage of ['timeline', 'render', 'preview', 'verify']) {
    console.log(`AUDIO_REPAIR_REBUILD ${stage}`);
    await new Promise<void>((ok, fail) => {
      const child = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), `scripts/video/${stage}.ts`], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
      child.on('error', fail); child.on('close', (code) => code === 0 ? ok() : fail(Error(`Audio repair rebuild ${stage} exited ${code}`)));
    });
  }
  await new Promise<void>((ok, fail) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/video/publish-copy.ts', '--if-exists'], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    child.on('error', fail); child.on('close', (code) => code === 0 ? ok() : fail(Error(`Publication update exited ${code}`)));
  });
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/repair-audio.ts')) {
  const args = process.argv.slice(2);
  for (const arg of args) if (!['--auto', '--rebuild'].includes(arg) && !['--clips=', '--audit=', '--max-attempts='].some((p) => arg.startsWith(p))) throw Error(`Unknown audio repair option ${arg}`);
  const auditFile = args.find((a) => a.startsWith('--audit='))?.slice(8);
  const report = await repairAudio(projectDir, { auto: args.includes('--auto'),
    ids: args.find((a) => a.startsWith('--clips='))?.slice(8).split(','),
    ...(auditFile ? { audit: JSON.parse(await readFile(resolve(projectDir, auditFile), 'utf8')) as AudioAudit } : {}),
    maxAttempts: Number(args.find((a) => a.startsWith('--max-attempts='))?.slice(15) ?? 3) });
  if (!report.complete) throw Error('Some audio repairs failed; originals and successful replacements were preserved');
  const after = await auditAudio(projectDir, resolve(projectDir, 'output/audio-audit-after.json'));
  if (after.failedClipIds.length) throw Error(`Audio issues remain: ${after.failedClipIds.join(', ')}`);
  if (args.includes('--rebuild')) await rebuildAudioVideo(projectDir);
  console.log(JSON.stringify({ complete: true, repaired: report.entries.map((c) => c.id), audioAuditPassed: true, rebuilt: args.includes('--rebuild') }));
}
