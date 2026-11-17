import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { dataDir, projectDir, loadScript, type Clip, type Script, type VoiceCatalog } from './project';
import { readPcm, wavHeader } from './audio';
import { inspectAudio } from './audio-inspection';
import { createHash } from 'node:crypto';
import { effectiveAudioAlignment } from './audio-alignment';
import { captionsFromWords, sourceCaptionWords } from './timeline';
import type { AudioMeta } from './qwen';

/** Locate only the explicit or standard complete-film project; never search other rooms. */
export async function masterProject(source: Script) {
  const explicit = Boolean(process.env.VIDEO_MASTER_PROJECT);
  const directory = resolve(process.env.VIDEO_MASTER_PROJECT || join(dataDir, 'video', source.roomId));
  if (directory === projectDir) return undefined;
  if (!existsSync(join(directory, 'source.json')) || !existsSync(join(directory, 'clips.json'))) {
    if (explicit) throw Error(`VIDEO_MASTER_PROJECT is missing source.json or clips.json: ${directory}`);
    return undefined;
  }
  const master = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8')) as Script;
  if (master.perspective !== 'god' || master.roomId !== source.roomId || master.status !== 'ended' || (master.locale ?? 'zh-CN') !== (source.locale ?? 'zh-CN')) {
    if (explicit) throw Error(`VIDEO_MASTER_PROJECT is not the completed same-room god view: ${directory}`);
    return undefined;
  }
  // Rebuild the authorization identity in memory when no export has been written.
  // The recorded facts and cast are authoritative; chapter serialization may evolve.
  let canonical: Script;
  const canonicalFile = join(dataDir, 'exports', `${source.roomId}-video-script.json`);
  if (existsSync(canonicalFile)) canonical = await loadScript({ roomId: source.roomId, dataDir });
  else {
    const { projectGod } = await import('../../packages/engine/src/index');
    const { buildVideoScript } = await import('../../packages/protocol/src/index');
    const room = JSON.parse(await readFile(join(dataDir, 'rooms', `${source.roomId}.json`), 'utf8'));
    assert(room.state && room.status === 'ended', 'Master audio requires a completed room');
    const projection = projectGod(room.state, room.events);
    canonical = buildVideoScript(projection, { roomId: source.roomId, viewer: 'host', status: room.status, paused: room.paused,
      presetName: projection.presetName, seats: room.seats.map((seat: any) => ({ seat: seat.seat, name: seat.name, controller: seat.controller })) }) as unknown as Script;
  }
  const eventIdentity = (event: Script['events'][number]) => [event.sourceSeq,event.day,event.phase,event.type,event.audience];
  const sameFacts = isDeepStrictEqual(master.events.map(eventIdentity), canonical.events.map(eventIdentity)) && isDeepStrictEqual(master.cast, canonical.cast) &&
    isDeepStrictEqual(master.result, canonical.result) && (master.locale ?? 'zh-CN') === (canonical.locale ?? 'zh-CN');
  if (!sameFacts) { if (explicit) throw Error(`VIDEO_MASTER_PROJECT does not match the authorized game facts: ${directory}`); return undefined; }
  // New host-attribution fields can change one event in an otherwise identical historic match.
  // Retain only audio whose own full event payload still matches the authorized record.
  const unchangedEvents = new Set(master.events.filter((event,index) => isDeepStrictEqual(event,canonical.events[index])).map(event => event.sourceSeq));
  return { directory, master, unchangedEvents };
}

