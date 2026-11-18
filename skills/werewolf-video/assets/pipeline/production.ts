import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fields } from './compile-edit';
import { deliverEdition } from './deliver-edition';
import { encodingSettings } from './encoding';
import { hostingRevision } from './hosting';
import { fileDigest } from './integrity';
import { transitionRevision } from './transitions';
import { rateEnvironment, stillSceneRevision, type RateRequest } from './production-settings';
import { recordPublicationMaterials } from './publication-materials';
import { publicationMetadata, withPublicationDetails } from './publish-copy';
import { resolveTtsModelConfig, TOKEN_PLAN_ENDPOINT } from './tts-config';
import { videoUiLocale } from './video-locale';
import { verticalVideoTitle } from './video-perspective';
import type { Clip, Script, VoiceCatalog } from './project';
import { asrProviderForLocale, ensureLocalAsrReady, type AsrProvider } from '../../packages/session/src/asr';

type Edition = { id: string; kind: 'full' | 'edit' | 'sample'; format: 'horizontal' | 'vertical'; playerSeat?: number; cut?: string; selection?: string; materialsDir?: string };
type Cut = { manuscript: string; reviewFile: string; narrationAsr?: 'qwen-token-plan' };
type Production = { roomId: string; editions: Edition[]; cuts?: Record<string, Cut>; workDir?: string; dataDir?: string; masterProject?: string; deliveryRoot?: string;
  uiLocale?: string; theme?: string; ttsModel?: string; asrProvider?: string; alignmentProvider?: string; encoder?: 'auto' | 'cpu' | 'gpu'; encoding?: RateRequest };
