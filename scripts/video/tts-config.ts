import type { VoiceCatalog } from './project';

export interface TtsModelConfig {
  model: string;
  endpoint: string;
  apiKeyEnv?: string;
  voices?: Record<string, string>;
}

export const TOKEN_PLAN_ENDPOINT = 'https://token-plan.maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer';
export const DASHSCOPE_ENDPOINT = 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer';

// A model switch also selects voices from that model's own catalog.
const flashVoices: Record<string, string> = {
  commentator: 'longanlingxin_v3.1',
  judge: 'longshu_v3.1',
  // 许南川 occasionally clips this short phrase; use the compatible male
  // system voice that passed the same waveform gate for this project role.
  'seat-1': 'huozhuoshi_v3.1',
  'seat-2': 'yuxiaoyun_v3.1',
  'seat-3': 'anmingyuan_v3.1',
  'seat-4': 'longanhuan_v3.1',
  'seat-5': 'wenhuaiqing_v3.1',
  'seat-6': 'longanfengyue_v3.1',
  'seat-7': 'xuyuyuan_v3.1',
  'seat-8': 'xuxiaoqiao_v3.1',
  'seat-9': 'anxiaolan_v3.1',
  'seat-10': 'longanyuanfei_v3.1',
  'seat-11': 'wenhuaizhi_v3.1',
  'seat-12': 'xieshurou_v3.1',
};

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
    voices: flashVoices,
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
  const profiles = Object.fromEntries(Object.entries(catalog.profiles).map(([key, profile]) => {
    const selected = config.voices?.[key] ?? (model === 'qwen-audio-3.0-tts-plus' ? plusVoices[key] : undefined);
    if (selected) return [key, { ...profile, voice: selected }];
    if (compatibleVoice(profile.voice, model)) return [key, profile];
    throw Error(`No compatible ${model} voice for profile ${key}; choose a registered profile or provide a compatible custom voice`);
  }));
  return { ...catalog, model: config.model, profiles };
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
