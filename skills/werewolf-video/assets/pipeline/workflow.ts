import { spawn, execFileSync } from 'node:child_process';
import { readdir, readFile, mkdir, writeFile, stat, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { startGpuMonitor } from './metrics';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = new Map(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return [a.slice(0, i < 0 ? undefined : i), i < 0 ? 'true' : a.slice(i + 1)]; }));
const stages = ['export', 'plan', 'tts', 'audit-audio', 'timeline', 'render', 'preview', 'verify'] as const;
const supported = new Set(['--help', '--room', '--prepare-only', '--through', '--encoder', '--theme', '--voices', '--narration', '--data-dir', '--project-dir', '--resume', '--repair-audio', '--tts-provider', '--tts-adapter', '--video-kbps', '--max-video-kbps', '--audio-kbps']);
for (const key of args.keys()) if (!supported.has(key)) throw Error(`Unknown option ${key}`);
if (args.has('--help')) { console.log('video:make --room=latest|ID [--prepare-only] [--through=STAGE] [--project-dir=DIR] [--encoder=auto|cpu|gpu] [--repair-audio] [--video-kbps=750 --max-video-kbps=1200 --audio-kbps=96] [--theme=campus|storybook|gufeng|fantasy|urban|future] [--voices=FILE] [--narration=FILE] [--tts-provider=ID --tts-adapter=FILE]'); process.exit(0); }
const dataRoot = resolve(root, args.get('--data-dir') || 'data');
const roomsDir = join(dataRoot, 'rooms');
let room = args.get('--room') || 'latest';
if (room === 'latest') {
  const candidates: { id: string; when: number }[] = [];
  for (const name of await readdir(roomsDir)) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
    const path = join(roomsDir, name); let doc: any;
    try { doc = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
    if (doc.status !== 'ended' || !Array.isArray(doc.events) || !doc.events.some((e: any) => e.type === 'game.end')) continue;
    candidates.push({ id: name.slice(0, -5), when: Number(doc.createdAt) || (await stat(path)).mtimeMs });
  }
  candidates.sort((a, b) => b.when - a.when); if (!candidates.length) throw Error('No completed real match in the selected rooms directory');
  room = candidates[0].id;
}
if (!/^[a-zA-Z0-9_-]+$/.test(room)) throw Error('Invalid room ID');
const dir = args.has('--project-dir') ? resolve(root, args.get('--project-dir')!) : resolve(dataRoot, 'video', room); await mkdir(dir, { recursive: true });
for (const key of ['--voices', '--narration', '--tts-adapter']) if (args.has(key) && !existsSync(resolve(root, args.get(key)!))) throw Error(`Missing ${key} file`);
const theme = args.get('--theme') || 'campus'; if (!['campus', 'storybook', 'gufeng', 'fantasy', 'urban', 'future'].includes(theme)) throw Error('Unsupported avatar theme');
const encoderOption = args.get('--encoder') || 'auto'; if (!['auto', 'cpu', 'gpu'].includes(encoderOption)) throw Error('Unsupported encoder');
let encoder = 'libx264';
if (encoderOption !== 'cpu') {
  try { execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, stdio: 'ignore', timeout: 4000 }); encoder = 'h264_nvenc'; }
  catch { if (encoderOption === 'gpu') throw Error('Requested NVIDIA encoding but nvidia-smi is unavailable'); }
}
const last = args.has('--prepare-only') ? 'plan' : args.get('--through') || 'verify';
if (!stages.includes(last as any)) throw Error('Invalid final stage');
const env = { ...process.env, WEREWOLF_DATA: dataRoot, VIDEO_DATA_DIR: dataRoot, VIDEO_ROOM: room, VIDEO_PROJECT_DIR: dir, VIDEO_AVATAR_STYLE: theme, VIDEO_ENCODER: encoder,
  VIDEO_REQUIRE_GPU: encoderOption === 'gpu' ? '1' : '0',
  ...(args.has('--video-kbps') ? { VIDEO_BITRATE_KBPS: args.get('--video-kbps')! } : {}),
  ...(args.has('--max-video-kbps') ? { VIDEO_MAXRATE_KBPS: args.get('--max-video-kbps')! } : {}),
  ...(args.has('--audio-kbps') ? { VIDEO_AUDIO_KBPS: args.get('--audio-kbps')! } : {}),
  VIDEO_TTS_PROVIDER: args.get('--tts-provider') || process.env.VIDEO_TTS_PROVIDER || 'qwen-token-plan',
  ...(args.get('--tts-adapter') ? { VIDEO_TTS_ADAPTER: resolve(root, args.get('--tts-adapter')!) } : {}),
  VIDEO_VOICES_FILE: resolve(root, args.get('--voices') || `${dir}/voices.json`),
  VIDEO_NARRATION_FILE: resolve(root, args.get('--narration') || `${dir}/narration.json`) };
// Do not put credentials or the raw room document into workflow reports.
const report: { roomId: string; encoder: string; theme: string; completed: string[]; status: string; error?: string } = { roomId: room, encoder, theme, completed: [], status: 'running' };
await writeFile(`${dir}/workflow-status.json`, JSON.stringify(report, null, 2));
const run = (file: string, extra: string[] = []) => new Promise<void>((ok, fail) => {
  const child = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), file, ...extra], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  child.on('error', fail); child.on('close', (code) => code === 0 ? ok() : fail(Error(`${file} stopped with code ${code}`)));
});
let stopMonitor: Awaited<ReturnType<typeof startGpuMonitor>> | undefined;
try {
  for (const stage of stages) {
    console.log(`VIDEO_STAGE ${stage} ${room}`);
    if (stage === 'render') stopMonitor = await startGpuMonitor(`${dir}/gpu-metrics.json`);
    if (stage === 'export') await run('packages/session/scripts/export-video.ts', [`--room=${room}`]);
    else if (stage === 'plan') await run('scripts/video/prepare.ts');
    else if (stage === 'audit-audio') {
      await run('scripts/video/audit-audio.ts', args.has('--repair-audio') ? [] : ['--fail-on-error']);
      const audit = JSON.parse(await readFile(`${dir}/output/audio-audit.json`, 'utf8'));
      if (audit.failedClipIds.length && args.has('--repair-audio')) {
        await run('scripts/video/repair-audio.ts', ['--auto', '--audit=output/audio-audit.json']);
        for (const extension of ['json', 'md']) await copyFile(`${dir}/output/audio-audit-after.${extension}`, `${dir}/output/audio-audit.${extension}`);
      }
    }
    else await run(`scripts/video/${stage === 'tts' ? 'synthesize' : stage}.ts`);
    if (stage === 'render' && stopMonitor) { await stopMonitor(); stopMonitor = undefined; }
    report.completed.push(stage); await writeFile(`${dir}/workflow-status.json`, JSON.stringify(report, null, 2));
    if (stage === last) break;
  }
  report.status = last === 'verify' ? 'complete' : 'checkpoint';
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : 'Unknown workflow error'; process.exitCode = 1; }
finally { if (stopMonitor) await stopMonitor(); await writeFile(`${dir}/workflow-status.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
