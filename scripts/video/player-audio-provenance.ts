import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { clipVoiceProfile, projectDir, type Clip, type Script, type VoiceCatalog } from './project';
import type { AudioMeta } from './qwen';
import { readPcm } from './audio';
import { inspectAudio } from './audio-inspection';
import { effectiveAudioAlignment } from './audio-alignment';
import { captionsFromWords } from './timeline';

interface AudioProof { requestSha256: string; wavSha256: string; metadataSha256: string; origin?: 'master'; sourceAudioSha256?: string[] }
interface Provenance { format: 'werewolf-player-audio-provenance'; version: 1; roomId: string; playerSeat: number; sourceSha256: string; provider: string; clips: Record<string, AudioProof> }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const path = `${projectDir}/player-audio-provenance.json`;
const sourceHash = (source: Script) => digest(JSON.stringify(source));
const requestHash = (source: Script, voices: VoiceCatalog, clip: Clip, provider: string) => digest(JSON.stringify({
  sourceSha256: sourceHash(source), roomId: source.roomId, playerSeat: source.playerSeat, id: clip.id,
  text: clip.spokenText, model: voices.model, profile: clipVoiceProfile(voices, clip, source.locale ?? 'zh-CN'), provider,
}));

async function readProvenance(source: Script, provider?: string, project = projectDir): Promise<Provenance | undefined> {
  const provenancePath = `${project}/player-audio-provenance.json`;
  if (!existsSync(provenancePath)) return undefined;
  const proof = JSON.parse(await readFile(provenancePath, 'utf8')) as Provenance;
  assert(proof.format === 'werewolf-player-audio-provenance' && proof.version === 1 && proof.roomId === source.roomId &&
    proof.playerSeat === source.playerSeat && proof.sourceSha256 === sourceHash(source) && typeof proof.provider === 'string' &&
    proof.provider.length > 0 && proof.clips && typeof proof.clips === 'object', 'Player audio provenance belongs to another source');
  if (provider !== undefined) assert.equal(proof.provider, provider, 'Player audio provider changed; use a new project directory');
  return proof;
}
async function checkClip(proof: Provenance, source: Script, voices: VoiceCatalog, clip: Clip) {
  const saved = proof.clips[clip.id];
  assert(saved, `Missing player audio provenance: ${clip.id}`);
  assert.equal(saved.requestSha256, requestHash(source, voices, clip, proof.provider), `Player audio request changed: ${clip.id}`);
  assert.equal(saved.wavSha256, digest(await readFile(clip.audioFile)), `Player raw audio digest mismatch: ${clip.id}`);
  assert.equal(saved.metadataSha256, digest(await readFile(`${clip.audioFile}.json`)), `Player audio metadata digest mismatch: ${clip.id}`);
}

/** Refuse pre-existing audio without a matching recorded synthesis before calling a provider. */
export async function preparePlayerAudio(source: Script, voices: VoiceCatalog, clips: Clip[]) {
  if (source.perspective !== 'player') return undefined;
  const provider = process.env.VIDEO_TTS_PROVIDER || 'qwen-token-plan';
  let existing: Provenance | undefined;
  try { existing = await readProvenance(source, provider); } catch { existing = undefined; }
  const proof: Provenance = existing ?? { format: 'werewolf-player-audio-provenance', version: 1, roomId: source.roomId,
    playerSeat: source.playerSeat!, sourceSha256: sourceHash(source), provider, clips: {} };
  const reusable = new Set<string>(), invalid = new Map<string,string>();
  for (const clip of clips) {
    const wavExists = existsSync(clip.audioFile), metadataExists = existsSync(`${clip.audioFile}.json`);
    if (wavExists || metadataExists || proof.clips[clip.id]) {
      try {
        assert(wavExists && metadataExists, `Incomplete player audio cache: ${clip.id}`);
        await checkClip(proof, source, voices, clip);
        const pcm = await readPcm(clip.audioFile), meta = JSON.parse(await readFile(`${clip.audioFile}.json`, 'utf8')) as AudioMeta;
        const aligned = await effectiveAudioAlignment(clip.audioFile, meta, source.locale ?? 'zh-CN');
        if (!inspectAudio(pcm.samples, pcm.sampleRate).issues.length) {
          captionsFromWords(aligned.meta, pcm.samples.length / pcm.sampleRate, source.locale ?? 'zh-CN');
          reusable.add(clip.id);
        }
        if (!reusable.has(clip.id)) invalid.set(clip.id, 'Player audio waveform needs repair: ' + clip.id);
      } catch (error) { invalid.set(clip.id, error instanceof Error ? error.message : String(error)); }
    }
  }
  let pending = Promise.resolve();
  const record = async (clip: Clip, meta: AudioMeta, origin?: 'master', sourceAudioSha256?: string[]) => {
    // Workers serialize manifest updates so each successful synthesis is durably recorded.
    pending = pending.then(async () => {
      const metadata = await readFile(`${clip.audioFile}.json`);
      assert.equal(meta.text, clip.spokenText, `Synthesized text differs: ${clip.id}`);
      assert.deepEqual(JSON.parse(metadata.toString('utf8')), meta, `Synthesized metadata differs: ${clip.id}`);
      proof.clips[clip.id] = { requestSha256: requestHash(source, voices, clip, provider),
        wavSha256: digest(await readFile(clip.audioFile)), metadataSha256: digest(metadata), ...(origin ? { origin } : {}), ...(sourceAudioSha256 ? { sourceAudioSha256 } : {}) };
      await writeFile(`${path}.partial`, JSON.stringify(proof, null, 2));
      await rename(`${path}.partial`, path);
      invalid.delete(clip.id); reusable.add(clip.id);
    });
    await pending;
  };
  const masterCurrent = async (clip: Clip, meta: AudioMeta, hashes: string[]) => {
    const saved = proof.clips[clip.id];
    return reusable.has(clip.id) && saved?.origin === 'master' && JSON.stringify(saved.sourceAudioSha256) === JSON.stringify(hashes) &&
      JSON.stringify(JSON.parse(await readFile(`${clip.audioFile}.json`, 'utf8'))) === JSON.stringify(meta);
  };
  return Object.assign(record, { reused: reusable, invalid, masterCurrent });
}

/** Check raw bytes and request/source binding before timeline creation or reuse. */
export async function assertPlayerRawAudio(source: Script, voices: VoiceCatalog, clips: Clip[], project = projectDir) {
  if (source.perspective !== 'player') return new Set<string>();
  const proof = await readProvenance(source, undefined, project);
  assert(proof, 'Missing player audio provenance');
  for (const clip of clips) await checkClip(proof, source, voices, clip);
  return new Set(clips.filter(clip => proof.clips[clip.id].origin === 'master').map(clip => clip.id));
}
