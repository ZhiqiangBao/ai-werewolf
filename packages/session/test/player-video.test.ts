import { describe, expect, it } from 'vitest';
import { DEAL12, TestGame } from '../../engine/test/harness';
import type { GameEvent } from '@werewolf/protocol';
import type { RoomRecord } from '../src/store';
import { buildPlayerVideo } from '../src/player-video';
import { draftNarration } from '../../../scripts/video/narration';
import { buildClips } from '../../../scripts/video/project';
import { assertPlayerSources } from '../../../scripts/video/integrity';
import { speakerIdentity } from '../../../scripts/video/speaker';
import { replay } from '../../../scripts/video/replay';
import { actionTargetLabel, clipSkillEffect, writeSkillFrames } from '../../../scripts/video/video-effect';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

describe('玩家视角视频权限', () => {
  it('工作流在访问房间或调用配音前拒绝无效 ASR 配置', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/video/workflow.ts', '--room=missing', '--asr-provider=unknown'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unsupported ASR provider');
    expect(result.stdout).not.toContain('VIDEO_STAGE');
  });
  it('玩家视角不支持自动修复时在启动前拒绝，不改项目也不调用配音', async () => {
    const root = process.cwd(), base = resolve(root, 'data', 'player-repair-guard-tests');
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, 'case-')), project = join(directory, 'project');
    await mkdir(project); await writeFile(join(project, 'existing.txt'), '保留原有内容');
    const marker = join(directory, 'tts-called.txt'), adapter = join(directory, 'adapter.mjs');
    await writeFile(adapter, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called'); export async function synthesize() { throw Error('unexpected'); }`);
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/video/workflow.ts', '--room=missing', '--player-seat=5', '--repair-audio', '--resume', `--data-dir=${directory}`, `--project-dir=${project}`, '--tts-provider=guard-test', `--tts-adapter=${adapter}`], { cwd: root, encoding: 'utf8', windowsHide: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Player view does not support --repair-audio');
    expect(result.stdout).not.toContain('VIDEO_STAGE');
    expect(await readdir(project)).toEqual(['existing.txt']);
    expect(await readFile(join(project, 'existing.txt'), 'utf8')).toBe('保留原有内容');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(directory, 'exports'))).toBe(false);
  });
  it('只包含本人受众、公开事实和本人身份；终局不导入全知复盘', () => {
    const game = new TestGame({ deal: DEAL12, values: { 'sheriff.enabled': false } });
    game.night({ kill: null, inspect: 1 });
    const state = structuredClone(game.state);
    state.result = { winner: 'good', winnerName: '好人', reason: '结束' };
    const event = (seq: number, type: string, text: string, audience: GameEvent['audience'], payload: Record<string, unknown> = {}): GameEvent => ({ seq, type, text, audience, payload, day: 1, phase: 'end' });
    const secret = 'SECRET_OTHER_SEAT', review = 'SECRET_OMNISCIENT_REVIEW';
    const events = [...game.events, event(900, 'speech', '公开发言', 'public', { seat: 2, content: '公开发言' }), event(901, 'witch.poison', secret, [10], { target: 1 }), event(902, 'review', review, 'public', { roles: state.players }), event(903, 'game.end', '结束', 'public', { result: state.result }), event(904, 'guard.protect', '历史共享守护记录', [5, 10], { target: 1 })];
    const record = { state, events, status: 'ended', paused: false, seats: state.players.map((p) => ({ seat: p.seat, name: p.name, controller: 'ai' })) } as unknown as RoomRecord;
    const script = buildPlayerVideo(record, state.id, 5);
    const serialized = JSON.stringify(script);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(review);
    expect(script.ruleCard).toBeUndefined();
    expect(script.cast.filter((c) => c.role !== 'unknown').map((c) => c.seat)).toEqual([5]);
    expect(script.events.every((e) => e.audience === 'public' || JSON.stringify(e.audience) === '[5]')).toBe(true);
    expect(script.chapters.flatMap((c) => c.entries).some((e) => e.text === '公开发言')).toBe(true);
    expect(script.chapters.flatMap((c) => c.entries).find((e) => e.type === 'guard.protect')?.text).toBe('历史共享守护记录');
    expect(Object.keys(draftNarration(script).edits)).toHaveLength(0);
    const clips = buildClips(script);
    expect(() => assertPlayerSources(script, script, clips)).not.toThrow();
    expect(speakerIdentity(script, { seat: 2, voiceKey: 'seat-2', type: 'speech', data: {} }).title).not.toContain(state.players[1].role);
    expect(() => buildPlayerVideo(record, state.id, 99)).toThrow();
  });
  it('样片源稿不能替换身份或插入未授权片段，夜间死亡不显示未知死因', () => {
    const game = new TestGame({ deal: DEAL12 });
    const state = structuredClone(game.state);
    state.result = { winner: 'good', winnerName: '好人', reason: '结束' };
    const events: GameEvent[] = [
      { seq: 1, type: 'dawn', text: '昨夜5号出局', audience: 'public', payload: { deaths: [5] }, day: 1, phase: 'day' },
      { seq: 2, type: 'night.resolution', text: '毒杀', audience: [], payload: { deaths: [{ seat: 5, causes: ['poison', 'wolf'] }] }, day: 1, phase: 'night' },
      { seq: 3, type: 'game.end', text: '结束', audience: 'public', payload: { result: state.result }, day: 1, phase: 'end' },
    ];
    const record = { state, events, status: 'ended', paused: false, seats: state.players.map((p) => ({ seat: p.seat, name: p.name, controller: 'ai' })) } as unknown as RoomRecord;
    const script = buildPlayerVideo(record, state.id, 5);
    expect(replay(script, 999).deaths.get(5)).toEqual(['night']);
    expect(JSON.stringify(script)).not.toMatch(/poison|毒杀/);
    const clips = buildClips(script);
    expect(() => assertPlayerSources(script, { ...script, sample: true }, clips.slice(0, 1))).not.toThrow();
    expect(() => assertPlayerSources(script, { ...script, sample: true }, [{ ...clips[0], text: '伪造的秘密' }])).toThrow();
    const altered = structuredClone(script); altered.cast[0].role = 'werewolf';
    expect(() => assertPlayerSources(script, altered, clips)).toThrow();
    expect(actionTargetLabel('hunter.shot')).toBe('开枪目标');
    expect(actionTargetLabel('wolf.kill.result')).toBe('狼刀目标');
    expect(actionTargetLabel('mirror.result')).toBe('查验目标');
    expect(actionTargetLabel('awakened.knife')).toBe('狼刀目标');
    expect(actionTargetLabel('unrelated.target')).toBeUndefined();
  });
  it('已出局玩家没有后续模型上下文时仍保留之后公开事实直到终局', () => {
    const game = new TestGame({ deal: DEAL12 });
    const state = structuredClone(game.state), dead = state.players.find((p) => p.role === 'villager')!.seat;
    const other = state.players.find((p) => p.role === 'villager' && p.seat !== dead)!.seat;
    const seer = state.players.find((p) => p.role === 'seer')!.seat;
    state.players.find((p) => p.seat === dead)!.alive = false;
    state.result = { winner: 'good', winnerName: '好人', reason: '对局结束' };
    const event = (seq: number, type: string, text: string, audience: GameEvent['audience'], payload: Record<string, unknown>, day: number, phase: GameEvent['phase']): GameEvent => ({ seq, type, text, audience, payload, day, phase });
    const speech = '后续公开发言，继续讨论票型。';
    const events = [
      event(1, 'dawn', `${dead}号昨夜出局。`, 'public', { deaths: [dead] }, 2, 'day'),
      event(2, 'speech', speech, 'public', { seat: other, content: speech }, 2, 'day'),
      event(3, 'vote.result', '放逐投票结果。', 'public', { kind: 'exile', rows: [{ target: 1, weight: 2, voters: [other] }], outcome: 'exile', seat: 1 }, 2, 'day'),
      event(4, 'seer.result', 'OTHER_SEAT_PRIVATE_CHECK', [seer], { target: 2, result: 'wolf' }, 3, 'night'),
      event(5, 'game.end', '好人获胜。', 'public', { result: state.result }, 3, 'end'),
      event(6, 'review', 'OMNISCIENT_REVIEW', 'public', { roles: state.players }, 3, 'end'),
    ];
    const record = { state, events, status: 'ended', paused: false, seats: state.players.map((p) => ({ seat: p.seat, name: p.name, controller: 'ai' })) } as unknown as RoomRecord;
    expect(record.state!.players.find((p) => p.seat === dead)?.alive).toBe(false);
    expect(record.threads).toBeUndefined(); expect(record.thoughts).toBeUndefined();
    const script = buildPlayerVideo(record, state.id, dead), entries = script.chapters.flatMap((chapter) => chapter.entries);
    expect(script.events.map((e) => e.type)).toEqual(['dawn', 'speech', 'vote.result', 'game.end']);
    expect(entries.find((e) => e.type === 'speech')).toMatchObject({ seat: other, text: speech });
    expect(entries.some((e) => e.type === 'vote.result')).toBe(true);
    expect(entries.at(-1)).toMatchObject({ type: 'game.end', text: '好人获胜。' });
    expect(entries.some((e) => e.seat === dead)).toBe(false);
    expect(JSON.stringify(script)).not.toMatch(/OTHER_SEAT_PRIVATE_CHECK|OMNISCIENT_REVIEW|thinking|thought/);
  });
  it('合成局贯通导出、材料、字幕、音频元数据及逐帧动画，缓存篡改会被拒绝', async () => {
    const root = process.cwd();
    const base = resolve(root, 'data', 'player-video-tests'); await mkdir(base, { recursive: true });
    const data = await mkdtemp(join(base, 'case-'));
    const game = new TestGame({ deal: DEAL12 });
    const state = structuredClone(game.state); state.result = { winner: 'good', winnerName: '好人', reason: '游戏结束' };
    const own = state.players.find((p) => p.role === 'seer')!.seat;
    const ev = (seq: number, type: string, text: string, audience: GameEvent['audience'], payload: Record<string, unknown>, phase: GameEvent['phase'] = 'night'): GameEvent => ({ seq, type, text, audience, payload, day: 1, phase });
    const events = [ev(1, 'game.start', '对局开始。', 'public', {}), ev(2, 'seer.result', '查验结果。', [own], { target: 1, result: 'wolf' }), ev(3, 'witch.poison', 'PRIVATE_POISON_SECRET', [99], { target: own }), ev(4, 'review', 'OMNISCIENT_REVIEW_SECRET', 'public', { roles: state.players }), ev(5, 'game.end', '对局结束。', 'public', { result: state.result }, 'end')];
    const record = { state, events, status: 'ended', paused: false, seats: state.players.map((p) => ({ seat: p.seat, name: p.name, controller: 'ai' })) };
    await mkdir(join(data, 'rooms'), { recursive: true });
    await writeFile(join(data, 'rooms', 'synthetic.json'), JSON.stringify(record));
    const run = (file: string, args: string[], env: NodeJS.ProcessEnv) => execFileSync(process.execPath, ['--import', 'tsx', file, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe', timeout: 120000 });
    run('scripts/video/workflow.ts', ['--room=synthetic', `--player-seat=${own}`, `--data-dir=${data}`, '--prepare-only', '--encoder=cpu'], {});
    expect(existsSync(join(data, 'local-asr', 'service-state.json'))).toBe(false);
    const dir = join(data, 'video', `synthetic-player-${own}`);
    const env = { VIDEO_DATA_DIR: data, VIDEO_ROOM: 'synthetic', VIDEO_PLAYER_SEAT: String(own), VIDEO_PROJECT_DIR: dir, VIDEO_ENCODER: 'libx264' };
    const narration = JSON.parse(await readFile(join(dir, 'narration.json'), 'utf8'));
    narration.review = { status: 'reviewed', method: '合成测试核对', factsChecked: true, playerQuotesUntouched: true, futureResultsNotUsedInProcessCommentary: true };
    await writeFile(join(dir, 'narration.json'), JSON.stringify(narration));
    run('scripts/video/workflow.ts', ['--room=synthetic', `--player-seat=${own}`, `--data-dir=${data}`, '--encoder=cpu', '--resume', '--asr-provider=off', '--tts-provider=synthetic-test', `--tts-adapter=${resolve(root, 'packages/session/test/fixtures/synthetic-video-tts.ts')}`], {});
    const workflowStatus = JSON.parse(await readFile(join(dir, 'workflow-status.json'), 'utf8'));
    expect(workflowStatus).toMatchObject({ status: 'complete', asr: { requestedProvider: 'off', audioSemanticReview: 'not-checked-explicitly-disabled' } });
    expect(workflowStatus.completed).toContain('review-audio');
    const clips = JSON.parse(await readFile(join(dir, 'clips.json'), 'utf8'));
    const timeline = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8'));
    const source = JSON.parse(await readFile(join(dir, 'source.json'), 'utf8'));
    const target = timeline.clips.find((c: any) => c.type === 'seer.result');
    const effect = clipSkillEffect(source, target)!;
    expect(effect.kind).toBe('inspect');
    expect(clipSkillEffect(source, { ...target, data: { ...target.data, replayThrough: target.sourceSeq - 1 } })).toBeNull();
    const invisible = structuredClone(source); invisible.events.find((e: any) => e.type === 'seer.result').audience = [99];
    expect(clipSkillEffect(invisible, target)).toBeNull();
    await writeSkillFrames(join(dir, 'test-effect'), effect, 54);
    expect(await readFile(join(dir, 'test-effect', '010.png'))).not.toEqual(await readFile(join(dir, 'test-effect', '035.png')));
    const frame = (time: string) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', time, '-i', join(dir, 'segments', `${target.id}.mp4`), '-vf', `crop=150:150:${effect.x}:${effect.y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1000000 });
    expect(frame('0.2')).not.toEqual(frame('0.9'));
    for (const name of ['source.json', 'script.json', 'plan.json', 'editorial-context.json', 'clips.json', 'timeline.json', 'output/verification.json', 'subtitles/captions.ass', 'subtitles/captions.srt', ...clips.map((c: any) => `audio/${c.id}.wav.json`)]) {
      const content = await readFile(join(dir, name), 'utf8');
      expect(content).not.toMatch(/PRIVATE_POISON_SECRET|OMNISCIENT_REVIEW_SECRET/);
    }
    const selection = join(data, 'selection.json'), sampleDir = join(data, 'video', 'safe-sample');
    await writeFile(selection, JSON.stringify({ description: '单项合成样片', sections: [{ title: '查验', sourceSeqs: [target.sourceSeq] }] }));
    const sampleEnv = { ...env, VIDEO_PROJECT_DIR: sampleDir, VIDEO_TTS_PROVIDER: 'synthetic-test', VIDEO_TTS_ADAPTER: resolve(root, 'packages/session/test/fixtures/synthetic-video-tts.ts') };
    run('scripts/video/sample.ts', [`--selection=${selection}`], sampleEnv);
    expect(() => run('scripts/video/sample.ts', [`--selection=${selection}`], sampleEnv)).toThrow();
    expect(JSON.parse(await readFile(join(sampleDir, 'sample-selection.json'), 'utf8')).reusedAudio).toBe(0);
    run('scripts/video/synthesize.ts', ['--prepared-clips'], sampleEnv);
    run('scripts/video/timeline.ts', [], sampleEnv);
    run('scripts/video/render.ts', [], sampleEnv);
    run('scripts/video/verify-sample.ts', [`--video=${join(sampleDir, 'output', 'latest-match.mp4')}`], sampleEnv);
    for (const name of ['source.json', 'script.json', 'clips.json', 'timeline.json', 'sample-selection.json', 'subtitles/captions.srt', 'output/sample-verification.json']) {
      expect(await readFile(join(sampleDir, name), 'utf8')).not.toMatch(/PRIVATE_POISON_SECRET|OMNISCIENT_REVIEW_SECRET/);
    }
    const rejects = (file: string, args: string[], selectedEnv: NodeJS.ProcessEnv, reason: RegExp) => {
      try { run(file, args, selectedEnv); } catch (error) {
        expect((error as { stderr: Buffer }).stderr.toString()).toMatch(reason);
        return;
      }
      throw Error(`Expected ${file} to reject the modified artifact`);
    };
    // Preserve valid metadata and size while swapping raw PCM; neither cache reuse nor timeline creation may accept it.
    const sampleClips = JSON.parse(await readFile(join(sampleDir, 'clips.json'), 'utf8'));
    const rawFile = sampleClips[0].audioFile, rawAudio = await readFile(rawFile), alteredRaw = Buffer.from(rawAudio);
    alteredRaw[44 + 10] ^= 1;
    await writeFile(rawFile, alteredRaw);
    rejects('scripts/video/timeline.ts', [], sampleEnv, /Player raw audio digest mismatch/);
    rejects('scripts/video/synthesize.ts', ['--prepared-clips'], sampleEnv, /Player raw audio digest mismatch/);
    rejects('scripts/video/verify-sample.ts', [`--video=${join(sampleDir, 'output', 'latest-match.mp4')}`], sampleEnv, /Player raw audio digest mismatch/);
    await writeFile(rawFile, rawAudio);
    const voicesFile = join(sampleDir, 'voices.json'), originalVoices = await readFile(voicesFile, 'utf8');
    const changedVoices = JSON.parse(originalVoices); changedVoices.profiles[sampleClips[0].voiceKey].rate += .1;
    await writeFile(voicesFile, JSON.stringify(changedVoices));
    rejects('scripts/video/timeline.ts', [], sampleEnv, /Player audio request changed/);
    await writeFile(voicesFile, originalVoices);
    // Same length and even a matching forged report hash cannot substitute the PCM actually authorized by the clips.
    const masterFile = join(dir, 'master.wav'), originalMaster = await readFile(masterFile);
    const alteredMaster = Buffer.from(originalMaster); alteredMaster[44 + 10] ^= 1;
    const reportFile = join(dir, 'output', 'render-report.json'), originalReport = await readFile(reportFile, 'utf8');
    const forgedReport = JSON.parse(originalReport); forgedReport.masterSha256 = createHash('sha256').update(alteredMaster).digest('hex');
    await writeFile(masterFile, alteredMaster); await writeFile(reportFile, JSON.stringify(forgedReport));
    rejects('scripts/video/render.ts', [], env, /master audio differs from authorized clip/);
    rejects('scripts/video/verify.ts', [], env, /master audio differs from authorized clip/);
    rejects('scripts/video/preview.ts', [], env, /master audio differs from authorized clip/);
    await writeFile(masterFile, originalMaster); await writeFile(reportFile, originalReport);
    const video = join(dir, 'output', 'latest-match.mp4'), originalVideo = await readFile(video);
    const replacedVideo = Buffer.from(originalVideo); replacedVideo[Math.floor(replacedVideo.length / 2)] ^= 1;
    await writeFile(video, replacedVideo);
    rejects('scripts/video/verify.ts', [], env, /Final video differs from render report/);
    rejects('scripts/video/preview.ts', [], env, /Final video differs from render report/);
    await writeFile(video, originalVideo);
    const sampleVideo = join(sampleDir, 'output', 'latest-match.mp4'), originalSampleVideo = await readFile(sampleVideo);
    const replacedSampleVideo = Buffer.from(originalSampleVideo); replacedSampleVideo[Math.floor(replacedSampleVideo.length / 2)] ^= 1;
    await writeFile(sampleVideo, replacedSampleVideo);
    rejects('scripts/video/verify-sample.ts', [`--video=${sampleVideo}`], sampleEnv, /Final video differs from render report/);
    await writeFile(sampleVideo, originalSampleVideo);
    await writeFile(join(dir, 'subtitles', `${target.id}.ass`), 'OMNISCIENT_REVIEW_SECRET');
    expect(() => run('scripts/video/render.ts', ['--only=' + target.id], env)).toThrow();
    expect(() => run('scripts/video/preview.ts', [], env)).toThrow();
    const exportFile = join(data, 'exports', `synthetic-player-${own}-video-script.json`);
    const forged = JSON.parse(await readFile(exportFile, 'utf8')); forged.cast[0].role = 'werewolf';
    await writeFile(exportFile, JSON.stringify(forged));
    expect(() => run('scripts/video/preview.ts', [], env)).toThrow();
  }, 180000);
});
