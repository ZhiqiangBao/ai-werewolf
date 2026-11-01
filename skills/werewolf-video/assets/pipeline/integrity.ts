import assert from 'node:assert/strict';
import type { Clip, Script } from './project';
import { splitSpeech, spokenText } from './project';
import { replay } from './replay';

/** Refuse invented player speech before any TTS request, including prepared/sample manifests. */
export function assertPlayerSources(source: Script, script: Script, clips: Clip[]) {
  assert.deepEqual(script.events, source.events, 'Video editorial changed original game facts');
  const entries = source.chapters.flatMap((c) => c.entries);
  for (const clip of clips) {
    assert.equal(clip.spokenText, spokenText(clip.text), 'Spoken text changed beyond pronunciation normalization');
    if (clip.seat === undefined) {
      assert(!clip.voiceKey.startsWith('seat-'), 'A character voice needs a recorded speech or action source');
      continue;
    }
    assert.equal(clip.voiceKey, `seat-${clip.seat}`);
    if (!clip.data.presentationOnly) {
      const original = entries.find((e) => e.sourceSeq === clip.sourceSeq && e.seat === clip.seat);
      assert(original, `Missing original player speech at ${clip.sourceSeq}`);
      assert.equal(clip.text, splitSpeech(original.text)[clip.part - 1], `Player words changed at ${clip.sourceSeq}`);
      continue;
    }
    assert.equal(clip.type, 'hosting.choice', 'Generated character dialogue is forbidden');
    assert(!entries.find((e) => e.sourceSeq === clip.sourceSeq)?.data.systemFallback, 'System fallback cannot become a model choice');
    const fact = source.events.find((f) => f.sourceSeq === clip.sourceSeq);
    assert(fact, 'Recorded action is missing');
    const d = fact.data;
    const actor = Array.isArray(fact.audience) && fact.audience.length === 1 ? fact.audience[0] : undefined;
    const expected: Record<string, string> = {
      'guard.protect': `我守护${d.target}号。`, 'guard.skip': '今晚空守。',
      'seer.result': `我查验${d.target}号。`, 'seer.skip': '本夜不查验。',
      'witch.save': `我用解药救${d.target}号。`, 'witch.poison': `我用毒药毒${d.target}号。`, 'witch.idle': '今晚不用药。',
    };
    if (fact.type === 'speech.order') {
      const sheriff = replay(source, fact.sourceSeq - 1).sheriff;
      assert.equal(clip.seat, sheriff);
      assert.equal(clip.text, `我选${d.direction === 'counterclockwise' ? '逆时针' : '顺时针'}，从${d.order?.[0]}号开始。`);
    } else {
      assert.equal(clip.seat, actor, 'Action narration assigned to the wrong actor');
      assert(expected[fact.type], 'This event cannot authorize generated character dialogue');
      assert.equal(clip.text, expected[fact.type], 'Action narration added unrecorded speech');
    }
  }
}
