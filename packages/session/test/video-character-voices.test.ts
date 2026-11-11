import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { characterVoices, applyCharacterVoices } from '../../../scripts/video/character-voices';
import { characterVoiceDirection, applyCharacterDelivery } from '../../../scripts/video/character-delivery';
import { DASHSCOPE_ENDPOINT, TOKEN_PLAN_ENDPOINT, projectTtsModel, selectVoiceCatalogModel, environmentForVoiceCatalog } from '../../../scripts/video/tts-config';
import type { VoiceCatalog } from '../../../scripts/video/project';

const plus = 'qwen-audio-3.0-tts-plus', flash = 'qwen-audio-3.1-tts-flash';
const cast = Array.from({ length: 12 }, (_, index) => ({ seat: index + 1, name: `玩家${index + 1}`, role: '', roleName: '', factionName: '', voiceKey: `seat-${index + 1}` }));
function catalog(theme: string, model: string): VoiceCatalog {
  const base: VoiceCatalog = { model: plus, profiles: Object.fromEntries(cast.map(member => [member.voiceKey, { voice: '', label: member.name, rate: 1, instruction: '' }])) };
  return selectVoiceCatalogModel(applyCharacterDelivery(applyCharacterVoices(base, cast, theme), cast, theme), model);
}

it('covers all 72 portraits with distinct directions on both synthesis routes', () => {
  for (const [theme, characters] of Object.entries(characterVoices)) {
    const instructions = new Set<string>();
    expect(characters).toHaveLength(12);
    for (const member of cast) {
      const direction = characterVoiceDirection(theme, member.seat);
      expect(direction.gender).toBe(characters[member.seat - 1].gender);
      expect(direction.appearance).toBe(characters[member.seat - 1].appearance);
      expect([...direction.designPrompt].length).toBeLessThanOrEqual(500);
      instructions.add(direction.instruction);
    }
    expect(instructions.size).toBe(12);
    for (const model of [plus, flash]) {
      const voices = catalog(theme, model);
      expect(voices.endpoint).toBe(model === plus ? TOKEN_PLAN_ENDPOINT : DASHSCOPE_ENDPOINT);
      for (const member of cast) expect(voices.profiles[member.voiceKey].instruction).toBe(characterVoiceDirection(theme, member.seat).instruction);
    }
  }
  expect(projectTtsModel()).toBe(flash);
  expect(projectTtsModel(undefined, { model: plus })).toBe(plus);
});

it('preserves saved designs and restores the theme-specific Plus bindings after a model switch', () => {
  const original = catalog('gufeng', plus);
  original.profiles['seat-1'].instruction = '用户自行调整的声线';
  const saved = `${plus}-vd-custom1`;
  original.profiles['seat-1'].voice = saved;
  const same = selectVoiceCatalogModel(original, plus);
  expect(same.profiles['seat-1']).toEqual(original.profiles['seat-1']);
  original.modelVoiceBindings = { [plus]: { 'seat-1': saved } };
  const switched = selectVoiceCatalogModel(original, flash);
  switched.flashVoiceBindings = { 'seat-1': `${flash}-vd-flash1` };
  const restored = selectVoiceCatalogModel(switched, plus);
  expect(restored.profiles['seat-1'].voice).toBe(saved);
  expect(restored.profiles['seat-9'].voice).toBe(original.profiles['seat-9'].voice);
  expect(restored.profiles['seat-1'].instruction).toBe('用户自行调整的声线');
  expect(environmentForVoiceCatalog(restored)).toEqual({ VIDEO_TTS_MODEL: plus, VIDEO_TTS_ENDPOINT: '', VIDEO_TTS_API_KEY_ENV: 'WEREWOLF_TTS_API_KEY' });
});

