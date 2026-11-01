import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AudioMeta } from './types';

// A cache key must cover the complete provider request, including voice, model and instructions.
// Only explicitly configured cache directories are searched; raw logs are never sent to a provider.
const indexes = new Map<string, Promise<Map<string, string[]>>>();
export async function reuseAudio(cacheKey: string, output: string): Promise<AudioMeta | undefined> {
  const config = process.env.VIDEO_AUDIO_CACHE_DIRS;
  if (!config) return;
  const dirs: unknown = JSON.parse(config);
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === 'string')) throw Error('VIDEO_AUDIO_CACHE_DIRS must be a JSON array of directories');
  if (!indexes.has(config)) indexes.set(config, (async () => {
    const index = new Map<string, string[]>();
    for (const directory of dirs) {
      let files: string[];
      try { files = await readdir(resolve(directory)); } catch { continue; }
      for (const name of files.filter((f) => f.endsWith('.wav.json'))) {
        try {
          const path = join(resolve(directory), name.slice(0, -5));
          const meta = JSON.parse(await readFile(path + '.json', 'utf8')) as AudioMeta;
          if (typeof meta.cacheKey === 'string') index.set(meta.cacheKey, [...(index.get(meta.cacheKey) ?? []), path]);
        } catch { /* Ignore incomplete metadata. */ }
      }
    }
    return index;
  })());
  for (const path of (await indexes.get(config)!).get(cacheKey) ?? []) {
    if (resolve(path) === resolve(output)) continue;
    let meta: AudioMeta;
    try {
      meta = JSON.parse(await readFile(path + '.json', 'utf8')) as AudioMeta;
      const bytes = await readFile(path);
      if (meta.cacheKey !== cacheKey || bytes.length !== meta.bytes || bytes.subarray(0, 4).toString() !== 'RIFF') continue;
    } catch { continue; }
    await mkdir(dirname(output), { recursive: true });
    await copyFile(path, output + '.partial'); await rename(output + '.partial', output);
    await writeFile(output + '.json', JSON.stringify(meta, null, 2));
    return meta;
  }
}
