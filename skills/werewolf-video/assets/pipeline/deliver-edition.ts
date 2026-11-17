import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { verifyEncodingRate, type EncodingSettings } from './encoding';
import { validatePublicationMaterials } from './publication-materials';

const exec = promisify(execFile);
const ffprobe = () => process.env.FFPROBE_PATH || 'ffprobe';
const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';
export interface DeliverEditionArgs {
  roomId: string;
  version: string;
  visibleSourceSeqs: readonly number[];
  locale: string;
  video: string;
  subtitles: string;
  materialsDir: string;
  destination: string;
  encoding: EncodingSettings;
  format: 'horizontal' | 'vertical';
  checkOnly?: boolean;
  expectedMedia?: { video: string; subtitles: string };
  expectedVideoTitle?: string;
}
export interface DeliverEditionResult {
  destination: string;
  files: { video: string; cover: string; copy: string; subtitles: string };
  durationSeconds: number;
  width: number;
  height: number;
  checkedOnly: boolean;
  bitrate: Awaited<ReturnType<typeof verifyEncodingRate>>;
  sha256: { video: string; cover: string; copy: string; subtitles: string };
}
const digest = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};
const exists = async (path: string) => {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};
function subtitleEnd(srt: string): number {
  const blocks = srt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n/);
  if (!blocks.length || !blocks[0]) throw Error('字幕为空');
  let previousStart = -1, previousEnd = -1;
  const time = (value: string) => {
    const match = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
    if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) throw Error('字幕时间格式无效');
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
  };
  for (const block of blocks) {
    const lines = block.split('\n');
    const match = /^(\d{2,}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2},\d{3})\s*$/.exec(lines[1] ?? '');
    if (!/^\d+$/.test(lines[0] ?? '') || !match || !lines.slice(2).join('\n').trim()) throw Error('字幕条目缺少序号、时间或正文');
    const start = time(match[1]), end = time(match[2]);
    if (end <= start || start < previousStart || end < previousEnd) throw Error('字幕时间必须单调且结束晚于开始');
    previousStart = start; previousEnd = end;
  }
  return previousEnd;
}
async function picture(path: string, format: DeliverEditionArgs['format']) {
  const { stdout } = await exec(ffprobe(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const media = JSON.parse(stdout) as { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string; format_name?: string; tags?: { title?: string } } };
  const video = media.streams?.find((stream) => stream.codec_type === 'video');
  const audio = media.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(media.format?.duration);
  const expected = format === 'horizontal' ? [1920, 1080] : [1080, 1920];
  if (!media.format?.format_name?.split(',').includes('mp4') || !video || !audio || video.width !== expected[0] || video.height !== expected[1] || !Number.isFinite(duration) || duration <= 0) throw Error('成片缺少音视频、时长无效或分辨率与版式不一致');
  return { width: video.width!, height: video.height!, duration, title: media.format?.tags?.title };
}

/** Stage and validate the exact four files, then replace only those files with rollback on failure. */
export async function deliverEdition(args: DeliverEditionArgs): Promise<DeliverEditionResult> {
  if (!isAbsolute(args.destination) || !/^[\p{L}\p{N}_-]+$/u.test(args.locale) || !args.roomId.trim() || !args.version.trim() || !['horizontal', 'vertical'].includes(args.format)) throw Error('交付目录、语言、房间、版本或版式无效');
  const destination = resolve(args.destination);
  const files = { video: join(destination, 'video.mp4'), cover: join(destination, 'cover.png'), copy: join(destination, `标题与简介-${args.locale}.txt`), subtitles: join(destination, `subtitles-${args.locale}.srt`) };
  await mkdir(destination, { recursive: true });
  const lock = join(destination, '.delivery.lock');
  try { await mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error(`该版本目录已有转存任务或遗留锁：${lock}`);
    throw error;
  }
  try {
  const stage = await mkdtemp(join(destination, '.delivery-'));
  const staged = { video: join(stage, 'video.mp4'), cover: join(stage, 'cover.png'), copy: join(stage, 'copy.txt'), subtitles: join(stage, 'subtitles.srt') };
  let preserveStage = false;
  try {
    const copy = await readFile(join(args.materialsDir, 'publish-copy.md'), 'utf8');
    const material = JSON.parse(await readFile(join(args.materialsDir, 'publication.json'), 'utf8')) as unknown;
    const copies = await Promise.allSettled([
      copyFile(args.video, staged.video), copyFile(args.subtitles, staged.subtitles),
      copyFile(join(args.materialsDir, 'cover.png'), staged.cover), writeFile(staged.copy, copy, 'utf8'),
    ]);
    const failedCopy = copies.find((result) => result.status === 'rejected');
    if (failedCopy?.status === 'rejected') throw failedCopy.reason;
    const description = /^# (?:简介|Description)[ \t]*\r?\n([\s\S]*)/im.exec(copy)?.[1].split(/^#{1,2}\s/m)[0].trim();
    if (!description) throw Error('发布文案缺少简介正文');
    const issues = await validatePublicationMaterials({ roomId: args.roomId, version: args.version, visibleSourceSeqs: args.visibleSourceSeqs, copy, material, coverFile: staged.cover });
    if (issues.length) throw Error(issues.join('；'));
    // Decode the whole image, not just its signature or metadata.
    await exec(ffmpeg(), ['-v', 'error', '-xerror', '-i', staged.cover, '-frames:v', '1', '-f', 'null', '-'], { windowsHide: true });
    const media = await picture(staged.video, args.format);
    if (args.expectedVideoTitle !== undefined && (!args.expectedVideoTitle.trim() || media.title !== args.expectedVideoTitle)) throw Error('成片元数据标题与当前视角不一致');
    const end = subtitleEnd(await readFile(staged.subtitles, 'utf8'));
    if (end > media.duration + 0.001) throw Error('最后一条字幕超出成片时长');
    const bitrate = await verifyEncodingRate(staged.video, args.encoding);
    const keys = ['video', 'cover', 'copy', 'subtitles'] as const;
    const sha256 = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await digest(staged[key])]))) as DeliverEditionResult['sha256'];
    if (args.expectedMedia && (sha256.video !== args.expectedMedia.video || sha256.subtitles !== args.expectedMedia.subtitles)) throw Error('成片或字幕与已确认的版本不一致');
    if (!args.checkOnly) {
      const backedUp: typeof keys[number][] = [], installed: typeof keys[number][] = [];
      try {
        for (const key of keys) {
          const existing = await exists(files[key]);
          if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw Error(`交付目标不是普通文件：${files[key]}`);
        }
        for (const key of keys) {
          if (await exists(files[key])) { await rename(files[key], join(stage, `backup-${key}`)); backedUp.push(key); }
          await rename(staged[key], files[key]); installed.push(key);
        }
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const key of installed.reverse()) try { await rm(files[key]); } catch (e) { rollbackErrors.push(String(e)); }
        for (const key of backedUp.reverse()) try { await rename(join(stage, `backup-${key}`), files[key]); } catch (e) { rollbackErrors.push(String(e)); }
        if (rollbackErrors.length) { preserveStage = true; throw Error(`转存失败且无法完整恢复，保留备份 ${stage}：${rollbackErrors.join('；')}；原错误：${String(error)}`); }
        throw error;
      }
    }
    return { destination, files, durationSeconds: media.duration, width: media.width, height: media.height, checkedOnly: !!args.checkOnly, bitrate, sha256 };
  } finally {
    if (!preserveStage) await rm(stage, { recursive: true, force: true });
  }
  } finally { await rmdir(lock); }
}