it('enrolls and resumes the same portrait for each model without cross-model bindings or duplicate creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werewolf-voice-design-'));
  const requestsFile = join(directory, 'requests.json');
  await writeFile(requestsFile, '[]');
  const mock = pathToFileURL(resolve('packages/session/test/fixtures/voice-enrollment-fetch.mjs')).href;
  const endpoint = 'https://voice-test.invalid/customization';
  try {
    let voices = catalog('gufeng', plus);
    for (const model of [plus, flash, plus]) {
      voices = selectVoiceCatalogModel(voices, model);
      await writeFile(join(directory, 'voices.json'), JSON.stringify(voices));
      for (let run = 0; run < 2; run++) {
        await promisify(execFile)(process.execPath, ['--import', 'tsx', '--import', mock, resolve('scripts/video/voice-enroll.ts'), '--design', '--seats=1', `--model=${model}`, `--project-dir=${directory}`, `--endpoint=${endpoint}`], { env: { ...process.env, DASHSCOPE_API_KEY: 'synthetic-test-key', WEREWOLF_VOICE_TEST_REQUESTS: requestsFile }, windowsHide: true });
      }
      voices = JSON.parse(await readFile(join(directory, 'voices.json'), 'utf8'));
      expect(voices.profiles['seat-1'].voice).toBe(`${model}-vd-portrait`);
      expect(voices.modelVoiceBindings?.[model]?.['seat-1']).toBe(`${model}-vd-portrait`);
    }
    const requests = JSON.parse(await readFile(requestsFile, 'utf8')) as any[];
    const creations = requests.filter(request => request.input.action === 'create_voice');
    expect(creations).toHaveLength(2);
    expect(creations.map(request => request.input.target_model)).toEqual([plus, flash]);
    expect(creations[0].input.voice_prompt).toContain('清雅书生');
    const manifest = JSON.parse(await readFile(join(directory, 'voice-enrollment.json'), 'utf8'));
    expect(Object.keys(manifest.models).sort()).toEqual([plus, flash].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it('uses the selected voice catalog and preserves its edited delivery when resuming, while force applies the new direction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'werewolf-voice-catalog-'));
  const requestsFile = join(directory, 'requests.json');
  const voicesFile = join(directory, 'selected-voices.json');
  const mock = pathToFileURL(resolve('packages/session/test/fixtures/voice-enrollment-fetch.mjs')).href;
  const command = ['--import', 'tsx', '--import', mock, resolve('scripts/video/voice-enroll.ts'), '--design', '--seats=1', `--project-dir=${directory}`, '--endpoint=https://voice-test.invalid/customization'];
  const env = { ...process.env, VIDEO_VOICES_FILE: voicesFile, DASHSCOPE_API_KEY: 'synthetic-test-key', WEREWOLF_VOICE_TEST_REQUESTS: requestsFile };
  try {
    await writeFile(requestsFile, '[]');
    await writeFile(voicesFile, JSON.stringify(catalog('gufeng', plus)));
    await promisify(execFile)(process.execPath, command, { env, windowsHide: true });
    const voices: VoiceCatalog = JSON.parse(await readFile(voicesFile, 'utf8'));
    const custom = { instruction: '自行调整的表演', rate: 0.91, label: '自定义名称' };
    Object.assign(voices.profiles['seat-1'], custom);
    await writeFile(voicesFile, JSON.stringify(voices));
    const manifestFile = join(directory, 'voice-enrollment.json');
    const pending = JSON.parse(await readFile(manifestFile, 'utf8'));
    pending.voices['seat-1'].status = 'DEPLOYING';
    pending.models[plus]['seat-1'].status = 'DEPLOYING';
    await writeFile(manifestFile, JSON.stringify(pending));
    await promisify(execFile)(process.execPath, command, { env, windowsHide: true });
    const resumed: VoiceCatalog = JSON.parse(await readFile(voicesFile, 'utf8'));
    expect(resumed.profiles['seat-1']).toMatchObject({ ...custom, voice: `${plus}-vd-portrait` });
    expect(JSON.parse(await readFile(manifestFile, 'utf8')).models[plus]['seat-1'].status).toBe('OK');
    expect(JSON.parse(await readFile(requestsFile, 'utf8')).filter((request: any) => request.input.action === 'create_voice')).toHaveLength(1);
    await promisify(execFile)(process.execPath, [...command, '--force'], { env, windowsHide: true });
    const redesigned: VoiceCatalog = JSON.parse(await readFile(voicesFile, 'utf8'));
    const direction = characterVoiceDirection('gufeng', 1);
    expect(redesigned.profiles['seat-1']).toMatchObject({ instruction: direction.instruction, rate: direction.rate, label: `1号 ${direction.persona}` });
    expect(JSON.parse(await readFile(requestsFile, 'utf8')).filter((request: any) => request.input.action === 'create_voice')).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
