import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { effectiveAudioAlignment, saveAudioAlignment } from './audio-alignment';
import type { TranscriptAlias } from './audio-content-review';
import type { AudioMeta } from './qwen';

// Imports an existing independent ASR result; never performs an external request.
const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  audio: { type: 'string' }, 'asr-response': { type: 'string' }, locale: { type: 'string' },
  aliases: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('import-audio-alignment --audio=FILE --locale=en|ja [--asr-response=FILE [--aliases=JSON_FILE] | --check]');
  process.exit(0);
}
if (!values.audio || !values.locale) throw Error('Provide --audio and --locale');
if (values.check ? !!values['asr-response'] || !!values.aliases : !values['asr-response']) throw Error('Provide an ASR response for import, or use --check alone');
const audioFile = resolve(values.audio);
if (!values.check) {
  const aliases: unknown = values.aliases ? JSON.parse(await readFile(resolve(values.aliases), 'utf8')) : [];
  if (!Array.isArray(aliases) || aliases.some((a) => !a || typeof a.source !== 'string' || typeof a.transcript !== 'string')) throw Error('Aliases must be an array of {source, transcript} objects');
  await saveAudioAlignment(audioFile, await readFile(resolve(values['asr-response']!), 'utf8'), values.locale, aliases as TranscriptAlias[]);
}
const metadata = JSON.parse(await readFile(`${audioFile}.json`, 'utf8')) as AudioMeta;
const { summary } = await effectiveAudioAlignment(audioFile, metadata, values.locale);
if (!summary) throw Error('No external alignment sidecar');
console.log(JSON.stringify({ audioFile, sidecar: `${audioFile}.alignment.json`, ...summary }, null, 2));
