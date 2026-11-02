import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { VoiceProfile, AudioMeta } from './qwen';
export const FPS = 30;
export const SAMPLE_RATE = 24000;
export const roomId = process.env.VIDEO_ROOM || 'e6220f1238';
if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) throw Error('Invalid room ID');
export const dataDir = resolve(process.env.VIDEO_DATA_DIR || 'data');
export const projectDir = resolve(process.env.VIDEO_PROJECT_DIR || resolve(dataDir, 'video', roomId));
export const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
export const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
export interface Cast { seat: number; name: string; role: string; roleName: string; factionName: string; voiceKey: string }
export interface Fact { sourceSeq: number; day: number; phase: string; type: string; audience: 'public' | number[]; spoken: boolean; text: string; data: Record<string, any> }
export interface Entry { sourceSeq: number; type: string; speaker: string; voiceKey: string; seat?: number; text: string; visibility: string; data: Record<string, any> }
export interface Script { locale?: string; roomId: string; perspective: string; presetName: string; status: string; ruleCard?: string; sample?: boolean; cast: Cast[]; events: Fact[]; chapters: { day: number; phase: string; title: string; entries: Entry[] }[]; result: any }
export interface Clip extends Entry { id: string; day: number; phase: string; chapter: string; part: number; parts: number; spokenText: string; audioFile: string }
export interface TimedClip extends Clip { frames: number; startFrame: number; audioDuration: number; audioMeta: AudioMeta; captions: { text: string; start: number; end: number }[]; envelope: number[] }
export async function loadScript(): Promise<Script> {
  const script = JSON.parse(await readFile(join(dataDir, 'exports', `${roomId}-video-script.json`), 'utf8')) as Script;
  if (script.roomId !== roomId || script.perspective !== 'god' || script.status !== 'ended') throw Error('Expected the completed, authorized god-view script');
  return script;
}
export interface VoiceCatalog {
  model: string;
  profiles: Record<string, VoiceProfile>;
  judgeCues?: Record<string, { instruction?: string; rate?: number }>;
  clipSeeds?: Record<string, number>;
}
// 仅精确匹配随旧版发布的默认指令；用户编辑过的文字始终原样保留。
const legacyVoiceInstructions: Readonly<Record<string, string>> = {
  "commentator": "请用普通话为一段狼人杀上帝视角视频配旁白。声音知性自然，像懂游戏的朋友陪观众看对局，分析时清楚克制，转折处有一点兴味和停顿。不要逐字念文稿的播音腔，不要夸张叫喊，不要擅自添加文字。",
  "judge": "请用标准普通话，以狼人杀法官的口吻清晰播报，冷静、公正、简洁，有自然停顿，不要夸张表演。",
  "seat-1": "请用普通话配音。一位聪明、慵懒、略带冷幽默的年轻男生，音色偏低，语气随性，分析时冷静犀利，像坐在朋友间玩推理游戏。自然说话，不要播音腔，不要夸张愤怒。",
  "seat-2": "请用普通话配音。一位清冷、理性、从容的年轻女生，咬字准确，句子干净，思路严密，带一点锋利的自信。语气克制，自然讨论，不要甜腻或机械播报。",
  "seat-3": "请用普通话配音。一位阳光、温和、自信的年轻男生，声音清朗，像可靠的同学组织讨论，有说服力而不盛气凌人。保持自然交流的节奏。",
  "seat-4": "请用普通话配音。一位亲切、明亮、有元气的年轻女生，带温暖的笑意，讨论游戏时会认真解释，有自然起伏。可爱但不幼童化，不要新闻播音腔。",
  "seat-5": "请用普通话配音。一位温柔、清秀、细腻的年轻男生，声音轻而清楚，态度友善，推理时认真坚定。语调自然，不用刻意压低嗓音，不要夸张撒娇。",
  "seat-6": "请用普通话配音。一位灵动、认真又稍有戏剧感的年轻女生，发言自信，论点转折清晰，偶尔有一点中二气质，但总体像真实同学在玩狼人杀。不要全程喊叫。",
  "seat-7": "请用普通话配音。一位热爱推理、带一点戏剧感的年轻男生，音色厚一些，讲论据时郑重自信，重音有层次。像朋友桌游讨论，保持清楚自然，不要舞台式大喊。",
  "seat-8": "请用普通话配音。一位俏皮、聪明、机敏的年轻女生，语调轻快，有一点小狡黠，提出反问时灵动，认真分析时仍然清晰。不要幼童化，不要夸张娇嗲。",
  "seat-9": "请用普通话配音。一位爽朗、有活力的年轻男生，表达直截了当，分析节奏利落，有热情和行动力。保留自然停顿，不要喊麦或机械宣读。",
  "seat-10": "请用普通话配音。一位声音明亮、爽朗、坚定的年轻女生，推理发言有底气，观点清晰，面对质疑保持自信。自然讨论，不要怒吼，不要播音腔。",
  "seat-11": "请用普通话配音。一位内敛、沉静、谨慎的年轻男生，声音自然偏轻，先思考再陈述，分析时逐渐坚定。清楚但不过度热情，不要机械或新闻播音腔。",
  "seat-12": "请用普通话配音。一位知性、细心、思路清楚的年轻女生，语速稳健，强调证据与因果，像同学认真讨论推理。语气自然，有温度，不要客服或新闻播音腔。",
};
const legacySeerCue = "请用标准普通话扮演狼人杀法官，像真人在桌边自然主持。整句话顺畅、连贯地说出来，把“预言家请睁眼”作为一个完整短句自然连读，不要拆成单字或单词点读，不要在“预言家”和“请睁眼”之间停顿，不要拉长单字。逗号处只作很轻的换气，然后自然接上后半句。声音平稳、清楚、自然，不要朗诵腔，不要擅自添加文字。";
export function clipVoiceProfile(voices: VoiceCatalog, clip: Pick<Clip, 'voiceKey' | 'data'> & { id?: string }, sourceLocale?: string): VoiceProfile {
  const profile = voices.profiles[clip.voiceKey];
  if (!profile) throw Error(`No voice for ${clip.voiceKey}`);
  const cue = clip.voiceKey === 'judge' && clip.data.presentationOnly ? voices.judgeCues?.[clip.data.presentationKey] : undefined;
  if (cue?.instruction !== undefined && (typeof cue.instruction !== 'string' || !cue.instruction.trim())) throw Error('Invalid judge cue instruction');
  if (cue?.rate !== undefined && (!Number.isFinite(cue.rate) || cue.rate <= 0)) throw Error('Invalid judge cue rate');
  const seed = clip.id ? voices.clipSeeds?.[clip.id] : undefined;
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 2147483647)) throw Error('Invalid clip synthesis seed');
  if (!cue && seed === undefined && sourceLocale === undefined) return profile;
  let instruction = cue?.instruction ?? profile.instruction;
  if (sourceLocale !== undefined) {
    let language: string;
    try { language = new Intl.Locale(sourceLocale).language; } catch { throw Error(`Invalid source language: ${sourceLocale}`); }
    if ((language === 'en' || language === 'ja') &&
        (cue?.instruction ? cue.instruction === legacySeerCue : instruction === legacyVoiceInstructions[clip.voiceKey])) {
      instruction = language === 'en'
        ? 'Speak naturally and clearly in English. Preserve the provided text exactly; do not add words.'
        : '日本語で自然にはっきり読み、指定された文章を変えず、言葉を追加しないでください。';
    }
    const languageHints = profile.locale === sourceLocale && profile.languageHints?.length
      ? profile.languageHints : [language === 'yue' ? 'zh' : language];
    return { ...profile, instruction, rate: cue?.rate ?? profile.rate, locale: sourceLocale, languageHints, ...(seed === undefined ? {} : { seed }) };
  }
  return { ...profile, instruction, rate: cue?.rate ?? profile.rate, ...(seed === undefined ? {} : { seed }) };
}
export async function loadVoices(): Promise<VoiceCatalog> {
  const file = process.env.VIDEO_VOICES_FILE;
  // Preparation creates the per-project voice file; initial defaults remain in the repository.
  return JSON.parse(await readFile(file && existsSync(file) ? file : 'scripts/video/voices.json', 'utf8')) as VoiceCatalog;
}
function chineseNumber(n: string): string {
  const digits = '零一二三四五六七八九';
  const [whole, decimal] = n.split('.'); const v = Number(whole);
  const integer = v < 10 ? digits[v] : v < 20 ? '十' + (v % 10 ? digits[v % 10] : '') : v < 100 ? digits[Math.floor(v / 10)] + '十' + (v % 10 ? digits[v % 10] : '') : whole;
  return integer + (decimal ? '点' + [...decimal].map((c) => digits[Number(c)]).join('') : '');
}
export function spokenText(text: string, locale = 'zh-CN') {
  if (new Intl.Locale(locale).language !== 'zh') return text;
  return text.replace(/【([^】]+)】/g, '$1。').replace(/→/g, '投给').replace(/\d+(?:\.\d+)?/g, chineseNumber).replace(/\n+/g, '。').replace(/。{2,}/g, '。');
}
export function splitSpeech(text: string, limit = 230, locale = 'zh-CN'): string[] {
  if (new Intl.Locale(locale).language === 'en') {
    const out: string[] = []; let current = '';
    for (let word of text.match(/\S+\s*/g) ?? [text]) {
      if (current && current.length + word.length > limit) { out.push(current.trim()); current = ''; }
      while (word.length > limit) {
        // 只有单个词超过上限时才必须在词内切分。
        const segment = word.slice(0, limit).trim(); if (segment) out.push(segment);
        word = word.slice(limit);
      }
      current += word;
    }
    if (current.trim()) out.push(current.trim());
    if (out.join('').replace(/\s/g, '') !== text.replace(/\s/g, '')) throw Error('Speech splitting changed source text');
    return out;
  }
  const sentences = text.match(/[^。！？!?\n]+[。！？!?\n]*/g) ?? [text];
  const out: string[] = []; let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > limit) { out.push(current.trim()); current = ''; }
    if (sentence.length > limit) {
      const clauses = sentence.match(/[^，；,;]+[，；,;]*/g) ?? [sentence];
      for (let clause of clauses) {
        if (current && current.length + clause.length > limit) { out.push(current.trim()); current = ''; }
        while (clause.length > limit) { out.push(clause.slice(0, limit)); clause = clause.slice(limit); }
        current += clause;
      }
    } else current += sentence;
  }
  if (current.trim()) out.push(current.trim());
  if (out.join('').replace(/\s/g, '') !== text.replace(/\s/g, '')) throw Error('Speech splitting changed source text');
  return out;
}
export function buildClips(script: Script): Clip[] {
  return script.chapters.flatMap((c) => c.entries.flatMap((e) => {
    const chunks = splitSpeech(e.text, 230, script.locale ?? 'zh-CN');
    return chunks.map((text, i) => ({ ...e, text, day: c.day, phase: c.phase, chapter: c.title, part: i + 1, parts: chunks.length,
      id: `${String(e.sourceSeq).padStart(3, '0')}${e.data.presentationKey ? `-${e.data.presentationKey}` : ''}-${i + 1}`, spokenText: spokenText(text, script.locale ?? 'zh-CN'), audioFile: join(projectDir, 'audio', `${String(e.sourceSeq).padStart(3, '0')}${e.data.presentationKey ? `-${e.data.presentationKey}` : ''}-${i + 1}.wav`) }));
  }));
}
