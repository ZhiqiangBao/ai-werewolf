import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindTheme, artManifest } from '../../../../scripts/video/avatar-theme';
import { publicationMetadata, syncPublishCopy, withPublicationDetails } from '../../../../scripts/video/publish-copy';
import type { Cast, VoiceCatalog } from '../../../../scripts/video/project';
import { characterVoiceDirection } from '../../../../scripts/video/character-delivery';

test('room theme, explicit override, old records and existing project conflicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-theme-'));
  try {
    const room = join(dir, 'room.json'); await writeFile(room, JSON.stringify({ avatarStyle: 'urban' }));
    assert.equal(await bindTheme(join(dir, 'default'), room), 'urban');
    assert.equal(await bindTheme(join(dir, 'override'), room, 'fantasy'), 'fantasy');
    assert.equal(await bindTheme(join(dir, 'override'), room, undefined, true), 'fantasy');
    await assert.rejects(bindTheme(join(dir, 'override'), room), /conflict/);
    await writeFile(room, '{}'); assert.equal(await bindTheme(join(dir, 'old-room'), room), 'campus');
    const legacy = join(dir, 'legacy'); await mkdir(legacy); await writeFile(join(legacy, 'voices.json'), '{"keep":true}');
    await assert.rejects(bindTheme(legacy, room), /no verifiable avatar theme/);
    assert.equal(await readFile(join(legacy, 'voices.json'), 'utf8'), '{"keep":true}');
    await writeFile(join(legacy, 'workflow-status.json'), '{"theme":"urban"}');
    await assert.rejects(bindTheme(legacy, room), /conflict/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('art manifest uses public cast only and records actual voice and grid', () => {
  const cast = [{ seat: 9, name: 'Nine', role: 'secret-role', roleName: 'secret-name', factionName: 'secret-faction', voiceKey: 'seat-9' }] satisfies Cast[];
  const voices = { model: 'test', profiles: { 'seat-9': { voice: 'custom-voice', label: 'Nine', rate: 1, instruction: '' } } } satisfies VoiceCatalog;
  const manifest = artManifest('urban', cast, voices);
  assert.match(manifest.atlas, /avatars-urban-v1.webp$/);
  assert.deepEqual(manifest.seats[0], { seat: 9, name: 'Nine', row: 3, column: 1, appearance: '自信银短发年长女', gender: '女', voiceKey: 'seat-9', voice: 'custom-voice', voiceDirection: characterVoiceDirection('urban', 9), instruction: '' });
  assert.doesNotMatch(JSON.stringify(manifest), /secret/);
});

test('publication language and explicit shared model survive repeated sync', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-copy-'));
  try {
    const cast = [1, 2].map((seat) => ({ seat, name: `Name ${seat}`, role: '', roleName: '', factionName: '', voiceKey: `seat-${seat}` }));
    const script = { roomId: 'test', cast, ruleCard: '原始规则\nsecond line' };
    const room = { seats: cast.map(({ seat }) => ({ seat, controller: 'ai', model: 'same-model' })) };
    const metadata = publicationMetadata(room, script);
    const english = withPublicationDetails('# Title\nA\n\n# Description\nB', metadata);
    assert.match(english, /\| Seat \| Name \| Model \/ human \|/); assert.match(english, /原始规则/);
    const chinese = withPublicationDetails('# 标题\nA\n\n# 简介\nB', metadata); assert.match(chinese, /\| 座位 \| 昵称/);
    await mkdir(join(dir, 'output')); const file = join(dir, 'output', 'publish-copy.md');
    await writeFile(file, '# Title\nA\n\n# Description\nB\n\n<!-- werewolf-publication-models:shared -->\n');
    await syncPublishCopy(dir, room, script); const first = await readFile(file, 'utf8');
    await syncPublishCopy(dir, room, script); assert.equal(await readFile(file, 'utf8'), first);
    assert.match(first, /All 2 AI seats use same-model with independent conversations/); assert.doesNotMatch(first, /Name 1|\| Seat/);
    for (const bad of [{ seats: [{ seat: 1, controller: 'human', model: 'same-model' }, room.seats[1]] }, { seats: [room.seats[0], { seat: 2, controller: 'ai', model: 'other' }] }, { seats: [room.seats[0]] }]) {
      await assert.rejects(syncPublishCopy(dir, bad, script), /Shared model/);
      assert.equal(await readFile(file, 'utf8'), first);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
