import { describe, expect, it } from 'vitest';
import { DEAL12, TestGame } from '../../engine/test/harness';
import type { GameEvent } from '@werewolf/protocol';
import { clipSkillEffect, writeSkillFrames } from '../../../scripts/video/video-effect';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

describe('玩家视角视频权限', () => {
  it('合成局贯通导出、材料、字幕、音频元数据及逐帧动画，缓存篡改会被拒绝', async () => {
    const root = process.cwd();
    const base = resolve(root, 'data', 'player-video-tests'); await mkdir(base, { recursive: true });
    const data = await mkdtemp(join(base, 'case-'));
    try {
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
    run('scripts/video/workflow.ts', ['--room=synthetic', `--player-seat=${own}`, `--data-dir=${data}`, '--encoder=cpu', '--resume', '--tts-provider=synthetic-test', `--tts-adapter=${resolve(root, 'packages/session/test/fixtures/synthetic-video-tts.ts')}`], {});
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
    } finally {
      const target = await realpath(data), expectedBase = await realpath(base);
      if (dirname(target) !== expectedBase) throw new Error('测试目录不在预期位置');
      await rm(target, { recursive: true, force: true });
    }
  }, 180000);
});