/** Copy only voice profiles, never full-view editorial or character metadata. */
export async function useMasterVoices(source: Script, voices: VoiceCatalog): Promise<VoiceCatalog> {
  // Never invalidate the request bindings of already recorded player audio.
  if (existsSync(join(projectDir, 'player-audio-provenance.json'))) return voices;
  const master = await masterProject(source);
  if (!master || !existsSync(join(master.directory, 'voices.json'))) return voices;
  const other = JSON.parse(await readFile(join(master.directory, 'voices.json'), 'utf8')) as VoiceCatalog;
  if (other.model !== voices.model) return voices;
  const profiles = { ...voices.profiles };
  for (const key of Object.keys(profiles)) if (other.profiles?.[key]) profiles[key] = { ...profiles[key], voice: other.profiles[key].voice };
  const filterBindings = (bindings: Record<string, string>) => Object.fromEntries(Object.entries(bindings).filter(([key]) => Object.hasOwn(profiles, key)));
  const result = { ...voices, profiles, ...(other.modelVoiceBindings ? { modelVoiceBindings: Object.fromEntries(Object.entries(other.modelVoiceBindings).map(([model, bindings]) => [model, filterBindings(bindings)])) } : {}),
    ...(other.flashVoiceBindings ? { flashVoiceBindings: filterBindings(other.flashVoiceBindings) } : {}) };
  const bindings = result.modelVoiceBindings?.[result.model] ?? (result.model === 'qwen-audio-3.1-tts-flash' ? result.flashVoiceBindings : undefined);
  const seats = source.cast.map(({ voiceKey }) => voiceKey).filter(key => /^seat-\d+$/.test(key));
  if (seats.length && seats.every(key => bindings?.[key] && bindings[key] === profiles[key]?.voice)) delete result.characterVoiceDesign;
  return result;
}


