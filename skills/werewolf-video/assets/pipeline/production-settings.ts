import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodingSettings } from './encoding';

const options = {
  profile: ['--encoding-profile', 'VIDEO_ENCODING_PROFILE'],
  videoKbps: ['--video-kbps', 'VIDEO_BITRATE_KBPS'],
  maxVideoKbps: ['--max-video-kbps', 'VIDEO_MAXRATE_KBPS'],
  maxTotalKbps: ['--max-total-kbps', 'VIDEO_MAX_TOTAL_KBPS'],
  audioKbps: ['--audio-kbps', 'VIDEO_AUDIO_KBPS'],
  bufferKbits: ['--buffer-kbits', 'VIDEO_BUFFER_KBITS'],
  quality: ['--video-quality', 'VIDEO_QUALITY'],
} as const;
export type RateRequest = Partial<Record<keyof typeof options, string | number>>;

/** Only store requested limits. Resolved historical encoder defaults are not user preferences. */
function requestEnvironment(request: RateRequest): NodeJS.ProcessEnv {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw Error('encoding must be an object');
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(request)) {
    if (!Object.hasOwn(options, name)) throw Error(`Unknown encoding option: ${name}`);
    if ((typeof value !== 'number' && typeof value !== 'string') || !String(value).trim()) throw Error(`Invalid encoding option: ${name}`);
    env[options[name as keyof typeof options][1]] = String(value);
  }
  return env;
}
export function rateEnvironment(request: RateRequest): NodeJS.ProcessEnv {
  const env = requestEnvironment(request);
  encodingSettings({ ...process.env, ...env });
  return env;
}

/** Explicit environment wins over the project request without changing either. */
export async function readProjectEncodingEnvironment(dir: string, explicit: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  let request: RateRequest = {};
  try { request = JSON.parse(await readFile(join(dir, 'encoding-request.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const env = { ...requestEnvironment(request), ...explicit };
  encodingSettings(env);
  return env;
}

export async function projectRateRequest(dir: string, args: Map<string, string>, resume: boolean) {
  const file = join(dir, 'encoding-request.json');
  let request: RateRequest = {};
  if (resume) {
    try { request = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const name of Object.keys(options) as (keyof typeof options)[]) {
    const [flag, variable] = options[name];
    const value = args.get(flag) ?? process.env[variable] ?? request[name];
    if (value !== undefined) request[name] = value;
  }
  const env = rateEnvironment(request);
  const tmp = file + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(request, null, 2));
  await rename(tmp, file);
  return env;
}
