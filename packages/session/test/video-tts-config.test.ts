import { expect, it } from 'vitest';
import { qwenCacheKey } from '../src/speech/qwen';
import { environmentForTtsModel, resolveTtsModelConfig, selectVoiceCatalogModel } from '../../../scripts/video/tts-config';

it('selects the 3.1 Flash route and migrates project voices from one CLI model choice', () => {
  const config = resolveTtsModelConfig('qwen-audio-3.1-tts-flash');
  expect(config.endpoint).toBe('https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer');
  expect(config.apiKeyEnv).toBe('DASHSCOPE_API_KEY');
  const catalog = selectVoiceCatalogModel({
    model: 'qwen-audio-3.0-tts-plus',
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

it('binds cache identity to endpoint as well as model and request input', () => {
  const input = { text: 'hello', voice: 'voice', rate: 1 };
  expect(qwenCacheKey('https://token-plan.example/tts', 'model', input)).not.toBe(qwenCacheKey('https://dashscope.example/tts', 'model', input));
  expect(qwenCacheKey('https://token-plan.example/tts', 'model', input)).not.toBe(qwenCacheKey('https://token-plan.example/tts', 'other-model', input));
});

it('rejects an unknown custom profile when its voice is incompatible with the selected model', () => {
  expect(() => selectVoiceCatalogModel({
    model: 'qwen-audio-3.0-tts-plus',
    profiles: { custom: { voice: 'old-voice', label: 'custom', rate: 1, instruction: '' } },
  }, 'qwen-audio-3.1-tts-flash')).toThrow('No compatible');
});
