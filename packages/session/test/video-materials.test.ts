import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materialIssues, inspectMaterials } from '../../../scripts/video/materials';
import { draftNarration } from '../../../scripts/video/narration';
import type { Script, VoiceCatalog } from '../../../scripts/video/project';

const source: Script = { roomId: 'fixture', perspective: 'god', presetName: 'fixture', status: 'ended', cast: [], result: null, events: [],
  chapters: [{ day: 1, phase: 'day', title: '第1天', entries: [
    { sourceSeq: 1, type: 'game.start', speaker: '法官', voiceKey: 'judge', text: '开始。', visibility: 'public', data: {} },
    { sourceSeq: 2, type: 'speech', speaker: '1号', seat: 1, voiceKey: 'seat-1', text: '玩家原话。', visibility: 'public', data: {} },
  ] }] };
const profile = { voice: 'fixture', label: 'fixture', rate: 1, instruction: '自然' };
const voices: VoiceCatalog = { model: 'fixture', profiles: { judge: profile, commentator: profile, 'seat-1': profile } };
const reviewed = () => ({ roomId: 'fixture', edits: { '1': { text: '这桌对局开始了。', voiceKey: 'commentator', reason: '仅交代开场' } }, review: {
  status: 'reviewed', method: 'human-editor', factsChecked: true, playerQuotesUntouched: true, futureResultsNotUsedInProcessCommentary: true } });
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) {
    for (const file of await readdir(dir)) await unlink(join(dir, file));
    await rmdir(dir);
  }
});

describe('video production materials', () => {
  it('stops an untouched automatic draft before external synthesis', () => {
    expect(materialIssues(source, draftNarration(source), voices)).toContainEqual(expect.stringContaining('旁白尚未完成审核'));
  });
  it('accepts completed reviews from a human or an agent', () => {
    expect(materialIssues(source, reviewed(), voices)).toEqual([]);
    const narration = reviewed(); narration.review.method = 'model-editor';
    expect(materialIssues(source, narration, voices)).toEqual([]);
    narration.review.factsChecked = false;
    expect(materialIssues(source, narration, voices)).not.toEqual([]);
  });
  it('rejects another room, missing anchors, edited player quotes and malformed comments', () => {
    expect(materialIssues(source, { ...reviewed(), roomId: 'another-room' }, voices)).toContain('解说稿 roomId 与本局不一致');
    for (const edits of [
      { '999': { reason: '无此事件' } },
      { '2': { reason: '玩家原话', after: [{ text: '点评。', reason: '不能插在玩家分段间' }] } },
      { '1': { reason: '格式错误', after: [{ text: '', reason: '' }] } },
    ]) expect(materialIssues(source, { ...reviewed(), edits }, voices).length).toBeGreaterThan(0);
  });
  it('requires both host voices and usable model-specific profiles', () => {
    expect(materialIssues(source, reviewed(), { ...voices, profiles: { judge: profile } })).toContainEqual(expect.stringContaining('commentator'));
    expect(materialIssues(source, reviewed(), { ...voices, profiles: { ...voices.profiles, judge: { ...profile, rate: 0 } } })).toContainEqual(expect.stringContaining('音色 judge'));
  });
  it('rejects JSON null instead of treating a parsed file as ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-materials-')); temporary.push(dir);
    const narration = join(dir, 'narration.json'), voiceFile = join(dir, 'voices.json');
    vi.stubEnv('VIDEO_NARRATION_FILE', narration); vi.stubEnv('VIDEO_VOICES_FILE', voiceFile);
    await writeFile(narration, 'null'); await writeFile(voiceFile, JSON.stringify(voices));
    expect((await inspectMaterials(source)).ready).toBe(false);
    await writeFile(narration, JSON.stringify(reviewed())); await writeFile(voiceFile, 'null');
    expect((await inspectMaterials(source)).ready).toBe(false);
  });
  it('plans actual edited clips and preserves original player text without calling a service', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-materials-')); temporary.push(dir);
    const narration = join(dir, 'custom-narration.json'), voiceFile = join(dir, 'custom-voices.json');
    vi.stubEnv('VIDEO_NARRATION_FILE', narration); vi.stubEnv('VIDEO_VOICES_FILE', voiceFile);
    await writeFile(narration, JSON.stringify(reviewed())); await writeFile(voiceFile, JSON.stringify(voices));
    const result = await inspectMaterials(source);
    expect(result).toMatchObject({ ready: true, externalServicesCalled: false, clips: 2, narrationFile: narration, voiceFile });
    await writeFile(narration, JSON.stringify({ ...reviewed(), edits: { '2': { text: '篡改玩家原话。', reason: '非法编辑' } } }));
    expect((await inspectMaterials(source)).ready).toBe(false);
  });
});
