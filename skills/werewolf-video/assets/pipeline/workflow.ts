import { spawn, execFileSync } from 'node:child_process';
import { readdir, readFile, mkdir, writeFile, stat, copyFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { startGpuMonitor } from './metrics';
import { videoLocale } from './video-locale';
import { createHash } from 'node:crypto';
import { asrProviderForLocale, ensureLocalAsrReady, type AsrProvider } from '../../packages/session/src/asr';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = new Map(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return [a.slice(0, i < 0 ? undefined : i), i < 0 ? 'true' : a.slice(i + 1)]; }));
const stages = ['export', 'plan', 'preflight', 'tts', 'audit-audio', 'review-audio', 'timeline', 'render', 'preview', 'verify'] as const;
const supported = new Set(['--help', '--room', '--player-seat', '--prepare-only', '--check-only', '--through', '--encoder', '--theme', '--video-locale', '--voices', '--narration', '--data-dir', '--project-dir', '--resume', '--repair-audio', '--tts-provider', '--tts-adapter', '--video-kbps', '--max-video-kbps', '--audio-kbps', '--asr-provider', '--asr-aliases', '--alignment-provider']);
for (const key of args.keys()) if (!supported.has(key)) throw Error(`Unknown option ${key}`);
if (args.has('--help')) { console.log('video:make --room=latest|ID [--player-seat=N] [--prepare-only | --check-only] [--through=STAGE] [--data-dir=DIR] [--project-dir=DIR] [--encoder=auto|cpu|gpu] [--video-locale=zh-CN|en|ja] [--repair-audio] [--asr-provider=auto|local|qwen-token-plan|mimo-token-plan|off] [--asr-aliases=FILE] [--alignment-provider=qwen-token-plan] [--theme=campus|storybook|gufeng|fantasy|urban|future] [--voices=FILE] [--narration=FILE] [--tts-provider=ID --tts-adapter=FILE]\nASR is off by default; enable it explicitly or review selected clips when needed. Local model files must already be installed.'); process.exit(0); }
if (args.has('--prepare-only') && args.has('--check-only')) throw Error('Choose --prepare-only or --check-only');
if (args.has('--player-seat') && args.has('--repair-audio')) throw Error('Player view does not support --repair-audio; use a new player project and synthesize its audio again');
const requestedAsr = args.get('--asr-provider') || 'off';
if (!['auto', 'local', 'qwen-token-plan', 'mimo-token-plan', 'off'].includes(requestedAsr)) throw Error('Unsupported ASR provider');
const alignmentProvider = args.get('--alignment-provider');
if (alignmentProvider && alignmentProvider !== 'qwen-token-plan') throw Error('Unsupported alignment provider');
if (requestedAsr === 'off' && alignmentProvider) throw Error('Alignment provider requires audio review');
if (args.has('--asr-aliases') && !existsSync(resolve(root, args.get('--asr-aliases')!))) throw Error('Missing --asr-aliases file');
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
const playerSeat = args.get('--player-seat');
if (playerSeat !== undefined && !/^[1-9][0-9]*$/.test(playerSeat)) throw Error('Invalid player seat');
if (playerSeat && (args.has('--voices') || args.has('--narration'))) throw Error('Player view requires its own local voice and narration files');
const dir = args.has('--project-dir') ? resolve(root, args.get('--project-dir')!) : resolve(dataRoot, 'video', playerSeat ? `${room}-player-${playerSeat}` : room);
await mkdir(dir, { recursive: true });
const bindingFile = join(dir, 'view-binding.json');
const binding = { roomId: room, perspective: playerSeat ? 'player' : 'god', ...(playerSeat ? { playerSeat: Number(playerSeat) } : {}) };
if (existsSync(bindingFile)) {
  if (JSON.stringify(JSON.parse(await readFile(bindingFile, 'utf8'))) !== JSON.stringify(binding)) throw Error('Project directory belongs to another view');
} else {
  if (playerSeat && (await readdir(dir)).length) throw Error('Player view requires a new, empty project directory');
  await writeFile(bindingFile, JSON.stringify(binding, null, 2));
}
for (const key of ['--voices', '--narration', '--tts-adapter']) if (args.has(key) && !existsSync(resolve(root, args.get(key)!))) throw Error(`Missing ${key} file`);
const theme = args.get('--theme') || 'campus'; if (!['campus', 'storybook', 'gufeng', 'fantasy', 'urban', 'future'].includes(theme)) throw Error('Unsupported avatar theme');
if (args.has('--video-locale')) videoLocale(undefined, args.get('--video-locale'));
const encoderOption = args.get('--encoder') || 'auto'; if (!['auto', 'cpu', 'gpu'].includes(encoderOption)) throw Error('Unsupported encoder');
let encoder = 'libx264';
if (encoderOption !== 'cpu') {
  try { execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, stdio: 'ignore', timeout: 4000 }); encoder = 'h264_nvenc'; }
  catch { if (encoderOption === 'gpu') throw Error('Requested NVIDIA encoding but nvidia-smi is unavailable'); }
}
const last = args.has('--prepare-only') ? 'plan' : args.has('--check-only') ? 'preflight' : args.get('--through') || 'verify';
if (!stages.includes(last as any)) throw Error('Invalid final stage');
const env = { ...process.env, WEREWOLF_DATA: dataRoot, VIDEO_DATA_DIR: dataRoot, VIDEO_ROOM: room, VIDEO_PROJECT_DIR: dir, VIDEO_AVATAR_STYLE: theme, VIDEO_ENCODER: encoder,
  VIDEO_PLAYER_SEAT: playerSeat || '',
  ...(args.has('--video-locale') ? { VIDEO_LOCALE: args.get('--video-locale')! } : {}),
  VIDEO_REQUIRE_GPU: encoderOption === 'gpu' ? '1' : '0',
  ...(args.has('--video-kbps') ? { VIDEO_BITRATE_KBPS: args.get('--video-kbps')! } : {}),
  ...(args.has('--max-video-kbps') ? { VIDEO_MAXRATE_KBPS: args.get('--max-video-kbps')! } : {}),
  ...(args.has('--audio-kbps') ? { VIDEO_AUDIO_KBPS: args.get('--audio-kbps')! } : {}),
  VIDEO_TTS_PROVIDER: args.get('--tts-provider') || process.env.VIDEO_TTS_PROVIDER || 'qwen-token-plan',
  ...(args.get('--tts-adapter') ? { VIDEO_TTS_ADAPTER: resolve(root, args.get('--tts-adapter')!) } : {}),
  VIDEO_VOICES_FILE: resolve(root, args.get('--voices') || `${dir}/voices.json`),
  VIDEO_NARRATION_FILE: resolve(root, args.get('--narration') || `${dir}/narration.json`) };