/** Repartition only at real word boundaries. No timestamp is interpolated inside a word. */
async function repartition(directory: string, source: Script, target: Clip, targets: Clip[], candidates: Clip[], record?: ((clip: Clip, meta: AudioMeta, origin?: 'master', sourceAudioSha256?: string[]) => Promise<void>) & { reused?: Set<string>; masterCurrent?: (clip: Clip, meta: AudioMeta, hashes: string[]) => Promise<boolean> }) {
  const clean = (text: string) => text.replace(/\s/gu, '');
  const desired = targets.sort((a, b) => a.part - b.part);
  const originals = candidates.sort((a, b) => a.part - b.part);
  if (!desired.length || !originals.length || originals.some((clip, i) => clip.part !== i + 1 || clip.parts !== originals.length) || desired.some((clip, i) => clip.part !== i + 1 || clip.parts !== desired.length) || clean(desired.map(c => c.spokenText).join('')) !== clean(originals.map(c => c.spokenText).join(''))) return false;
  const index = desired.findIndex(c => c.id === target.id);
  if (index < 0) return false;
  const start = clean(desired.slice(0, index).map(c => c.spokenText).join('')).length;
  const end = start + clean(target.spokenText).length;
  type Piece = { word: import('./qwen').Word; first: number; last: number; file: number };
  const words: Piece[] = [], assets: { pcm: Awaited<ReturnType<typeof readPcm>>; meta: AudioMeta; digest: string }[] = [];
  let offset = 0;
  for (const original of originals) {
    const path = join(directory, 'audio', basename(original.audioFile));
    if (!existsSync(path)) return false;
    if (!existsSync(`${path}.json`)) throw Error(`alignment-required: ${path} (missing metadata)`);
    const bytes = await readFile(path), meta = JSON.parse(await readFile(`${path}.json`, 'utf8')) as AudioMeta;
    assert.equal(meta.text, original.spokenText); assert.equal(meta.bytes, bytes.length);
    const pcm = await readPcm(path);
    assert(!inspectAudio(pcm.samples, pcm.sampleRate).issues.length, `audio-repair-required: ${path}`);
    let aligned: Awaited<ReturnType<typeof effectiveAudioAlignment>>;
    try {
      aligned = await effectiveAudioAlignment(path, meta, source.locale ?? 'zh-CN');
      captionsFromWords(aligned.meta, pcm.samples.length / pcm.sampleRate, source.locale ?? 'zh-CN');
    } catch (error) { throw Error(`alignment-required: ${path}: ${error instanceof Error ? error.message : String(error)}`); }
    const assetIndex = assets.length;
    assets.push({ pcm, meta, digest: createHash('sha256').update(bytes).digest('hex') });
    let previousEnd = 0;
    for (const word of sourceCaptionWords(aligned.meta, source.locale ?? 'zh-CN')) {
      assert(Number.isFinite(word.begin_time) && Number.isFinite(word.end_time) && word.begin_time >= previousEnd && word.end_time > word.begin_time && word.end_time <= pcm.samples.length * 1000 / pcm.sampleRate + 1, `alignment-required: ${path} (invalid source word timing)`);
      previousEnd = word.end_time;
      const size = clean(word.text).length;
      if (!size) continue;
      words.push({ word, first: offset, last: offset + size, file: assetIndex }); offset += size;
    }
  }
  if (offset !== clean(originals.map(c => c.spokenText).join('')).length) throw Error(`alignment-required: ${target.id}; source words do not cover narration`);
  const selected = words.filter(item => item.last > start && item.first < end);
  if (!selected.length || selected[0].first !== start || selected.at(-1)!.last !== end) throw Error(`alignment-required: ${target.id}; segment boundary crosses a source word, align or adjust segmentation`);
  if (assets.some(asset => asset.pcm.sampleRate !== assets[0].pcm.sampleRate || asset.meta.voice !== assets[0].meta.voice || asset.meta.model !== assets[0].meta.model)) throw Error(`alignment-required: ${target.id}; source audio segments have incompatible voices or formats`);
  const sampleRate = assets[0].pcm.sampleRate, buffers: Buffer[] = [], resultWords: import('./qwen').Word[] = [];
  let sampleOffset = 0;
  for (const file of [...new Set(selected.map(item => item.file))]) {
    const all = words.filter(item => item.file === file), part = selected.filter(item => item.file === file);
    const first = all.indexOf(part[0]), last = all.indexOf(part.at(-1)!);
    const before = first ? all[first - 1].word : undefined, after = last + 1 < all.length ? all[last + 1].word : undefined;
    if ((before && before.end_time > part[0].word.begin_time) || (after && part.at(-1)!.word.end_time > after.begin_time)) throw Error(`alignment-required: ${target.id}; overlapping source word times`);
    const from = before ? Math.round((before.end_time + part[0].word.begin_time) / 2 * sampleRate / 1000) : 0;
    const to = after ? Math.round((part.at(-1)!.word.end_time + after.begin_time) / 2 * sampleRate / 1000) : assets[file].pcm.samples.length;
    if (from < 0 || to > assets[file].pcm.samples.length || from >= to) return false;
    const samples = assets[file].pcm.samples.subarray(from, to), bytes = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2)); buffers.push(bytes);
    for (const { word } of part) resultWords.push({ text: word.text, begin_time: word.begin_time - from * 1000 / sampleRate + sampleOffset * 1000 / sampleRate, end_time: word.end_time - from * 1000 / sampleRate + sampleOffset * 1000 / sampleRate });
    sampleOffset += samples.length;
  }
  const audio = Buffer.concat([wavHeader(sampleOffset, sampleRate), ...buffers]);
  const meta: AudioMeta = { cacheKey: createHash('sha256').update(JSON.stringify({ assets: assets.map(a => a.digest), start, end })).digest('hex'),
    model: assets[0].meta.model, voice: assets[0].meta.voice, text: target.spokenText, bytes: audio.length,
    sentences: [{ index: 0, text: target.spokenText, words: resultWords }], alignment: { method: 'forced-alignment', engine: 'source-word-boundaries' } };
  captionsFromWords(meta, sampleOffset / sampleRate, source.locale ?? 'zh-CN');
  await writeFile(target.audioFile, audio); await writeFile(`${target.audioFile}.json`, JSON.stringify(meta, null, 2));
  if (record) await record(target, meta, 'master', assets.map(asset => asset.digest));
  return true;
}

