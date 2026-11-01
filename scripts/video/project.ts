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
export interface Script { roomId: string; perspective: string; presetName: string; status: string; ruleCard?: string; sample?: boolean; cast: Cast[]; events: Fact[]; chapters: { day: number; phase: string; title: string; entries: Entry[] }[]; result: any }
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
}
export function clipVoiceProfile(voices: VoiceCatalog, clip: Pick<Clip, 'voiceKey' | 'data'>): VoiceProfile {
  const profile = voices.profiles[clip.voiceKey];
  if (!profile) throw Error(`No voice for ${clip.voiceKey}`);
  const cue = clip.voiceKey === 'judge' && clip.data.presentationOnly ? voices.judgeCues?.[clip.data.presentationKey] : undefined;
  if (!cue) return profile;
  if (cue.instruction !== undefined && (typeof cue.instruction !== 'string' || !cue.instruction.trim())) throw Error('Invalid judge cue instruction');
  if (cue.rate !== undefined && (!Number.isFinite(cue.rate) || cue.rate <= 0)) throw Error('Invalid judge cue rate');
  return { ...profile, instruction: cue.instruction ?? profile.instruction, rate: cue.rate ?? profile.rate };
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
export function spokenText(text: string) {
  return text.replace(/【([^】]+)】/g, '$1。').replace(/→/g, '投给').replace(/\d+(?:\.\d+)?/g, chineseNumber).replace(/\n+/g, '。').replace(/。{2,}/g, '。');
}
export function splitSpeech(text: string, limit = 230): string[] {
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
    const chunks = splitSpeech(e.text);
    return chunks.map((text, i) => ({ ...e, text, day: c.day, phase: c.phase, chapter: c.title, part: i + 1, parts: chunks.length,
      id: `${String(e.sourceSeq).padStart(3, '0')}${e.data.presentationKey ? `-${e.data.presentationKey}` : ''}-${i + 1}`, spokenText: spokenText(text), audioFile: join(projectDir, 'audio', `${String(e.sourceSeq).padStart(3, '0')}${e.data.presentationKey ? `-${e.data.presentationKey}` : ''}-${i + 1}.wav`) }));
  }));
}
