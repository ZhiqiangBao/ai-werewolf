export interface VoiceProfile { voice: string; label: string; rate: number; instruction: string }
export interface Word { text: string; begin_time: number; end_time: number; begin_index?: number; end_index?: number }
export interface AudioMeta {
  cacheKey: string; provider?: string; model: string; voice: string; text: string;
  sentences: { index: number; text: string; words: Word[] }[];
  alignment?: { method: 'provider' | 'forced-alignment'; engine: string };
  requestId?: string; bytes: number;
}
/** Adapters return measured audio and real timestamps, and persist WAV plus its .json sidecar. */
export type SpeechSynthesizer = (text: string, profile: VoiceProfile, model: string, output: string) => Promise<AudioMeta>;
