import assert from 'node:assert/strict';
import type { Clip, Script } from './project';
import { splitSpeech, spokenText } from './project';
import { replay } from './replay';
import { hostingChoice } from './hosting';

/** Refuse invented player speech before any TTS request, including prepared/sample manifests. */
export function assertPlayerSources(source: Script, script: Script, clips: Clip[]) {
  assert.deepEqual(script.events, source.events, 'Video editorial changed original game facts');
  const entries = source.chapters.flatMap((c) => c.entries);
  for (const clip of clips) {
    assert.equal(clip.spokenText, spokenText(clip.text, source.locale ?? 'zh-CN'), 'Spoken text changed beyond pronunciation normalization');
    if (clip.seat === undefined) {
      assert(!clip.voiceKey.startsWith('seat-'), 'A character voice needs a recorded speech or action source');
      continue;
    }
    assert.equal(clip.voiceKey, `seat-${clip.seat}`);
    if (!clip.data.presentationOnly) {
      const original = entries.find((e) => e.sourceSeq === clip.sourceSeq && e.seat === clip.seat);
      assert(original, `Missing original player speech at ${clip.sourceSeq}`);
      assert.equal(clip.text, splitSpeech(original.text, 230, source.locale ?? 'zh-CN')[clip.part - 1], `Player words changed at ${clip.sourceSeq}`);
      continue;
    }
    assert.equal(clip.type, 'hosting.choice', 'Generated character dialogue is forbidden');
    assert(!entries.find((e) => e.sourceSeq === clip.sourceSeq)?.data.systemFallback, 'System fallback cannot become a model choice');
    const fact = source.events.find((f) => f.sourceSeq === clip.sourceSeq);
    assert(fact, 'Recorded action is missing');
    const d = fact.data;
    const actor = Array.isArray(fact.audience) && fact.audience.length === 1 ? fact.audience[0] : undefined;
    const expected = hostingChoice(source.locale ?? 'zh-CN', fact.type, d);
    if (fact.type === 'speech.order') {
      const sheriff = replay(source, fact.sourceSeq - 1).sheriff;
      assert.equal(clip.seat, sheriff);
      assert.equal(clip.text, expected);
    } else {
      assert.equal(clip.seat, actor, 'Action narration assigned to the wrong actor');
      assert(expected, 'This event cannot authorize generated character dialogue');
      assert.equal(clip.text, expected, 'Action narration added unrecorded speech');
    }
  }
}
