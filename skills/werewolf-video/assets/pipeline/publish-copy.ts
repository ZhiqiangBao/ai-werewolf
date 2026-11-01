import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, loadScript, projectDir, type Script } from './project';

interface PublicationRoom {
  seats?: { seat: number; controller?: string; model?: string }[];
}
const START = '<!-- werewolf-publication-details:start -->';
const END = '<!-- werewolf-publication-details:end -->';
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

/** Select public labels explicitly; never copy whole seat configuration objects. */
export function publicationMetadata(room: PublicationRoom, script: Pick<Script, 'roomId' | 'cast' | 'ruleCard'>) {
  if (!script.ruleCard?.trim()) throw Error('Missing recorded rule card; export this match before creating publication details');
  return { roomId: script.roomId, ruleCard: script.ruleCard,
    seats: script.cast.map((c) => {
      const config = room.seats?.find((s) => s.seat === c.seat);
      return { seat: c.seat, name: c.name, controller: config?.controller ?? 'unknown',
        model: config?.controller === 'human' ? null : config?.model?.trim() || null };
    }) };
}

export function withPublicationDetails(copy: string, metadata: ReturnType<typeof publicationMetadata>) {
  if (!/^# 标题\s*$/m.test(copy) || !/^# 简介\s*$/m.test(copy)) throw Error('Publishing copy needs separate 标题 and 简介 headings');
  const rows = metadata.seats.map((s) => `| ${s.seat}号 | ${cell(s.name)} | ${s.controller === 'human' ? '真人' : s.model ? cell(s.model) : 'AI（模型未记录）'} |`);
  const details = [START, '## 本局座位与模型', '', '模型标识按本局存档配置列出；真人席位不展示其闲置的模型配置。', '',
    '| 座位 | 昵称 | 模型／真人 |', '| --- | --- | --- |', ...rows, '',
    '## 本局规则卡', '', metadata.ruleCard.replace(/\n/g, '  \n'), END].join('\n');
  const starts = copy.split(START).length - 1, ends = copy.split(END).length - 1;
  if (!starts && !ends) return copy.trimEnd() + '\n\n' + details + '\n';
  if (starts !== 1 || ends !== 1 || copy.indexOf(START) >= copy.indexOf(END)) throw Error('Publication details markers are malformed');
  return copy.slice(0, copy.indexOf(START)) + details + copy.slice(copy.indexOf(END) + END.length);
}

export async function syncPublishCopy(directory: string, room: PublicationRoom, script: Pick<Script, 'roomId' | 'cast' | 'ruleCard'>, required = false) {
  const file = join(directory, 'output/publish-copy.md');
  if (!existsSync(file)) { if (required) throw Error('Write the final title and introduction to output/publish-copy.md first'); return false; }
  const metadata = publicationMetadata(room, script), original = await readFile(file, 'utf8');
  const updated = withPublicationDetails(original, metadata);
  if (updated !== original) { await mkdir(join(directory, 'output'), { recursive: true }); await writeFile(file, updated); }
  return true;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/publish-copy.ts')) {
  for (const arg of process.argv.slice(2)) if (arg !== '--if-exists') throw Error(`Unknown publication option ${arg}`);
  const script = existsSync(join(projectDir, 'script.json')) ? JSON.parse(await readFile(join(projectDir, 'script.json'), 'utf8')) as Script : await loadScript();
  if (!/^[a-zA-Z0-9_-]+$/.test(script.roomId)) throw Error('Invalid publication room ID');
  const room = JSON.parse(await readFile(join(dataDir, 'rooms', `${script.roomId}.json`), 'utf8')) as PublicationRoom;
  console.log(JSON.stringify({ roomId: script.roomId, publicationUpdated: await syncPublishCopy(projectDir, room, script, !process.argv.includes('--if-exists')) }));
}
