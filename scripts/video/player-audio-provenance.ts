import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { clipVoiceProfile, projectDir, type Clip, type Script, type VoiceCatalog } from './project';
import type { AudioMeta } from './qwen';

interface AudioProof { requestSha256: string; wavSha256: string; metadataSha256: string }
interface Provenance { format: 'werewolf-player-audio-provenance'; version: 1; roomId: string; playerSeat: number; sourceSha256: string; provider: string; clips: Record<string, AudioProof> }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const path = `${projectDir}/player-audio-provenance.json`;
const sourceHash = (source: Script) => digest(JSON.stringify(source));
const requestHash = (source: Script, voices: VoiceCatalog, clip: Clip, provider: string) => digest(JSON.stringify({
  sourceSha256: sourceHash(source), roomId: source.roomId, playerSeat: source.playerSeat, id: clip.id,
  text: clip.spokenText, model: voices.model, profile: clipVoiceProfile(voices, clip, source.locale ?? 'zh-CN'), provider,
}));

async function readProvenance(source: Script, provider?: string): Promise<Provenance | undefined> {
  if (!existsSync(path)) return undefined;
  const proof = JSON.parse(await readFile(path, 'utf8')) as Provenance;
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
  const existing = await readProvenance(source, provider);
  const proof: Provenance = existing ?? { format: 'werewolf-player-audio-provenance', version: 1, roomId: source.roomId,
    playerSeat: source.playerSeat!, sourceSha256: sourceHash(source), provider, clips: {} };
  for (const clip of clips) {
    const wavExists = existsSync(clip.audioFile), metadataExists = existsSync(`${clip.audioFile}.json`);
    if (wavExists || metadataExists || proof.clips[clip.id]) {
      assert(wavExists && metadataExists, `Incomplete player audio cache: ${clip.id}`);
      await checkClip(proof, source, voices, clip);
    }
  }
  let pending = Promise.resolve();
  return async (clip: Clip, meta: AudioMeta) => {
    // Workers serialize manifest updates so each successful synthesis is durably recorded.
    pending = pending.then(async () => {
      const metadata = await readFile(`${clip.audioFile}.json`);
      assert.equal(meta.text, clip.spokenText, `Synthesized text differs: ${clip.id}`);
      assert.deepEqual(JSON.parse(metadata.toString('utf8')), meta, `Synthesized metadata differs: ${clip.id}`);
      proof.clips[clip.id] = { requestSha256: requestHash(source, voices, clip, provider),
        wavSha256: digest(await readFile(clip.audioFile)), metadataSha256: digest(metadata) };
      await writeFile(path, JSON.stringify(proof, null, 2));
    });
    await pending;
  };
}

/** Check raw bytes and request/source binding before timeline creation or reuse. */
export async function assertPlayerRawAudio(source: Script, voices: VoiceCatalog, clips: Clip[]) {
  if (source.perspective !== 'player') return;
  const proof = await readProvenance(source);
  assert(proof, 'Missing player audio provenance');
  for (const clip of clips) await checkClip(proof, source, voices, clip);
}