// Do not put credentials or the raw room document into workflow reports.
const report: { roomId: string; encoder: string; theme: string; completed: string[]; status: string; error?: string; asr: { requestedProvider: string; effectiveProvider?: string; locale?: string; audioSemanticReview: string; report?: string; alignmentProvider?: string; failedClipIds?: string[]; recognitionRequests?: number; alignmentRequests?: number } } = { roomId: room, encoder, theme, completed: [], status: 'running', asr: { requestedProvider: requestedAsr, audioSemanticReview: requestedAsr === 'off' ? 'not-checked-explicitly-disabled' : 'pending', ...(alignmentProvider ? { alignmentProvider } : {}) } };
await writeFile(`${dir}/workflow-status.json`, JSON.stringify(report, null, 2));
const run = (file: string, extra: string[] = []) => new Promise<void>((ok, fail) => {
  const child = spawn(process.execPath, ['--import', 'tsx', file, ...extra], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  child.on('error', fail); child.on('close', (code) => code === 0 ? ok() : fail(Error(`${file} stopped with code ${code}`)));
});
let stopMonitor: Awaited<ReturnType<typeof startGpuMonitor>> | undefined;
try {
  for (const stage of stages) {
    console.log(`VIDEO_STAGE ${stage} ${room}`);
    if (stage === 'render') stopMonitor = await startGpuMonitor(`${dir}/gpu-metrics.json`);
    if (stage === 'export') {
      await run('packages/session/scripts/export-video.ts', [`--room=${room}`, ...(playerSeat ? [`--player-seat=${playerSeat}`] : [])]);
      if (playerSeat) {
        const current = JSON.parse(await readFile(join(dataRoot, 'exports', `${room}-player-${playerSeat}-video-script.json`), 'utf8'));
        const digest = createHash('sha256').update(JSON.stringify(current)).digest('hex'), fingerprint = join(dir, 'player-source.sha256');
        if (existsSync(fingerprint) && (await readFile(fingerprint, 'utf8')).trim() !== digest) throw Error('Player source changed; use a new empty project directory to avoid stale materials and audio');
        if (existsSync(join(dir, 'source.json'))) {
          const previous = JSON.parse(await readFile(join(dir, 'source.json'), 'utf8'));
          if (JSON.stringify(current) !== JSON.stringify(previous)) throw Error('Player source changed; use a new empty project directory to avoid stale audio and images');
        }
        await writeFile(fingerprint, digest);
      }
    }
    else if (stage === 'plan') {
      await run('scripts/video/prepare.ts');
      if (requestedAsr !== 'off' && stages.indexOf(last as typeof stages[number]) >= stages.indexOf('review-audio')) {
        const source = JSON.parse(await readFile(join(dir, 'source.json'), 'utf8'));
        report.asr.locale = source.locale;
        report.asr.effectiveProvider = asrProviderForLocale(requestedAsr as AsrProvider | 'auto', source.locale);
      }
    }
    else if (stage === 'audit-audio') {
      await run('scripts/video/audit-audio.ts', args.has('--repair-audio') ? ['--waveform-only'] : ['--waveform-only', '--fail-on-error']);
      const audit = JSON.parse(await readFile(`${dir}/output/audio-audit.json`, 'utf8'));
      if (audit.failedClipIds.length && args.has('--repair-audio')) {
        await run('scripts/video/repair-audio.ts', ['--auto', '--audit=output/audio-audit.json', '--waveform-only']);
        for (const extension of ['json', 'md']) await copyFile(`${dir}/output/audio-audit-after.${extension}`, `${dir}/output/audio-audit.${extension}`);
      }
    }
    else if (stage === 'review-audio') {
      const source = JSON.parse(await readFile(join(dir, 'source.json'), 'utf8'));
      report.asr.locale = source.locale;
      if (requestedAsr !== 'off') {
        const provider = asrProviderForLocale(requestedAsr as AsrProvider | 'auto', source.locale);
        report.asr.effectiveProvider = provider;
        report.asr.report = join(dir, 'output', 'asr-review', 'report.json');
        if (args.has('--asr-aliases')) JSON.parse(await readFile(resolve(root, args.get('--asr-aliases')!), 'utf8'));
        if (provider === 'local') await ensureLocalAsrReady(dataRoot, () => run('scripts/asr/service.mjs', ['start', '--data-dir', dataRoot]));
        if (existsSync(report.asr.report)) await unlink(report.asr.report);
        let reviewError: unknown;
        try { await run('scripts/video/review-audio.ts', [`--provider=${provider}`, '--align', ...(args.has('--asr-aliases') ? [`--aliases=${resolve(root, args.get('--asr-aliases')!)}`] : []), ...(alignmentProvider ? [`--alignment-provider=${alignmentProvider}`] : [])]); }
        catch (error) { reviewError = error; }
        if (!existsSync(report.asr.report)) throw reviewError ?? Error('ASR review did not produce a report');
        const review = JSON.parse(await readFile(report.asr.report, 'utf8')) as { recognitionRequests: number; alignmentRequests: number; items: { clipId: string; status: string }[] };
        report.asr.recognitionRequests = review.recognitionRequests; report.asr.alignmentRequests = review.alignmentRequests;
        report.asr.failedClipIds = review.items.filter((item) => item.status !== 'matching').map((item) => item.clipId);
        report.asr.audioSemanticReview = report.asr.failedClipIds.length ? 'needs-review' : 'independent-transcript-only';
        if (report.asr.failedClipIds.length) throw Error(`ASR review requires attention: ${report.asr.failedClipIds.join(', ')}; see ${report.asr.report}`);
        if (reviewError) throw reviewError;
      }
      // Caption timing is always checked, including when semantic review is explicitly off.
      await run('scripts/video/audit-audio.ts', ['--fail-on-error']);
    }
    else await run(`scripts/video/${stage === 'tts' ? 'synthesize' : stage}.ts`);
    if (stage === 'verify' && !playerSeat) await run('scripts/video/publish-copy.ts', ['--if-exists']);
    if (stage === 'render' && stopMonitor) { await stopMonitor(); stopMonitor = undefined; }
    report.completed.push(stage); await writeFile(`${dir}/workflow-status.json`, JSON.stringify(report, null, 2));
    if (stage === last) break;
  }
  report.status = last === 'verify' ? 'complete' : 'checkpoint';
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : 'Unknown workflow error'; process.exitCode = 1; }
finally { if (stopMonitor) await stopMonitor(); await writeFile(`${dir}/workflow-status.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
