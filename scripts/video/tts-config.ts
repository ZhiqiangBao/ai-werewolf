import type { VoiceCatalog } from './project';
import { characterGender } from './character-voices';

export interface TtsModelConfig {
  model: string;
  endpoint: string;
  apiKeyEnv?: string;
  voices?: Record<string, string>;
}

export const TOKEN_PLAN_ENDPOINT = 'https://token-plan.maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer';
export const DASHSCOPE_ENDPOINT = 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer';
export const DEFAULT_VIDEO_TTS_MODEL = 'qwen-audio-3.1-tts-flash';

export function projectTtsModel(requested?: string, saved?: Pick<VoiceCatalog, 'model'>): string {
  const model = requested?.trim() || saved?.model || DEFAULT_VIDEO_TTS_MODEL;
  resolveTtsModelConfig(model);
  return model;
}

// A model switch also selects voices from that model's own catalog. Player
// voices are selected from gender-verified pools after the avatar theme is known.
const flashRoleVoices: Record<string, string> = {
  commentator: 'longanlingxin_v3.1',
  judge: 'longshu_v3.1',
};
const flashMaleVoices = ['huozhuoshi_v3.1', 'anmingyuan_v3.1', 'longshao_v3.1', 'longze_v3.1', 'longhao_v3.1', 'longjin_v3.1'];
const flashFemaleVoices = ['yuxiaoyun_v3.1', 'longanhuan_v3.1', 'longanfengyue_v3.1', 'xuxiaoqiao_v3.1', 'longanyuanfei_v3.1', 'xieshurou_v3.1'];
export const flashVoiceGender: Record<string, '男' | '女'> = Object.fromEntries([
  ...flashMaleVoices.map((voice) => [voice, '男']), ...flashFemaleVoices.map((voice) => [voice, '女']),
]) as Record<string, '男' | '女'>;

// These are the stable default Plus voices produced by character-voices.ts.
// They are also the fallback when an existing project is moved back from Flash.
const plusVoices: Record<string, string> = {
  commentator: 'longanlingxin',
  judge: 'qwen-audio-3.0-tts-plus-longshuojizhu',
  'seat-1': 'qwen-audio-3.0-tts-plus-longxinruixuan',
  'seat-2': 'qwen-audio-3.0-tts-plus-longlingxingxia',
  'seat-3': 'qwen-audio-3.0-tts-plus-longlangmoyue',
  'seat-4': 'qwen-audio-3.0-tts-plus-longlingjinquan',
  'seat-5': 'qwen-audio-3.0-tts-plus-longyanfengying',
  'seat-6': 'qwen-audio-3.0-tts-plus-longlanqinluan',
  'seat-7': 'qwen-audio-3.0-tts-plus-longluanlanju',
  'seat-8': 'qwen-audio-3.0-tts-plus-longjinmeicheng',
  'seat-9': 'qwen-audio-3.0-tts-plus-longyiqinghui',
  'seat-10': 'qwen-audio-3.0-tts-plus-longshuangxuandie',
  'seat-11': 'qwen-audio-3.0-tts-plus-longyanfengying',
  'seat-12': 'qwen-audio-3.0-tts-plus-longlanqinluan',
};

const models: Record<string, TtsModelConfig> = {
  'qwen-audio-3.0-tts-plus': {
    model: 'qwen-audio-3.0-tts-plus',
    endpoint: TOKEN_PLAN_ENDPOINT,
    apiKeyEnv: 'WEREWOLF_TTS_API_KEY',
  },
  'qwen-audio-3.1-tts-flash': {
    model: 'qwen-audio-3.1-tts-flash',
    endpoint: DASHSCOPE_ENDPOINT,
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    voices: flashRoleVoices,
  },
};

export function resolveTtsModelConfig(model: string): TtsModelConfig {
  const config = models[model];
  if (!config) throw Error(`Unsupported TTS model: ${model}; choose qwen-audio-3.0-tts-plus or qwen-audio-3.1-tts-flash`);
  return config;
}

function compatibleVoice(voice: string, model: string): boolean {
  if (model === 'qwen-audio-3.1-tts-flash') return voice.endsWith('_v3.1') || voice.startsWith('qwen-audio-3.1-tts-flash-');
  return voice.startsWith('qwen-audio-3.0-tts-plus-') || Object.values(plusVoices).includes(voice);
}

/**
 * Apply a CLI-selected model without asking the author to hand-edit voices.json.
 * Known project roles are always assigned a voice from the selected model catalog;
 * custom roles are preserved only when their existing voice already belongs to it.
 */