type Media = { video: string; subtitles: string; visibleSourceSeqs: number[]; expectedMedia: {video:string;subtitles:string}; key: string };
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const json = async <T>(file: string): Promise<T> => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
async function save(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n'); await rename(tmp, file); }
  finally { await rm(tmp, { force: true }); }
}
const component = (name: string) => typeof name === 'string' && /^[\p{L}\p{N}_-][\p{L}\p{N} _-]*$/u.test(name) && name === name.trim() && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
};
function validate(job: Production) {
  fields(job, ['roomId','editions','cuts','dataDir','workDir','deliveryRoot','masterProject','uiLocale','theme','ttsModel','asrProvider','alignmentProvider','encoder','encoding'], 'production');
  assert(/^[a-zA-Z0-9_-]+$/.test(job.roomId) && job.roomId !== 'latest' && Array.isArray(job.editions) && job.editions.length, 'Specify one room ID and at least one edition');
  if (job.uiLocale) videoUiLocale(undefined, job.uiLocale);
  assert(!job.encoder || ['auto','cpu','gpu'].includes(job.encoder), 'Invalid encoder');
  const ids = new Set<string>();
  for (const edition of job.editions) {
    fields(edition, ['id','kind','format','playerSeat','cut','selection','materialsDir'], 'edition');
    assert(component(edition.id) && !ids.has(edition.id.toLowerCase()), 'Invalid or duplicate edition ID'); ids.add(edition.id.toLowerCase());
    assert(['full','edit','sample'].includes(edition.kind) && ['horizontal','vertical'].includes(edition.format), 'Invalid edition kind or format');
    assert(edition.playerSeat === undefined || (Number.isSafeInteger(edition.playerSeat) && edition.playerSeat > 0), 'Invalid player seat');
    assert((edition.kind === 'edit') === (typeof edition.cut === 'string') && (edition.kind === 'sample') === (typeof edition.selection === 'string'), 'Edits require a cut and samples require a selection file');
    if (edition.cut) assert(component(edition.cut) && Object.hasOwn(job.cuts || {}, edition.cut), 'Unknown cut: ' + edition.cut);
  }
  for (const [key, cut] of Object.entries(job.cuts || {})) {
    fields(cut, ['manuscript','reviewFile','narrationAsr'], 'cut');
    assert(cut.narrationAsr === undefined || cut.narrationAsr === 'qwen-token-plan', 'Unsupported edited narration ASR route');
    assert(component(key) && cut.manuscript && cut.reviewFile, 'Each cut needs a manuscript and its independent review');
    assert(new Set(job.editions.filter(e => e.cut === key).map(e => e.playerSeat)).size === 1, 'A cut must belong to exactly one authorized view');
  }
}
function run(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((ok, fail) => {
    const child = spawn(process.execPath, ['--import','tsx', join(root, 'scripts/video', file + '.ts'), ...args], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    child.on('error', fail); child.on('close', code => code === 0 ? ok() : fail(Error(file + ' exited ' + code)));
  });
}
function encoderFor(request = 'auto'): 'cpu' | 'gpu' {
  if (request === 'cpu' || request === 'gpu') return request;
  try { execFileSync('nvidia-smi', ['--query-gpu=name','--format=csv,noheader'], { windowsHide: true, timeout: 4000, stdio: 'ignore' }); return 'gpu'; }
  catch { return 'cpu'; }
}
function selectedClips(clips: Clip[], item: { sourceClipId?: string; sourceSeq?: number }) {
  const matches = clips.filter(c => item.sourceClipId ? c.id === item.sourceClipId : c.sourceSeq === item.sourceSeq);
  assert(matches.length === 1, 'Identify each manuscript quote by its unique source clip'); return matches[0];
}
type ManuscriptItem = { kind: 'source' | 'narration'; sourceClipId?: string; sourceSeq?: number; afterSourceSeq?: number };
async function itemsFor(file: string): Promise<ManuscriptItem[]> {
  const data = await json<ManuscriptItem[] | { items: ManuscriptItem[] }>(file);
  const items = Array.isArray(data) ? data : data.items;
  assert(Array.isArray(items) && items.length, 'Empty manuscript'); return items;
}

export async function produce(requestFile: string, args: string[]) {
  const jobPath = resolve(requestFile), base = dirname(jobPath), job = await json<Production>(jobPath);
  validate(job);
  const modes = ['--prepare-only','--check-only','--media-only','--record-publication','--deliver-only'];
  assert(args.every(a => modes.includes(a) || a === '--reuse-only' || a.startsWith('--edition=') || a.startsWith('--reviewed-by=')), 'Unsupported production option; set shared options in the production JSON');
  const requestedModes = args.filter(a => modes.includes(a));
  assert(requestedModes.length <= 1, 'Choose one production mode');
  const mode = requestedModes[0] || 'produce';
  const only = args.find(a => a.startsWith('--edition='))?.slice(10);
  if (only && !['--record-publication','--deliver-only'].includes(mode)) throw Error('Select render versions in editions. --edition selects one already rendered publication.');
  const editions = job.editions.filter(e => !only || e.id === only); assert(editions.length, 'Unknown edition');
  const reviewer = args.find(a => a.startsWith('--reviewed-by='))?.slice(14);
  if (mode === '--record-publication') assert(reviewer?.trim(), 'Record who reviewed the actual cover, title, copy and selected facts with --reviewed-by=NAME');
  const data = job.dataDir ? resolve(base, job.dataDir) : join(root, 'data');
  const work = job.workDir ? resolve(base, job.workDir) : join(data, 'video', job.roomId + '-production');
  const delivery = resolve(job.deliveryRoot ? resolve(base, job.deliveryRoot) : join(homedir(), 'Desktop', '月影议事厅-频道素材', '05-对局成片'), job.roomId);
  assert(work !== delivery && !inside(work, delivery) && !inside(delivery, work), 'Keep production and delivery directories separate');
  const hasGodFull = job.editions.some(e => e.kind === 'full' && !e.playerSeat);
  const configuredMaster = job.masterProject && resolve(base, job.masterProject);
  const canonical = join(data, 'video', job.roomId), master = configuredMaster || canonical;
  const usingMaster = !!configuredMaster || hasGodFull || existsSync(join(master, 'source.json'));
  const viewName = (seat?: number) => seat ? 'player-' + seat : 'god';
  const fullFor = (seat?: number) => job.editions.some(e => e.kind === 'full' && e.playerSeat === seat);
  const sourceFor = (seat?: number) => !seat && hasGodFull ? master : join(work, 'sources', viewName(seat));
  const exportFor = (seat?: number) => join(data, 'exports', job.roomId + (seat ? '-player-' + seat : '') + '-video-script.json');
  const materialsFor = (e: Edition) => e.materialsDir ? resolve(base, e.materialsDir) : join(work, 'materials', e.id);
  for (const e of editions) assert(!inside(delivery, materialsFor(e)) && materialsFor(e) !== delivery, 'Keep editing materials outside delivery');
  const encoder = encoderFor(job.encoder);
  const env = { ...process.env, ...rateEnvironment(job.encoding || {}), VIDEO_PRODUCTION_JOB: '1', VIDEO_ROOM: job.roomId, VIDEO_DATA_DIR: data, WEREWOLF_DATA: data,
    VIDEO_ENCODER: encoder === 'gpu' ? 'h264_nvenc' : 'libx264', VIDEO_REQUIRE_GPU: encoder === 'gpu' ? '1' : '0',
    VIDEO_REUSE_ONLY: args.includes('--reuse-only') ? '1' : process.env.VIDEO_REUSE_ONLY || '0',
    ...(job.uiLocale ? { VIDEO_LOCALE: job.uiLocale } : {}), ...(job.theme ? { VIDEO_AVATAR_STYLE: job.theme } : {}) };
  const rate = encodingSettings(env);
  const scoped = (seat?: number, directory = sourceFor(seat), sourceOnly = !fullFor(seat)): NodeJS.ProcessEnv => ({
    ...env, VIDEO_PROJECT_DIR: directory, VIDEO_PLAYER_SEAT: seat ? String(seat) : '', VIDEO_SOURCE_ONLY: sourceOnly ? '1' : '0',
    VIDEO_VOICES_FILE: join(directory, 'voices.json'), VIDEO_NARRATION_FILE: join(directory, 'narration.json'),
    ...(job.ttsModel ? { VIDEO_TTS_MODEL: job.ttsModel } : {}),
    VIDEO_MASTER_PROJECT: usingMaster && resolve(master) !== resolve(directory) && (!hasGodFull || existsSync(join(master,'clips.json'))) ? master : '',
  });
  const workflow = (seat: number | undefined, stage: string) => run('workflow', ['--room=' + job.roomId, '--data-dir=' + data, '--project-dir=' + sourceFor(seat), '--encoder=' + encoder,
    ...(seat ? ['--player-seat=' + seat] : []), ...(!fullFor(seat) ? ['--source-only'] : []), ...(job.theme ? ['--theme=' + job.theme] : []),
    ...(job.uiLocale ? ['--video-locale=' + job.uiLocale] : []), ...(job.ttsModel ? ['--tts-model=' + job.ttsModel] : []),
    ...(job.asrProvider ? ['--asr-provider=' + job.asrProvider] : []), ...(job.alignmentProvider ? ['--alignment-provider=' + job.alignmentProvider] : []),
    '--resume', stage], scoped(seat));
  const views = [...new Set([...(hasGodFull ? [undefined] : []), ...editions.map(e => e.playerSeat)])];
  const roomFile = join(data, 'rooms', job.roomId + '.json');
  const pendingFile = (e: Edition) => join(work, 'editions', e.id, 'media.json');
  const usesStillScene = (e: Edition) => e.format === 'vertical' || e.kind === 'edit';
  const editionKey = async (e: Edition, includeStillSceneRevision = true) => {
    const digest = createHash('sha256').update(JSON.stringify(['perspective-v2', transitionRevision, e.playerSeat ? null : hostingRevision, e, rate, encoder, job.uiLocale, job.theme, job.ttsModel, job.asrProvider, job.alignmentProvider, e.cut && job.cuts![e.cut].narrationAsr, master]));
    if (includeStillSceneRevision && usesStillScene(e)) digest.update(stillSceneRevision);
    const src = sourceFor(e.playerSeat);
    const files = [roomFile, exportFor(e.playerSeat), join(src,'voices.json'), join(src,'narration.json'), join(src,'avatar-theme.json')];
    if (e.cut) files.push(resolve(base, job.cuts![e.cut].manuscript), resolve(base, job.cuts![e.cut].reviewFile));
    if (e.selection) files.push(resolve(base, e.selection));
    for (const file of files) digest.update(await readFile(file)).update('\0');
    // Audio and alignment repairs change the render even when the manuscript is identical.
    for (const project of new Set([src, ...(usingMaster ? [master] : [])])) {
      const audioDir = join(project,'audio');
      if (!existsSync(audioDir)) continue;
      for (const name of (await readdir(audioDir)).filter(n => /\.wav(?:\.json|\.alignment\.json)?$/i.test(n)).sort()) {
        const { size, mtimeMs } = await stat(join(audioDir,name)); digest.update(JSON.stringify([name,size,mtimeMs]));
      }
    }
    return digest.digest('hex');
  };
  await mkdir(work, {recursive:true});
  const lock = join(work, '.production-lock');
  await mkdir(lock).catch(error => { if (error.code === 'EEXIST') throw Error('This production is already running. After an interrupted run, remove its inactive lock: ' + lock); throw error; });
  try {
    if (mode !== '--record-publication' && mode !== '--deliver-only') {
      for (const seat of views) {
        const project = sourceFor(seat), fresh = !existsSync(project);
        await workflow(seat, '--prepare-only');
        if (!fullFor(seat)) await run('synthesize',['--plan-only'],scoped(seat));
        if (fresh) await save(join(project,'production-owner.json'),{jobPath,roomId:job.roomId});
      }
      for (const e of editions) await mkdir(materialsFor(e), {recursive:true});
      if (mode === '--prepare-only') { console.log(JSON.stringify({ work, projects: views.map(sourceFor), materials: editions.map(materialsFor) })); return; }
      for (const seat of views) await workflow(seat, '--check-only');
      if (mode === '--check-only') return;
    }
    const cutAt = (e: Edition) => join(work,'cuts',e.cut!);
    const manuscriptAt = (e: Edition) => resolve(base,job.cuts![e.cut!].manuscript);
    async function visible(e: Edition) {
      const script = await json<Script>(exportFor(e.playerSeat));
      const allowed = new Set(script.events.map(f => f.sourceSeq));
      let seqs: number[];
      if (e.kind === 'full') seqs = (await json<Clip[]>(join(sourceFor(e.playerSeat),'clips.json'))).map(clip => clip.sourceSeq);
      else if (e.selection) {
        const selection = await json<{sections: {sourceSeqs:number[]}[]}>(resolve(base,e.selection));
        seqs = selection.sections.flatMap(s => s.sourceSeqs);
      } else {
        const clipped = await itemsFor(manuscriptAt(e));
        const clips = clipped.some(i => i.sourceClipId) ? await json<Clip[]>(join(sourceFor(e.playerSeat),'clips.json')) : [];
        seqs = clipped.filter(item => item.kind === 'source').map(item => item.sourceClipId ? selectedClips(clips,item).sourceSeq : item.sourceSeq!);
      }
      assert(seqs.length && seqs.every(seq => allowed.has(seq)), 'Chosen highlights must belong to this edition and its authorized view');
      return [...new Set(seqs)];
    }
    if (mode === '--record-publication') {
      for (const e of editions) {
        const dir = materialsFor(e);
        if (!e.playerSeat && e.kind === 'full') {
          const file = join(dir,'publish-copy.md'), copy = await readFile(file,'utf8');
          const script = await json<Script>(exportFor()); const details = withPublicationDetails(copy, publicationMetadata(await json(roomFile),script));
          if (details !== copy) await writeFile(file,details);
        }
        await recordPublicationMaterials({ materialsDir: dir, roomId: job.roomId, version: e.id, visibleSourceSeqs: await visible(e), reviewedBy: reviewer! });
      }
      return;
    }
    const needed = new Map<string, Media>();
    const old = async (e: Edition): Promise<Media | undefined> => {
      if (!existsSync(pendingFile(e))) return;
      const saved = await json<Media>(pendingFile(e));
      if (!saved.expectedMedia?.video || !saved.expectedMedia.subtitles || !existsSync(saved.video) || !existsSync(saved.subtitles)) return;
      if (saved.key === await editionKey(e)) return saved;
      // An existing edition can still go through staging with its original input-bound key.
      if (mode === '--deliver-only' && usesStillScene(e) && saved.key === await editionKey(e, false)) return saved;
    };
    for (const e of editions) {
      const previous = await old(e);
      if (previous) needed.set(e.id,previous);
      else if (mode === '--deliver-only') throw Error('Render this edition with the current source, settings and media first: ' + e.id);
    }
    const missing = editions.filter(e => !needed.has(e.id));
    const readyCuts = new Set<string>();
    if (missing.length) {
      // Finish the shared god audio before any derivative requests an individual line.
      for (const seat of views.filter(seat => fullFor(seat) && ((!seat && hasGodFull) || missing.some(e => e.playerSeat === seat)))) await workflow(seat,'--through=review-audio');
      for (const e of missing) {
        const seat = e.playerSeat, src = sourceFor(seat), view = scoped(seat);
        const child = (file: string, args: string[], local = view) => run(file,args,local);
        const reviewSelected = async (local:NodeJS.ProcessEnv, clips:string[] = []) => {
          if (!job.asrProvider || job.asrProvider === 'off') return;
          const source = await json<Script>(join(local.VIDEO_PROJECT_DIR!,'source.json'));
          if (asrProviderForLocale(job.asrProvider as AsrProvider | 'auto',source.locale) === 'local') {
            await ensureLocalAsrReady(data,async () => { execFileSync(process.execPath,[join(root,'scripts/asr/service.mjs'),'start','--data-dir',data],{cwd:root,env:local,windowsHide:true,stdio:'inherit'}); });
          }
          await child('review-audio',['--provider=' + job.asrProvider,'--align',...clips.map(id => '--clip=' + id),
            ...(job.alignmentProvider ? ['--alignment-provider=' + job.alignmentProvider] : [])],local);
        };
        const horizontal = (dir: string) => ({ video: join(dir,'output','latest-match.mp4'), subtitles: join(dir,'subtitles','captions.srt') });
        const editionDir = dirname(pendingFile(e));
        let output: Pick<Media,'video'|'subtitles'>;
        if (e.kind === 'full' && e.format === 'horizontal') {
          await workflow(seat,'--through=verify'); output = horizontal(src);
        } else if (e.kind === 'sample' && e.format === 'horizontal') {
          const dir = join(editionDir,'sample-' + sha(await readFile(resolve(base,e.selection!))).slice(0,16));
          const local = { ...scoped(seat,dir), VIDEO_SOURCE_PROJECT: src, VIDEO_NARRATION_FILE: join(src,'narration.json') };
          await child('sample',['--selection=' + resolve(base,e.selection!)],local);
          await child('synthesize',['--prepared-clips'],local);
          await reviewSelected(local);
          await child('audit-audio',['--fail-on-error'],local);
          await child('timeline',[],local); await child('render',[],local);
          output = horizontal(dir); await child('verify-sample',['--video=' + output.video],local);
        } else if (e.kind === 'edit') {
          const cut = cutAt(e), selection = join(cut,'selection.json'), narration = join(cut,'audio','edit','narration-manifest.json');
          if (!readyCuts.has(cut)) {
            const manuscript = manuscriptAt(e), reviewFile = resolve(base,job.cuts![e.cut!].reviewFile);
            if (!fullFor(seat)) {
              const items = await itemsFor(manuscript), clips = await json<Clip[]>(join(src,'clips.json'));
              const ids = items.filter(i => i.kind === 'source').map(i => selectedClips(clips,i).id);
              if (ids.length) { await child('synthesize',['--prepared-clips','--clips=' + ids.join(',')]); await reviewSelected(view,ids); }
            }
            await save(join(cut,'compile.json'), {sourceProject:src, manuscript, reviewFile, output:selection});
            await child('compile-edit',['--job=' + join(cut,'compile.json')]);
            const catalog = await json<VoiceCatalog>(join(src,'voices.json')), voice = catalog.profiles.commentator;
            const script = await json<Script>(join(src,'source.json')), config = resolveTtsModelConfig(catalog.model);
            await save(join(cut,'voices-job.json'), {sourceProject:src,outputDir:join(cut,'audio'),scripts:[{id:'edit',scriptFile:selection}],
              ...(job.cuts![e.cut!].narrationAsr ? {asr:{enabled:true,provider:job.cuts![e.cut!].narrationAsr}} : {}),
              tts:{route:config.endpoint === TOKEN_PLAN_ENDPOINT ? 'token-plan' : 'dashscope', model:catalog.model, voice:voice.voice, rate:voice.rate, instruction:voice.instruction, locale:script.locale || 'zh-CN'}});
            await child('synthesize-narration',['--job=' + join(cut,'voices-job.json')]); readyCuts.add(cut);
          }
          const dir = join(editionDir,'render-' + (await editionKey(e)).slice(0,16));
          const renderJob = join(editionDir,'render.json');
          await save(renderJob,{sourceProject:src,selection,narrationManifest:narration,outputDir:dir,format:e.format,encoder});
          await child('edited-video',['--job=' + renderJob]);
          output = {video:join(dir,'output','highlights-' + e.format + '.mp4'),subtitles:join(dir,'output','subtitles.srt')};
        } else {
          // Vertical samples are a deliberate selection of whole or partial authorized clips.
          const dir = join(editionDir,'render-' + (await editionKey(e)).slice(0,16));
          let selectionFile: string | undefined;
          if (e.kind === 'sample') {
            const sample = join(editionDir,'sample-' + sha(await readFile(resolve(base,e.selection!))).slice(0,16));
            const local = { ...scoped(seat,sample), VIDEO_SOURCE_PROJECT: src, VIDEO_NARRATION_FILE: join(src,'narration.json') };
            await child('sample',['--selection=' + resolve(base,e.selection!)],local);
            await child('synthesize',['--prepared-clips'],local); await reviewSelected(local); await child('audit-audio',['--fail-on-error'],local);
            // The vertical renderer accepts a prepared sample without turning it into a full edition.
            selectionFile = sample;
          }
          const source = selectionFile || src;
          await child('vertical-highlight',['--source-project=' + source, selectionFile ? '--sample' : '--full','--encoder=' + encoder,'--output-dir=' + dir], scoped(seat,source));
          output = {video:join(dir,'output',selectionFile ? 'sample-vertical.mp4' : 'full-' + (seat ? 'player' : 'god') + '-vertical.mp4'),subtitles:join(dir,'output','subtitles.srt')};
        }
        const reportFile = join(dirname(output.video),'verification.json');
        const report = existsSync(reportFile) ? await json<{videoSha256?:string}>(reportFile) : {};
        const videoDigest = report.videoSha256 || await fileDigest(output.video);
        const media: Media = { ...output, visibleSourceSeqs: await visible(e), expectedMedia:{video:videoDigest,subtitles:await fileDigest(output.subtitles)}, key:await editionKey(e) };
        await save(pendingFile(e),media); needed.set(e.id,media);
      }
    }
    if (mode === '--media-only') { console.log(JSON.stringify(Object.fromEntries(needed),null,2)); return; }
    const receipts = [];
    for (const e of editions) {
      const media = needed.get(e.id)!, script = await json<Script>(exportFor(e.playerSeat));
      const result = await deliverEdition({ ...media, roomId:job.roomId, version:e.id, visibleSourceSeqs:await visible(e), locale:script.locale || 'zh-CN',
        ...(e.format === 'vertical' ? {expectedVideoTitle:verticalVideoTitle(script, videoUiLocale(script.uiLocale, env.VIDEO_LOCALE))} : {}),
        format:e.format, materialsDir:materialsFor(e), destination:join(delivery,e.id), encoding:rate });
      const receipt = { ...media, video:result.files.video, subtitles:result.files.subtitles };
      await save(pendingFile(e),receipt);
      await save(join(dirname(pendingFile(e)),'delivery.json'),result); receipts.push(result);
    }
    // Preserve original WAVs and manuscripts. A reused source project may belong to another job.
    const protectedFiles = [jobPath, delivery, ...job.editions.map(materialsFor), ...Object.values(job.cuts || {}).flatMap(c => [resolve(base,c.manuscript),resolve(base,c.reviewFile)])];
    const mayClean = (dir:string) => protectedFiles.every(path => path !== dir && !inside(dir,path));
    async function cleanRenderFiles(project:string) {
      for (const name of ['plates','segments','animations','audio-normalized','output/review','output/workflow-preview.mp4','output/latest-match.mp4','master.wav','preview.wav','preview.ffconcat','segments.ffconcat']) {
        const target = resolve(project,name);
        if (inside(project,target) && mayClean(target) && existsSync(target) && !(await lstat(target)).isSymbolicLink()) await rm(target,{recursive:true,force:true});
      }
    }
    for (const e of editions) {
      const dir = dirname(pendingFile(e));
      for (const entry of await readdir(dir,{withFileTypes:true})) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^(render|sample)-[a-f0-9]{16}$/.test(entry.name)) continue;
        const target = join(dir,entry.name);
        if (!inside(join(work,'editions'),target) || !mayClean(target)) continue;
        if (entry.name.startsWith('render-') && existsSync(join(target,'identity.json'))) await rm(target,{recursive:true});
        if (entry.name.startsWith('sample-') && existsSync(join(target,'sample-selection.json'))) await cleanRenderFiles(target);
      }
    }
    if (editions.length === job.editions.length) {
      for (const seat of views) {
        const project = sourceFor(seat), owner = join(project,'production-owner.json');
        if (!existsSync(owner)) continue;
        const binding = await json<{jobPath:string;roomId:string}>(owner);
        if (binding.jobPath === jobPath && binding.roomId === job.roomId) await cleanRenderFiles(project);
      }
    }
    console.log(JSON.stringify(receipts.map(r => ({...r.files,rate:r.bitrate})),null,2));
  } finally { await rm(lock,{recursive:true,force:true}); }
}
