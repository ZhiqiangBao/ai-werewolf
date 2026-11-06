import { describe, expect, it } from 'vitest';
import { buildClips, clipVoiceProfile, spokenText, type Script, type VoiceCatalog } from '../../../scripts/video/project';
import { normalizedCaptionText } from '../../../scripts/video/timeline';

describe('English video speech and clip voices', () => {
  it('reads arrows and numeric ranges while keeping original clip text', () => {
    expect(spokenText('4->1, 4→1, 3–8', 'en')).toBe('4 to 1, 4 to 1, 3 to 8');
    expect(spokenText('4->1', 'ja')).toBe('4->1');
    const text = 'Vote 4->1';
    const script = { locale: 'en', chapters: [{ day: 1, phase: 'day', title: 'Day', entries: [{ sourceSeq: 1, type: 'speech', speaker: 'A', voiceKey: 'seat-1', text, visibility: 'public', data: {} }] }] } as Script;
    const [clip] = buildClips(script);
    expect(clip.text).toBe(text);
    expect(clip.spokenText).toBe('Vote 4 to 1');
  });
  it('treats day/night hyphens as separators but retains mathematical minus', () => {
    for (const label of ['Day-1', 'night-1', 'Day-1/Night-2']) {
      expect(normalizedCaptionText(label, 'en')).toBe(normalizedCaptionText(label.replaceAll('-', ' '), 'en'));
    }
    expect(normalizedCaptionText('-1', 'en')).toBe(normalizedCaptionText('minus one', 'en'));
    expect(normalizedCaptionText('1-2', 'en')).toBe(normalizedCaptionText('one minus two', 'en'));
    expect(normalizedCaptionText('holiday-1', 'en')).toContain('minusone');
  });
  it('uses per-clip instructions with cue rate, seed, locale and hints', () => {
    const voices: VoiceCatalog = { model: 'test', profiles: { judge: { voice: 'Cherry', label: 'judge', instruction: 'default', rate: 1, locale: 'en', languageHints: ['en-US'] } }, judgeCues: { open: { instruction: 'cue', rate: 1.2 } }, clipSeeds: { a: 42 }, clipInstructions: { a: 'read exactly' } };
    const clip = { id: 'a', voiceKey: 'judge', data: { presentationOnly: true, presentationKey: 'open' } };
    expect(clipVoiceProfile(voices, clip, 'en')).toMatchObject({ instruction: 'read exactly', rate: 1.2, seed: 42, locale: 'en', languageHints: ['en-US'] });
    expect(clipVoiceProfile(voices, { ...clip, id: 'b' }, 'en').instruction).toBe('cue');
    expect(() => clipVoiceProfile({ ...voices, clipInstructions: { a: '  ' } }, clip, 'en')).toThrow(/Invalid clip instruction/);
    expect(clipVoiceProfile(voices, { voiceKey: 'judge', data: {} })).toBe(voices.profiles.judge);
  });
  it('does not migrate an explicitly supplied clip instruction matching a legacy default', () => {
    const legacy = '请用标准普通话，以狼人杀法官的口吻清晰播报，冷静、公正、简洁，有自然停顿，不要夸张表演。';
    const voices: VoiceCatalog = { model: 'test', profiles: { judge: { voice: 'Cherry', label: 'judge', instruction: legacy, rate: 1 } }, clipInstructions: { a: legacy } };
    expect(clipVoiceProfile(voices, { id: 'a', voiceKey: 'judge', data: {} }, 'en').instruction).toBe(legacy);
    expect(clipVoiceProfile(voices, { id: 'b', voiceKey: 'judge', data: {} }, 'en').instruction).toMatch(/^Speak naturally/);
  });
});