export function selectVoiceCatalogModel(catalog: VoiceCatalog, model: string): VoiceCatalog {
  const config = resolveTtsModelConfig(model);
  const flashVoices = model === 'qwen-audio-3.1-tts-flash' ? selectThemeFlashVoices(catalog) : undefined;
  const profiles = Object.fromEntries(Object.entries(catalog.profiles).map(([key, profile]) => {
    const binding = catalog.modelVoiceBindings?.[model]?.[key] ?? (model === 'qwen-audio-3.1-tts-flash' ? catalog.flashVoiceBindings?.[key] : undefined);
    if (!binding && catalog.model === model && compatibleVoice(profile.voice, model)) return [key, profile];
    const selected = binding ?? flashVoices?.[key] ?? config.voices?.[key] ?? (model === 'qwen-audio-3.0-tts-plus' ? catalog.themeVoiceBindings?.[key] ?? plusVoices[key] : undefined);
    if (selected) {
      if (!compatibleVoice(selected, model)) throw Error(`Incompatible voice binding for ${model} ${key}`);
      return [key, { ...profile, voice: selected }];
    }
    if (compatibleVoice(profile.voice, model)) return [key, profile];
    throw Error(`No compatible ${model} voice for profile ${key}; choose a registered profile or provide a compatible custom voice`);
  }));
  return { ...catalog, model: config.model, endpoint: config.endpoint, apiKeyEnv: config.apiKeyEnv, profiles };
}

function selectThemeFlashVoices(catalog: VoiceCatalog): Record<string, string> {
  if (!catalog.theme) throw Error('Flash voice selection requires a theme-bound voice catalog; prepare the project with an explicit avatar theme first');
  let male = 0, female = 0;
  const result: Record<string, string> = {};
  const seatKeys = Object.keys(catalog.profiles).filter((key) => /^seat-(\d+)$/.test(key))
    .sort((a, b) => Number(/^seat-(\d+)$/.exec(a)![1]) - Number(/^seat-(\d+)$/.exec(b)![1]));
  for (const key of seatKeys) {
    const match = /^seat-(\d+)$/.exec(key)!;
    const gender = characterGender(catalog.theme, Number(match[1]));
    const pool = gender === '男' ? flashMaleVoices : flashFemaleVoices;
    const index = gender === '男' ? male++ : female++;
    if (!pool[index]) throw Error(`No gender-matched Flash system voice remains for ${catalog.theme} ${key}; create and register a target-model voice before switching`);
    result[key] = pool[index];
  }
  return result;
}

export function voiceCatalogIssues(catalog: VoiceCatalog): string[] {
  const issues: string[] = [];
  if (catalog.model !== 'qwen-audio-3.1-tts-flash') return issues;
  if (!catalog.theme) return ['Flash 声音表缺少 avatar theme'];
  for (const key of Object.keys(catalog.profiles)) {
    const match = /^seat-(\d+)$/.exec(key);
    if (!match) continue;
    const profile = catalog.profiles[key], expected = characterGender(catalog.theme, Number(match[1]));
    const known = flashVoiceGender[profile.voice];
    if (known && known !== expected) issues.push(`${key} 的 Flash 声线性别与 ${catalog.theme} 立绘不一致`);
    const enrolledVoice = catalog.modelVoiceBindings?.[catalog.model]?.[key] ?? catalog.flashVoiceBindings?.[key];
    const enrolled = enrolledVoice === profile.voice;
    if (!known && !enrolled && !profile.voice.startsWith('qwen-audio-3.1-tts-flash-')) issues.push(`${key} 的 Flash 声线未绑定到目标模型`);
    if (enrolledVoice && enrolledVoice !== profile.voice) issues.push(`${key} 的 Flash 声线与 voice enrollment manifest 不一致`);
  }
  return issues;
}

/** Environment values for a selected model. Empty values deliberately clear stale inherited routing. */
export function environmentForTtsModel(model: string): Record<string, string> {
  const config = resolveTtsModelConfig(model);
  return {
    VIDEO_TTS_MODEL: config.model,
    VIDEO_TTS_ENDPOINT: config.endpoint === TOKEN_PLAN_ENDPOINT ? '' : config.endpoint,
    VIDEO_TTS_API_KEY_ENV: config.apiKeyEnv ?? '',
  };
}

export function environmentForVoiceCatalog(catalog: VoiceCatalog): Record<string, string> {
  return environmentForTtsModel(catalog.model);
}
