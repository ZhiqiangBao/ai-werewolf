import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileEdit, locateQuote, readJob } from '../../../scripts/video/compile-edit';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
it('binds original quote, word timings, audio, review and relative jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compile-edit-'));
  try {
    const src = join(root, 'src'); await mkdir(join(src, 'audio'), { recursive: true });
    const source = Buffer.from(JSON.stringify({ roomId: 'room', locale: 'en', events: [{ sourceSeq: 1 }] }));
    await writeFile(join(src, 'source.json'), source); await writeFile(join(src, 'avatar-theme.json'), JSON.stringify({ theme: 'urban' }));
    await writeFile(join(src, 'clips.json'), JSON.stringify([{ id: 'one', sourceSeq: 1, spokenText: 'Hello, brave world.' }]));
    const audio = Buffer.from('synthetic audio'); await writeFile(join(src, 'audio', 'one.wav'), audio);
    await writeFile(join(src, 'audio', 'one.wav.json'), JSON.stringify({ text: 'Hello, brave world.', bytes: audio.length, sentences: [{ words: [{ text: 'Hello', begin_time: 20, end_time: 80 }, { text: 'brave', begin_time: 100, end_time: 200 }, { text: 'world', begin_time: 230, end_time: 400 }] }] }));
    const manuscript = Buffer.from(JSON.stringify({ items: [{ kind: 'source', id: 's', sourceSeq: 1, quote: 'brave world.', reason: 'test', storyCard: { headline: 'Story' } }, {kind:'narration', id:'n', text:'Next.', afterSourceSeq:1, delivery:'calm'}] }));
    await writeFile(join(root, 'manuscript.json'), manuscript);
    await writeFile(join(root, 'job.json'), JSON.stringify({ sourceProject: 'src', manuscript: 'manuscript.json', output: 'compiled/selection.json', reviewFile: 'review.json' }));
    await writeFile(join(root, 'review.json'), JSON.stringify({ status: 'approved', checks: { edit: { sha256: sha(manuscript) } } }));
    const result = await compileEdit(join(root, 'job.json'));
    expect(result.reviewed).toBe(true); expect(result.sourceSha256).toBe(sha(source));
    expect(result.items[0]).toMatchObject({ sourceClipId: 'one', quote: 'brave world.', wordStart: 1, wordEnd: 3, audioSha256: sha(audio) });
    expect(result.items[1]).toMatchObject({ delivery: 'calm' });
    expect(JSON.parse(await readFile(join(root, 'compiled/selection.json'), 'utf8')).theme).toBe('urban');
    await writeFile(join(root, 'review.json'), JSON.stringify({ approved: true, manuscriptSha256: '0'.repeat(64) }));
    await expect(compileEdit(join(root, 'job.json'), true)).rejects.toThrow(/SHA mismatch/);
    await writeFile(join(root, 'job.json'), JSON.stringify({ sourceProject: 'src', manuscript: 'manuscript.json', output: 'selection.json' }));
    expect((await compileEdit(join(root, 'job.json'), true)).reviewed).toBe(false);
    await writeFile(join(root, 'job.json'), JSON.stringify({ sourceProject: 'src', surprise: 'x' }));
    await expect(readJob(join(root, 'job.json'), ['sourceProject'])).rejects.toThrow(/Unknown/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('rejects ambiguous or altered text and permits explicit occurrence', () => {
  const words = ['Hi', '. Hi', '!'].slice(0, 2).map(text => ({ text }));
  words[1].text += '!';
  expect(() => locateQuote('Hi. Hi!', words, 'Hi')).toThrow(/Ambiguous/);
  expect(locateQuote('Hi. Hi!', words, 'Hi', 2)).toEqual({ wordStart: 1, wordEnd: 2 });
  expect(() => locateQuote('Hi. Hi!', words, 'hi')).toThrow(/does not match/);
  expect(() => locateQuote('Hi. Hi!', words, 'Hi?')).toThrow(/does not match/);
});

it('job CLI validates exactly like legacy flags', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', fileURLToPath(new URL('./fixtures/video-compile-job-check.ts', import.meta.url))], { stdio: 'pipe', timeout: 60000 });
}, 60000);
