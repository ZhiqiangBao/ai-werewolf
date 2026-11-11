import { expect, it } from 'vitest';
import { qwenCacheKey } from '../src/speech/qwen';
import { environmentForTtsModel, environmentForVoiceCatalog, resolveTtsModelConfig, selectVoiceCatalogModel } from '../../../scripts/video/tts-config';
import { clipVoiceProfile } from '../../../scripts/video/project';

it('selects the 3.1 Flash route and migrates project voices from one CLI model choice', () => {
  const config = resolveTtsModelConfig('qwen-audio-3.1-tts-flash');
  expect(config.endpoint).toBe('https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer');
  expect(config.apiKeyEnv).toBe('DASHSCOPE_API_KEY');
  const catalog = selectVoiceCatalogModel({
    model: 'qwen-audio-3.0-tts-plus',
    theme: 'gufeng',
    profiles: {
      commentator: { voice: 'old-commentator', label: '解说', rate: 1, instruction: '' },
      judge: { voice: 'old-judge', label: '法官', rate: 1, instruction: '' },
      'seat-1': { voice: 'old-seat', label: '1号', rate: 1, instruction: '' },
    },
  }, 'qwen-audio-3.1-tts-flash');
  expect(catalog.model).toBe('qwen-audio-3.1-tts-flash');
  expect(catalog.profiles.commentator.voice).toBe('longanlingxin_v3.1');
  expect(catalog.profiles.judge.voice).toBe('longshu_v3.1');
  expect(catalog.profiles['seat-1'].voice).toBe('huozhuoshi_v3.1');
});

it('rejects a model that has no route and voice catalog', () => {
  expect(() => resolveTtsModelConfig('unknown-tts-model')).toThrow('Unsupported TTS model');
});

it('clears inherited endpoint routing for the legacy model and selects the Flash route explicitly', () => {
  expect(environmentForTtsModel('qwen-audio-3.0-tts-plus')).toEqual({
    VIDEO_TTS_MODEL: 'qwen-audio-3.0-tts-plus',
    VIDEO_TTS_ENDPOINT: '',
    VIDEO_TTS_API_KEY_ENV: 'WEREWOLF_TTS_API_KEY',
  });
  expect(environmentForTtsModel('qwen-audio-3.1-tts-flash')).toEqual({
    VIDEO_TTS_MODEL: 'qwen-audio-3.1-tts-flash',
    VIDEO_TTS_ENDPOINT: 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer',
    VIDEO_TTS_API_KEY_ENV: 'DASHSCOPE_API_KEY',
  });
});

it('migrates a Flash project back to compatible Plus voices instead of leaving _v3.1 IDs', () => {
  const catalog = selectVoiceCatalogModel({
    model: 'qwen-audio-3.1-tts-flash',
    profiles: {
      commentator: { voice: 'longanlingxin_v3.1', label: '解说', rate: 1, instruction: '' },
      judge: { voice: 'longshu_v3.1', label: '法官', rate: 1, instruction: '' },
      'seat-1': { voice: 'huozhuoshi_v3.1', label: '1号', rate: 1, instruction: '' },
    },
  }, 'qwen-audio-3.0-tts-plus');
  expect(catalog.model).toBe('qwen-audio-3.0-tts-plus');
  expect(catalog.profiles.commentator.voice).toBe('longanlingxin');
  expect(catalog.profiles.judge.voice).toBe('qwen-audio-3.0-tts-plus-longshuojizhu');
  expect(catalog.profiles['seat-1'].voice).toBe('qwen-audio-3.0-tts-plus-longxinruixuan');
});

it('uses the selected model route even when saved endpoint and key settings belong to the other model', () => {
  for (const model of ['qwen-audio-3.0-tts-plus', 'qwen-audio-3.1-tts-flash']) {
    const wrongRoute = resolveTtsModelConfig(model.includes('3.0') ? 'qwen-audio-3.1-tts-flash' : 'qwen-audio-3.0-tts-plus');
    expect(environmentForVoiceCatalog({ model, profiles: {}, endpoint: wrongRoute.endpoint, apiKeyEnv: wrongRoute.apiKeyEnv })).toEqual(environmentForTtsModel(model));
  }
});

it('binds cache identity to endpoint as well as model and request input', () => {
  const input = { text: 'hello', voice: 'voice', rate: 1 };
  expect(qwenCacheKey('https://token-plan.example/tts', 'model', input)).not.toBe(qwenCacheKey('https://dashscope.example/tts', 'model', input));
  expect(qwenCacheKey('https://token-plan.example/tts', 'model', input)).not.toBe(qwenCacheKey('https://token-plan.example/tts', 'other-model', input));
  expect(qwenCacheKey('https://token-plan.example/tts', 'model', input)).not.toBe(qwenCacheKey('https://token-plan.example/tts', 'model', { ...input, volume: 30 }));
});

it('applies a validated clip volume without changing the seat voice', () => {
  const profile = clipVoiceProfile({
    model: 'qwen-audio-3.1-tts-flash',
    profiles: { 'seat-1': { voice: 'qwen-audio-3.1-tts-flash-vd-example', label: '1号', rate: 1, instruction: '' } },
    clipVolumes: { '008-1': 30 },
  }, { id: '008-1', voiceKey: 'seat-1', data: {} });
  expect(profile.voice).toBe('qwen-audio-3.1-tts-flash-vd-example');
  expect(profile.volume).toBe(30);
  expect(() => clipVoiceProfile({
    model: 'qwen-audio-3.1-tts-flash',
    profiles: { 'seat-1': { voice: 'voice', label: '1号', rate: 1, instruction: '' } },
    clipVolumes: { '008-1': 101 },
  }, { id: '008-1', voiceKey: 'seat-1', data: {} })).toThrow('Invalid clip synthesis volume');
});

it('rejects an unknown custom profile when its voice is incompatible with the selected model', () => {
  expect(() => selectVoiceCatalogModel({
    model: 'qwen-audio-3.0-tts-plus',
    theme: 'gufeng',
    profiles: { custom: { voice: 'old-voice', label: 'custom', rate: 1, instruction: '' } },
  }, 'qwen-audio-3.1-tts-flash')).toThrow('No compatible');
});
