import { mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url), skill = new URL('skills/werewolf-video/', root);
const files = ['vertical-highlight.ts', 'vertical-scene.ts', 'video-locale.ts', 'death-glyphs.ts', 'skill-effects-core.ts', 'skill-effects.ts', 'video-effect.ts', 'player-audio-provenance.ts', 'audio.ts', 'audio-cache.ts', 'audio-inspection.ts', 'audio-content-review.ts', 'audio-alignment.ts', 'asr-comparison.ts', 'review-audio.ts', 'import-audio-alignment.ts', 'audit-audio.ts', 'compress.ts', 'editorial.ts', 'encoding.ts', 'geometry.ts', 'hosting.ts', 'integrity.ts', 'materials.ts', 'metrics.ts', 'narration.ts', 'palette.ts', 'preflight.ts', 'prepare.ts', 'preview.ts', 'project.ts', 'project-models.ts', 'publish-copy.ts', 'qwen.ts', 'render.ts', 'repair-audio.ts', 'replay.ts', 'rule-cards.ts', 'rule-strip.ts', 'sample.ts', 'scene.ts', 'speaker.ts', 'synthesize.ts', 'timeline.ts', 'tts.ts', 'tts-types.ts', 'verify-sample.ts', 'verify.ts', 'voices.json', 'workflow.ts'];
await mkdir(new URL('assets/pipeline/', skill), { recursive: true });
await mkdir(new URL('assets/art/moon-village/', skill), { recursive: true });
// Keep the installable bundle self-contained even when this checkout shares speech
// code with live playback. Older target checkouts may not have session/src/speech.
files.push('character-voices.ts', 'character-delivery.ts', 'avatar-theme.ts', 'english-captions.ts', 'edited-video.ts', 'compile-edit.ts', 'synthesize-narration.ts', 'transitions.ts', 'tts-config.ts', 'voice-enroll.ts', 'generate-voice-references.ts');
const speechSources = new Map([['audio.ts', 'audio.ts'], ['audio-cache.ts', 'audio-cache.ts'], ['qwen.ts', 'qwen.ts'], ['tts-types.ts', 'types.ts'], ['project-models.ts', '../project-models.ts']]);
for (const name of files) {
  const speech = speechSources.get(name), destination = new URL(`assets/pipeline/${name}`, skill);
  if (name === 'death-glyphs.ts') { await copyFile(new URL('packages/protocol/src/death-glyphs.ts', root), destination); continue; }
  if (name === 'skill-effects-core.ts') {
    const source = await readFile(new URL('packages/protocol/src/skill-effects.ts', root), 'utf8');
    const typeImport = "import type { GameEvent, Viewer } from './index';";
    if (!source.includes(typeImport)) throw Error('Shared skill-effect type import changed; update the bundle rewrite');
    const types = "type Viewer = { kind: 'god' } | { kind: 'spectator' } | { kind: 'seat'; seat: number };\ntype GameEvent = { seq: number; type: string; audience: 'public' | number[]; payload: Record<string, unknown> };";
    await writeFile(destination, source.replace(typeImport, types));
    continue;
  }
  if (!speech) {
    const source = await readFile(new URL(`scripts/video/${name}`, root), 'utf8');
    await writeFile(destination, source.replaceAll("from '../../packages/protocol/src/death-glyphs'", "from './death-glyphs'")
      .replaceAll("from '../../packages/protocol/src/skill-effects'", "from './skill-effects-core'")
      .replaceAll("from '../../packages/session/src/speech/qwen'", "from './qwen'")
      .replaceAll("from '../../packages/session/src/project-models'", "from './project-models'"));
    continue;
  }
  let source = await readFile(new URL(`packages/session/src/speech/${speech}`, root), 'utf8');
  if (name === 'project-models.ts') {
    const library = await readFile(new URL('packages/session/src/model-library.ts', root), 'utf8');
    const validator = library.match(/export function validEnvName\(value: unknown\): value is string \{\r?\n[^}]*\r?\n\}/)?.[0];
    if (!validator || !source.includes("import { validEnvName } from './model-library';")) throw Error('Model credential validator changed; update the bundle rewrite');
    source = source.replace("import { validEnvName } from './model-library';", validator.replace('export ', ''));
  }
  await writeFile(destination, source.replaceAll("from './types'", "from './tts-types'")
    .replaceAll("from '../project-models'", "from './project-models'")
    .replaceAll("from './secret'", "from '../../packages/session/src/secret'"));
}
const art = new URL('apps/web/public/art/moon-village/', root);
for (const name of await readdir(art)) if (name.endsWith('.webp')) await copyFile(new URL(name, art), new URL(`assets/art/moon-village/${name}`, skill));
await copyFile(new URL('design/ui-redesign/prompts.json', root), new URL('assets/art/moon-village/prompts.json', skill));
await writeFile(new URL('assets/bundle.json', skill), JSON.stringify({ format: 'werewolf-video-skill-bundle', version: 19, pipelineFiles: files.length, artFiles: 10, artPromptFile: 'assets/art/moon-village/prompts.json', source: 'scripts/video/', features: ['portrait-character-voice-design', 'model-scoped-voice-bindings', 'flash-default-token-plan-plus-routing', 'decoded-still-frame-reuse', 'scene-boundary-transitions', 'upload-quality-default', 'lossless-scene-plates', 'speaker-switch-frame-review', 'no-public-room-id', 'reviewed-edits-720-seconds', 'independent-manuscript-compilation', 'config-driven-narration-tts', 'english-semantic-captions', 'reviewed-vertical-highlights', 'pcm-driven-avatar-rings', 'source-preserving-speech-parts', 'theme-character-voice-matching', 'original-avatar-prompts', 'on-demand-asr', 'offline-model-registration', 'q8-local-asr', 'locale-routed-independent-asr', 'verified-external-transcript-timing', 'authorized-player-view', 'player-audio-provenance', 'shared-skill-animation', 'video-ui-languages', 'perspective-safe-death-glyphs', 'tts-language-hints', 'project-owned-model-credentials', 'preproduction-review', 'reviewed-materials-gate', 'truthful-action-hosting', 'source-integrity', 'tts-provider-adapter', 'exact-request-audio-cache', 'all-role-rule-scroll', 'compact-vote-card', 'speaker-portrait-and-host-emblems', 'centered-caption-region', 'reviewed-judge-cue-delivery', 'pcm-waveform-audit', 'selective-seeded-audio-repair', 'public-seat-model-roster', 'recorded-rule-card-description', 'native-compact-export', 'strict-gpu-encoding'], generatedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ skill: decodeURIComponent(skill.pathname), pipelineFiles: files.length, artFiles: 10 }));
