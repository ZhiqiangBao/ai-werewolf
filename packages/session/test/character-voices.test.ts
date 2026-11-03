import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCharacterVoices, characterVoices } from '../../../scripts/video/character-voices';
import { clipVoiceProfile, type Cast, type VoiceCatalog } from '../../../scripts/video/project';

// 从 Qwen 音色目录中核对过的 voice 参数及性别；不是试听结果。
const catalogGender: Record<string, string> = {
  longyanfengying: '男', longlingxingxia: '女', longxinruixuan: '男', longlingjinquan: '女',
  longwangjixi: '男', longlanlingying: '女', longlanyufu: '男', longshuangxuandie: '女',
  longfenglanlu: '男', longluanlanju: '女', longlinhongxi: '男', longlanqinluan: '女',
  longlingzhixing: '男', longlangmoyue: '男', longyiqinghui: '女', longjinmeicheng: '男',
};
const cast: Cast[] = Array.from({ length: 12 }, (_, i) => ({ seat: i + 1, name: `玩家${i + 1}`, role: '', roleName: '', factionName: '', voiceKey: `seat-${i + 1}` }));
const profile = { voice: 'custom', label: 'custom', rate: 1, instruction: 'custom' };
const voices: VoiceCatalog = { model: 'qwen-audio-3.0-tts-plus', profiles: { judge: profile, commentator: profile, ...Object.fromEntries(cast.map(c => [c.voiceKey, profile])) } };

describe('avatar character voice matching', () => {
  it('matches all 72 portraits to catalog genders, including the changed middle seats', () => {
    for (const [theme, characters] of Object.entries(characterVoices)) {
      expect(characters).toHaveLength(12);
      expect(new Set(characters.map(c => c.voice)).size).toBe(12);
      expect(characters.map(c => c.gender).join('')).toBe(theme === 'campus' || theme === 'gufeng' ? '男女男女男女男女男女男女' : '男女男女男女女男女男男女');
      for (const character of characters) expect(catalogGender[character.voice]).toBe(character.gender);
      const mapped = applyCharacterVoices(voices, cast, theme);
      for (const c of cast) {
        const p = mapped.profiles[c.voiceKey];
        expect(p).toMatchObject({ voice: `qwen-audio-3.0-tts-plus-${characters[c.seat - 1].voice}`, rate: 1.04, instruction: '' });
        expect(clipVoiceProfile(mapped, { voiceKey: c.voiceKey, data: {} }, 'ja')).toMatchObject({ voice: p.voice, rate: p.rate, instruction: '', languageHints: ['ja'] });
      }
      expect(mapped.profiles.judge).toEqual(profile);
      expect(mapped.profiles.commentator).toEqual(profile);
    }
    expect(voices.profiles['seat-7']).toEqual(profile);
    expect(() => applyCharacterVoices(voices, cast, 'unknown')).toThrow('Unsupported avatar theme');
  });

  it('writes themed defaults once and preserves the existing voice file on a theme change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'character-voices-'));
    try {
      const data = join(dir, 'data'), project = join(dir, 'project');
      await mkdir(join(data, 'exports'), { recursive: true });
      await mkdir(join(data, 'rooms'), { recursive: true });
      const source = { roomId: 'fixture', perspective: 'god', presetName: 'fixture', status: 'ended', cast, events: [], chapters: [], result: null };
      await writeFile(join(data, 'exports', 'fixture-video-script.json'), JSON.stringify(source));
      await writeFile(join(data, 'rooms', 'fixture.json'), JSON.stringify({ seats: [] }));
      const run = (theme: string) => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/video/prepare.ts'], { cwd: process.cwd(), stdio: 'pipe', env: { ...process.env, VIDEO_ROOM: 'fixture', VIDEO_DATA_DIR: data, VIDEO_PROJECT_DIR: project, VIDEO_AVATAR_STYLE: theme, VIDEO_VOICES_FILE: join(project, 'voices.json'), VIDEO_NARRATION_FILE: join(project, 'narration.json') } });
      run('storybook');
      const file = join(project, 'voices.json');
      const first = JSON.parse(await readFile(file, 'utf8')) as VoiceCatalog;
      expect(first.profiles['seat-7'].voice).toContain('longluanlanju');
      first.profiles['seat-7'].label = '用户自定义';
      await writeFile(file, JSON.stringify(first));
      const original = await readFile(file, 'utf8');
      run('campus');
      expect(await readFile(file, 'utf8')).toBe(original);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
