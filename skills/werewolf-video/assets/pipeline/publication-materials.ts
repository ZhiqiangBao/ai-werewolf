import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** One record for one delivered version. The creator reviews semantics and the generated image. */
export interface PublicationMaterial {
  roomId: string;
  version: string;
  highlight: { sourceSeqs: number[]; description: string };
  title: string;
  coverTitle: string;
  /** Exact prompt submitted to the authorized image generator, including coverTitle. */
  submittedPrompt: string;
  coverSha256: string;
  review: { status: 'reviewed'; method: string; digest: string };
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
function publicationTitle(copy: string) {
  const lines = copy.replace(/^\uFEFF/, '').split(/\r\n?|\n/);
  const heading = lines.findIndex(line => /^# (?:标题|Title)\s*$/i.test(line));
  if (heading < 0) return undefined;
  const title = lines.slice(heading + 1).map(line => line.trim()).find(Boolean);
  return title && !/^#{1,6}(?:\s|$)/.test(title) ? title : undefined;
}

/** Only identify titles made entirely from generic format/view labels; review still judges relevance. */
function genericTitle(value: string): boolean {
  const remainder = value.toLowerCase()
    .replace(/(?:\d+号)?(?:玩家|上帝|全知|观众|旁观者)视角|第一视角|视角|狼人杀|完整对局|完整局|完整片|完整|全程|精彩复盘|精彩回顾|精彩集锦|对局复盘|本局复盘|精彩对局|对局|复盘|高光|精华|合集|游戏|最新一局|一局|精彩|实录|解说|回顾|频道/g, '')
    .replace(/\b(?:ai|werewolf|mafia|god|omniscient|player|spectator|seat|view|perspective|full|complete|match|game|gameplay|highlight|highlights|compilation|recap|review|episode|playthrough|the|of|a|an)\b/g, '')
    .replace(/[\p{P}\p{S}\s]/gu, '');
  return remainder.length === 0;
}
function forbidsAllText(prompt: string): boolean {
  return prompt.split(/[。！？；;!?\n]+/).some((clause) => {
    const permitsTitle = /(?:除|除了|除去)[^。；;\n]{0,20}(?:标题|短题|文字)[^。；;\n]{0,12}(?:外|以外|之外)/i.test(clause) ||
      /\b(?:except|apart from|other than)\b[^.;\n]{0,30}\b(?:title|headline|text)\b/i.test(clause);
    if (permitsTitle) return false;
    return /无字|无文字|纯无字|不要任何字|(?:不要|不含|不写|不出现|禁止|不添加|不放|没有|不得有)(?:任何|所有|一切)?(?:文字|文本|字样|标题)/.test(clause) ||
      /\b(?:no|without)\s+(?:(?:any|all)\s+)?(?!other\b|additional\b|extra\b)(?:text|letters?|lettering|words?|titles?|typography)\b|\btext[- ]free\b|\b(?:do not|don't|never)\s+(?:include|add|use|write|show|render)\s+(?:(?:any|all)\s+)?(?!other\b|additional\b|extra\b)(?:text|letters?|lettering|words?|titles?)\b/i.test(clause);
  });
}

/** Bind the actual copy, selected version, evidence, prompt and image to the review. */
export function publicationReviewDigest(material: PublicationMaterial, copy: string): string {
  return hash(JSON.stringify([material.roomId, material.version, material.highlight, material.title,
    material.coverTitle, material.submittedPrompt, material.coverSha256, hash(copy)]));
}

export async function validatePublicationMaterials(input: {
  roomId: string; version: string; visibleSourceSeqs: readonly number[];
  copy: string; material: unknown; coverFile: string;
}): Promise<string[]> {
  const issues: string[] = [];
  const material = input.material as PublicationMaterial | null;
  if (!material || typeof material !== 'object' || Array.isArray(material)) return ['缺少本版发布材料记录'];
  if (material.roomId !== input.roomId || material.version !== input.version) issues.push('发布材料的房间或版本不匹配');
  const highlight = material.highlight;
  if (!highlight || !nonempty(highlight.description) || !Array.isArray(highlight.sourceSeqs) || !highlight.sourceSeqs.length ||
      highlight.sourceSeqs.some((seq) => !Number.isInteger(seq) || !input.visibleSourceSeqs.includes(seq))) {
    issues.push('本版看点必须注明说明和当前视角实际可见的来源事件');
  }
  if (!nonempty(material.title) || publicationTitle(input.copy) !== material.title.trim()) issues.push('发布标题与定稿文案不一致');
  if (nonempty(material.title) && genericTitle(material.title)) issues.push('发布标题只有类型或视角套语，请写出本版真实看点');
  if (nonempty(material.coverTitle) && genericTitle(material.coverTitle)) issues.push('封面短标题只有类型或视角套语，请写出本版真实看点');
  if (!nonempty(material.coverTitle) || !nonempty(material.submittedPrompt) || !material.submittedPrompt.includes(material.coverTitle)) issues.push('实际生图提示词必须包含定稿封面短标题');
  else if (forbidsAllText(material.submittedPrompt)) issues.push('实际生图提示词要求无字，必须由模型与画面一起绘制定稿短标题');
  if (!/^[0-9a-f]{64}$/.test(material.coverSha256 ?? '')) issues.push('缺少最终封面 SHA-256');
  else try {
    const cover = await readFile(input.coverFile);
    if (cover.length <= 8 || !cover.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) issues.push('最终封面不是 PNG 文件');
    if (hash(cover) !== material.coverSha256) issues.push('最终封面与制作记录不一致');
  } catch { issues.push('无法读取最终封面'); }
  if (!material.review || material.review.status !== 'reviewed' || !nonempty(material.review.method) ||
      material.review.digest !== publicationReviewDigest(material, input.copy)) issues.push('本版材料或成品变化后必须重新完成审核并绑定记录');
  return issues;
}
import { randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Record only after the creator has reviewed the current version and actual generated image. */
export async function recordPublicationMaterials(input: {
  materialsDir: string; roomId: string; version: string; visibleSourceSeqs: readonly number[]; reviewedBy: string;
}): Promise<{ file: string; material: PublicationMaterial }> {
  if (!nonempty(input.reviewedBy) || !nonempty(input.roomId) || !nonempty(input.version)) throw Error('必须提供房间、版本和实际复核者');
  if (!Array.isArray(input.visibleSourceSeqs) || input.visibleSourceSeqs.some((seq) => !Number.isInteger(seq))) throw Error('必须提供当前版本实际可见的来源序号');
  const dir = resolve(input.materialsDir);
  const draft = JSON.parse(await readFile(join(dir, 'publication-draft.json'), 'utf8')) as Pick<PublicationMaterial, 'highlight' | 'coverTitle' | 'submittedPrompt'>;
  const copy = await readFile(join(dir, 'publish-copy.md'), 'utf8');
  const title = publicationTitle(copy);
  if (!title) throw Error('发布正文缺少定稿标题');
  const coverFile = join(dir, 'cover.png');
  const material: PublicationMaterial = { roomId: input.roomId, version: input.version, highlight: draft.highlight,
    title, coverTitle: draft.coverTitle, submittedPrompt: draft.submittedPrompt,
    coverSha256: hash(await readFile(coverFile)), review: { status: 'reviewed', method: input.reviewedBy, digest: '' } };
  material.review.digest = publicationReviewDigest(material, copy);
  const issues = await validatePublicationMaterials({ ...input, copy, material, coverFile });
  if (issues.length) throw Error(issues.join('；'));
  const file = join(dir, 'publication.json'), tmp = join(dir, `.publication-${randomUUID()}.tmp`);
  try { await writeFile(tmp, JSON.stringify(material, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); await rename(tmp, file); }
  finally { await rm(tmp, { force: true }); }
  return { file, material };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!args.includes('--record') || args.some((arg) => arg !== '--record' && !/^--(?:materials-dir|room|version|visible|reviewed-by)=/.test(arg))) throw Error('用法：--record --materials-dir=目录 --room=房间 --version=版本 --visible=本版来源序号JSON --reviewed-by=实际复核者');
  const materialsDir = option('materials-dir'), roomId = option('room'), version = option('version'), visible = option('visible'), reviewedBy = option('reviewed-by');
  if (!materialsDir || !roomId || !version || !visible || !reviewedBy) throw Error('缺少登记参数');
  const visibleSourceSeqs = JSON.parse(await readFile(visible, 'utf8')) as unknown;
  if (!Array.isArray(visibleSourceSeqs) || visibleSourceSeqs.some((value) => !Number.isInteger(value))) throw Error('visible 文件必须为本版实际可见的来源序号数组');
  const result = await recordPublicationMaterials({ materialsDir, roomId, version, visibleSourceSeqs, reviewedBy });
  console.log(JSON.stringify({ file: result.file, roomId, version, title: result.material.title }));
}
