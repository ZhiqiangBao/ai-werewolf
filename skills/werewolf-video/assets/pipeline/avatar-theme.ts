import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { characterVoices } from './character-voices';
import type { Cast, VoiceCatalog } from './project';
import { characterVoiceDirection } from './character-delivery';

export async function bindTheme(directory: string, roomFile: string, override?: string, preferBound = false): Promise<string> {
  const room = JSON.parse(await readFile(roomFile, 'utf8')) as { avatarStyle?: string };
  const binding = join(directory, 'avatar-theme.json');
  const bound = preferBound && existsSync(binding) ? (JSON.parse(await readFile(binding, 'utf8')) as { theme?: string }).theme : undefined;
  const theme = override || bound || room.avatarStyle || 'campus';
  if (!Object.hasOwn(characterVoices, theme)) throw Error(`Unsupported avatar theme: ${theme}`);
  await mkdir(directory, { recursive: true });
  if (existsSync(binding)) {
    const saved = JSON.parse(await readFile(binding, 'utf8')) as { theme?: string };
    if (saved.theme !== theme) throw Error(`Avatar theme conflict: project is ${saved.theme}, requested ${theme}; use a new project directory or explicitly migrate and verify its voices and caches`);
  } else {
    // A previous workflow report can establish the old theme. An unbound directory
    // containing voice or media artifacts must never be guessed or overwritten.
    const status = join(directory, 'workflow-status.json');
    const previous = existsSync(status) ? JSON.parse(await readFile(status, 'utf8')) as { theme?: string } : undefined;
    const artifacts = (await readdir(directory)).some((name) => ['voices.json', 'audio', 'segments', 'timeline.json', 'script.json', 'source.json'].includes(name));
    if (previous?.theme && previous.theme !== theme) throw Error(`Avatar theme conflict: project was ${previous.theme}, requested ${theme}; use a new project directory or explicitly migrate and verify its voices and caches`);
    if (artifacts && !previous?.theme) throw Error('Existing project has no verifiable avatar theme; use a new project directory or explicitly establish and verify its theme, voices and caches');
    await writeFile(binding, JSON.stringify({ theme }, null, 2));
  }
  return theme;
}

export function artManifest(theme: string, cast: Cast[], voices: VoiceCatalog) {
  const characters = characterVoices[theme as keyof typeof characterVoices];
  if (!characters) throw Error(`Unsupported avatar theme: ${theme}`);
  return { theme, atlas: resolve('apps/web/public/art/moon-village', `avatars-${theme}-v1.webp`), grid: { columns: 4, rows: 3, order: 'left-to-right, top-to-bottom', crop: 'full cell' },
    seats: cast.map((c) => {
      const character = characters[c.seat - 1];
      if (!character || !voices.profiles[c.voiceKey]) throw Error(`Missing character or voice for seat ${c.seat}`);
      return { seat: c.seat, name: c.name, row: Math.floor((c.seat - 1) / 4) + 1, column: (c.seat - 1) % 4 + 1,
        appearance: character.appearance, gender: character.gender, voiceKey: c.voiceKey, voice: voices.profiles[c.voiceKey].voice,
        voiceDirection: characterVoiceDirection(theme, c.seat), instruction: voices.profiles[c.voiceKey].instruction };
    }) };
}
