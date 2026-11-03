import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GameEvent } from '@werewolf/protocol';
import { DEAL12, TestGame } from '../../engine/test/harness';
import { buildPlayerVideo } from '../src/player-video';
import type { RoomRecord } from '../src/store';
import { spokenText } from '../../../scripts/video/project';
import { captionContent } from '../../../scripts/video/timeline';
import { syntheticTone } from './fixtures/synthetic-video-tts';

/** Strength at one frequency, independent of AAC phase and gain. */
function tonePower(pcm: Buffer, start: number, length: number, frequency: number) {
  let real = 0, imaginary = 0;
  for (let i = 0; i < length; i++) {
    const sample = pcm.readInt16LE((start + i) * 2), phase = 2 * Math.PI * frequency * i / 24000;
    real += sample * Math.cos(phase); imaginary += sample * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / length;
}

describe('玩家视频三种身份的权限与成片音频', () => {
  it('普通好人、狼人、预言家只导出和播放各自授权的事实', async () => {
    const root = process.cwd(), base = resolve(root, 'data', 'player-video-matrix');
    await mkdir(base, { recursive: true });
    const data = await mkdtemp(join(base, 'case-'));
    const game = new TestGame({ deal: DEAL12 });
    const state = structuredClone(game.state), wolves = state.players.filter((p) => p.role === 'werewolf').map((p) => p.seat);
    const seer = state.players.find((p) => p.role === 'seer')!.seat;
    const villager = state.players.find((p) => p.role === 'villager')!.seat;
    const witch = state.players.find((p) => p.role === 'witch')!.seat;
    state.result = { winner: 'draw', winnerName: '无人', reason: '合成对局结束' };
    const event = (seq: number, type: string, text: string, audience: GameEvent['audience'], payload: Record<string, unknown>, phase: GameEvent['phase'] = 'night'): GameEvent => ({ seq, type, text, audience, payload, day: 1, phase });
    const publicSpeech = '公开发言：我们核对票型。', wolfSecret = '狼队密谈：今晚讨论目标。';
    const events = [
      event(1, 'game.start', '游戏开始。', 'public', {}),
      event(2, 'wolf.chat', wolfSecret, wolves, { seat: wolves[0], content: wolfSecret }),
      event(3, 'seer.result', '预言家本人查验记录。', [seer], { target: wolves[0], result: 'wolf' }),
      event(4, 'witch.poison', '其他座位私密记录。', [witch], { target: villager, token: 'OTHER_PRIVATE_SENTINEL' }),
      event(5, 'speech', publicSpeech, 'public', { seat: villager, content: publicSpeech }, 'day'),
      event(6, 'game.end', '对局结束。', 'public', { result: state.result }, 'end'),
      event(7, 'review', '全知复盘', 'public', { roles: state.players, token: 'REVIEW_PRIVATE_SENTINEL' }, 'end'),
    ];
    const record = { state, events, status: 'ended', paused: false, seats: state.players.map((p) => ({ seat: p.seat, name: p.name, controller: 'ai' })) } as unknown as RoomRecord;
    const seats = [{ role: 'villager', seat: villager }, { role: 'werewolf', seat: wolves[0] }, { role: 'seer', seat: seer }];
    const scripts = new Map(seats.map(({ seat }) => [seat, buildPlayerVideo(record, 'matrix', seat)]));
    const seerText = scripts.get(seer)!.chapters.flatMap((c) => c.entries).find((e) => e.type === 'seer.result')!.text;
    for (const { role, seat } of seats) {
      const script = scripts.get(seat)!;
      expect(state.players.find((p) => p.seat === seat)?.role).toBe(role);
      expect(script.cast.filter((c) => c.role !== 'unknown').map((c) => [c.seat, c.role])).toEqual([[seat, role]]);
      const types = script.events.map((e) => e.type);
      expect(types).toContain('speech');
      expect(types.includes('wolf.chat')).toBe(role === 'werewolf');
      expect(types.includes('seer.result')).toBe(role === 'seer');
      expect(types).not.toContain('witch.poison');
      expect(types).not.toContain('review');
    }
    await mkdir(join(data, 'rooms'), { recursive: true });
    await writeFile(join(data, 'rooms', 'matrix.json'), JSON.stringify(record));
    const run = (file: string, args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', file, ...args], { cwd: root, env: process.env, stdio: 'pipe', timeout: 120000 });
    const generated: { role: string; seat: number; dir: string; clips: any[]; timeline: any; pcm: Buffer }[] = [];
    for (const { role, seat } of seats) {
      const args = ['--room=matrix', `--player-seat=${seat}`, `--data-dir=${data}`, '--encoder=cpu'];
      run('scripts/video/workflow.ts', [...args, '--prepare-only']);
      const dir = join(data, 'video', `matrix-player-${seat}`);
      const narration = JSON.parse(await readFile(join(dir, 'narration.json'), 'utf8'));
      narration.review = { status: 'reviewed', method: '合成座位权限核对', factsChecked: true, playerQuotesUntouched: true, futureResultsNotUsedInProcessCommentary: true };
      await writeFile(join(dir, 'narration.json'), JSON.stringify(narration));
      run('scripts/video/workflow.ts', [...args, '--through=render', '--tts-provider=synthetic-test', `--tts-adapter=${resolve(root, 'packages/session/test/fixtures/synthetic-video-tts.ts')}`]);
      const clips = JSON.parse(await readFile(join(dir, 'clips.json'), 'utf8'));
      const timeline = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8'));
      expect(clips.find((clip: any) => clip.type === 'speech')?.text).toBe(publicSpeech);
      const subtitle = await readFile(join(dir, 'subtitles/captions.srt'), 'utf8');
      expect(captionContent(subtitle)).toContain(captionContent(spokenText(publicSpeech)));
      for (const clip of clips) expect(JSON.parse(await readFile(`${clip.audioFile}.json`, 'utf8')).text).toBe(clip.spokenText);
      for (const name of ['source.json', 'plan.json', 'editorial-context.json', 'script.json', 'clips.json', 'timeline.json', 'subtitles/captions.srt', ...clips.map((clip: any) => `audio/${clip.id}.wav.json`)]) {
        const content = await readFile(join(dir, name), 'utf8');
        expect(content).not.toMatch(/OTHER_PRIVATE_SENTINEL|REVIEW_PRIVATE_SENTINEL/);
        if (role !== 'werewolf') expect(content).not.toContain(wolfSecret);
        if (role !== 'seer') expect(content).not.toContain(seerText);
        if (role !== 'werewolf') expect(content).not.toContain(spokenText(wolfSecret));
        if (role !== 'seer') expect(content).not.toContain(spokenText(seerText));
      }
      const master = await readFile(join(dir, 'master.wav'));
      let offset = 44;
      for (const clip of timeline.clips) {
        const normalized = await readFile(join(dir, 'audio-normalized', `${clip.id}.wav`));
        expect(master.subarray(offset, offset + normalized.length - 44)).toEqual(normalized.subarray(44));
        offset += normalized.length - 44;
      }
      expect(offset).toBe(master.length);
      const pcm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', join(dir, 'output', 'latest-match.mp4'), '-map', '0:a:0', '-ac', '1', '-ar', '24000', '-f', 's16le', '-'], { maxBuffer: 10_000_000 });
      generated.push({ role, seat, dir, clips, timeline, pcm });
    }
    // Include a real witch-seat projection to calculate the explicitly forbidden private tone.
    const witchScript = buildPlayerVideo(record, 'matrix', witch);
    const witchEntry = witchScript.chapters.flatMap((c) => c.entries).find((e) => e.type === 'witch.poison')!;
    const privateWitchTone = syntheticTone(spokenText(witchEntry.text), witchEntry.sourceSeq, witchEntry.seat ?? 0);
    const categoryTones = new Map<string, Set<number>>();
    for (const result of generated) for (const clip of result.clips) {
      const tone = syntheticTone(clip.spokenText, clip.sourceSeq, clip.seat ?? 0);
      const set = categoryTones.get(clip.type) ?? new Set<number>(); set.add(tone); categoryTones.set(clip.type, set);
    }
    categoryTones.set('witch.poison', new Set([privateWitchTone]));
    for (const result of generated) {
      const forbidden = ['witch.poison', ...(result.role === 'werewolf' ? [] : ['wolf.chat']), ...(result.role === 'seer' ? [] : ['seer.result'])]
        .flatMap((kind) => [...(categoryTones.get(kind) ?? [])]);
      for (const clip of result.timeline.clips) {
        const frequency = syntheticTone(clip.spokenText, clip.sourceSeq, clip.seat ?? 0);
        expect(forbidden).not.toContain(frequency);
        const start = Math.round((clip.startFrame / 30 + .25) * 24000), length = 14400;
        expect(result.pcm.length).toBeGreaterThanOrEqual((start + length) * 2);
        const authorized = tonePower(result.pcm, start, length, frequency);
        expect(authorized).toBeGreaterThan(500);
        for (const hidden of forbidden) expect(tonePower(result.pcm, start, length, hidden)).toBeLessThan(authorized * .2);
      }
      // Scan the entire decoded track, including padding and the ending, for forbidden tones.
      for (const hidden of forbidden) for (let start = 0; start + 4800 <= result.pcm.length / 2; start += 4800) {
        expect(tonePower(result.pcm, start, 4800, hidden)).toBeLessThan(1000);
      }
    }
  }, 240000);
});