/** Import only audio anchored to the same visible event. */
export async function reuseMasterAudio(source: Script, clips: Clip[], record?: ((clip: Clip, meta: AudioMeta, origin?: 'master', sourceAudioSha256?: string[]) => Promise<void>) & { reused?: Set<string>; masterCurrent?: (clip: Clip, meta: AudioMeta, hashes: string[]) => Promise<boolean> }, allClips: Clip[] = clips, targetScript: Script = source) {
  const located = await masterProject(source);
  if (!located) return new Set<string>();
  const { directory, master } = located;
  const candidates = JSON.parse(await readFile(join(directory, 'clips.json'), 'utf8')) as Clip[];
  let visibleSeq: number[] | undefined;
  if (source.perspective === 'player') {
    const room = JSON.parse(await readFile(join(dataDir, 'rooms', `${source.roomId}.json`), 'utf8'));
    visibleSeq = room.events.filter((event: any) => event.audience === 'public' || (Array.isArray(event.audience) && event.audience.includes(source.playerSeat)))
      .filter((event: any) => event.type !== 'review').map((event: any) => event.seq);
  }
  const masterScriptFile = join(directory, 'script.json');
  const masterScript = source.perspective === 'god' && existsSync(masterScriptFile) ? JSON.parse(await readFile(masterScriptFile, 'utf8')) as Script : master;
  assert(masterScript.roomId === master.roomId && masterScript.perspective === 'god', 'Master script belongs to another view');
  const entries = masterScript.chapters.flatMap(chapter => chapter.entries);
  const reused = new Set<string>();
  for (const originalClip of clips) {
    const clip = { ...originalClip, audioFile: `${originalClip.audioFile}.master-candidate` };
    for (const suffix of ['', '.json', '.alignment.json']) if (existsSync(`${clip.audioFile}${suffix}`)) await unlink(`${clip.audioFile}${suffix}`);
    let stagedMeta: AudioMeta | undefined, stagedHashes: string[] | undefined;
    const stageRecord = async (_clip: Clip, meta: AudioMeta, _origin?: 'master', hashes?: string[]) => { stagedMeta = meta; stagedHashes = hashes; };
    const install = async () => {
      if (!stagedMeta) throw Error(`Missing staged source metadata: ${clip.id}`);
      let sameUnprovenGodAudio = false;
      if (!record && existsSync(originalClip.audioFile) && existsSync(`${originalClip.audioFile}.json`)) {
        try { sameUnprovenGodAudio = createHash('sha256').update(await readFile(originalClip.audioFile)).digest('hex') === createHash('sha256').update(await readFile(clip.audioFile)).digest('hex') &&
          JSON.stringify(JSON.parse(await readFile(`${originalClip.audioFile}.json`, 'utf8'))) === JSON.stringify(stagedMeta); } catch { /* Repair from verified master. */ }
      }
      if (sameUnprovenGodAudio || (record?.masterCurrent && stagedHashes && await record.masterCurrent(originalClip, stagedMeta, stagedHashes))) {
        await unlink(clip.audioFile); await unlink(`${clip.audioFile}.json`); return;
      }
      await rename(clip.audioFile, originalClip.audioFile);
      await rename(`${clip.audioFile}.json`, `${originalClip.audioFile}.json`);
      if (existsSync(`${clip.audioFile}.alignment.json`)) await rename(`${clip.audioFile}.alignment.json`, `${originalClip.audioFile}.alignment.json`);
      else if (existsSync(`${originalClip.audioFile}.alignment.json`)) await unlink(`${originalClip.audioFile}.alignment.json`);
      if (record) await record(originalClip, stagedMeta, 'master', stagedHashes);
    };
    const seq = visibleSeq ? visibleSeq[clip.sourceSeq - 1] : clip.sourceSeq;
    if (!located.unchangedEvents.has(seq)) continue;
    const entry = entries.find(e => e.sourceSeq === seq && e.type === clip.type && e.voiceKey === clip.voiceKey && e.seat === clip.seat && e.data.presentationKey === clip.data.presentationKey);
    // Compare the complete authorized entry as well as the exact spoken part: duplicates cannot cross events.
    const targetEntry = targetScript.chapters.flatMap(chapter => chapter.entries).find(e => e.sourceSeq === clip.sourceSeq && e.type === clip.type && e.voiceKey === clip.voiceKey && e.seat === clip.seat && e.data.presentationKey === clip.data.presentationKey);
    if (!entry || !targetEntry || entry.text !== targetEntry.text || entry.visibility !== targetEntry.visibility) continue;
    const matches = candidates.filter(c => c.sourceSeq === seq && c.type === clip.type && c.voiceKey === clip.voiceKey && c.seat === clip.seat && c.data.presentationKey === clip.data.presentationKey && c.part === clip.part && c.parts === clip.parts && c.spokenText === clip.spokenText && c.text === clip.text);
    if (matches.length !== 1) {
      const sourceParts = candidates.filter(c => c.sourceSeq === seq && c.type === clip.type && c.voiceKey === clip.voiceKey && c.seat === clip.seat && c.data.presentationKey === clip.data.presentationKey);
      const targetParts = allClips.filter(c => c.sourceSeq === clip.sourceSeq && c.type === clip.type && c.voiceKey === clip.voiceKey && c.seat === clip.seat && c.data.presentationKey === clip.data.presentationKey);
      try {
        if (await repartition(directory, source, clip, targetParts, sourceParts, stageRecord)) { await install(); reused.add(clip.id); }
      } catch (error) {
        if (error instanceof Error && error.message.includes('audio-repair-required:') && record?.reused?.has(clip.id)) continue;
        throw error;
      }
      continue;
    }
    const old = join(directory, 'audio', basename(matches[0].audioFile));
    if (!existsSync(old)) continue;
    if (!existsSync(`${old}.json`)) throw Error(`alignment-required: ${old} (missing metadata)`);
    try {
      const meta = JSON.parse(await readFile(`${old}.json`, 'utf8')) as AudioMeta;
      const audio = await readFile(old);
      assert.equal(meta.text, clip.spokenText);
      assert.equal(meta.bytes, audio.length);
      const pcm = await readPcm(old);
      assert(!inspectAudio(pcm.samples, pcm.sampleRate).issues.length, `audio-repair-required: ${old}`);
      const aligned = await effectiveAudioAlignment(old, meta, source.locale ?? 'zh-CN');
      captionsFromWords(aligned.meta, pcm.samples.length / pcm.sampleRate, source.locale ?? 'zh-CN');
      let lastBegin = 0, lastEnd = 0;
      for (const word of aligned.meta.sentences.flatMap(sentence => sentence.words)) {
        assert(Number.isFinite(word.begin_time) && Number.isFinite(word.end_time) && word.begin_time >= lastBegin && word.end_time >= lastEnd && word.end_time > word.begin_time && word.end_time <= pcm.samples.length * 1000 / pcm.sampleRate + 1, 'Invalid source word timing');
        lastBegin = word.begin_time; lastEnd = word.end_time;
      }
      // Import only the authorized words and timestamps, not unrelated source metadata or transcripts.
      const safeMeta: AudioMeta = { cacheKey: createHash('sha256').update(await readFile(`${old}.json`)).digest('hex'),
        model: meta.model, voice: meta.voice, text: clip.spokenText, bytes: audio.length,
        sentences: [{ index: 0, text: clip.spokenText, words: sourceCaptionWords(aligned.meta, source.locale ?? 'zh-CN').map(word => ({ text: word.text, begin_time: word.begin_time, end_time: word.end_time })) }],
        ...(aligned.meta.alignment ? { alignment: { method: aligned.meta.alignment.method, engine: 'source-word-boundaries' } } : {}) };
      await copyFile(old, clip.audioFile);
      await writeFile(`${clip.audioFile}.json`, JSON.stringify(safeMeta, null, 2));
      await stageRecord(clip, safeMeta, 'master', [createHash('sha256').update(audio).digest('hex')]);
      await install();
      reused.add(clip.id);
    } catch (error) {
      // Existing source audio is left untouched; invalid alignment must be repaired at its source.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('audio-repair-required:') && record?.reused?.has(clip.id)) continue;
      throw Error(message.includes('audio-repair-required:') ? message : `alignment-required: ${old}: ${message}`);
    }
  }
  return reused;
}
