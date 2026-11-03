import { mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../../', import.meta.url), skill = new URL('skills/werewolf-video/', root);
const files = ['video-locale.ts', 'death-glyphs.ts', 'skill-effects-core.ts', 'skill-effects.ts', 'video-effect.ts', 'player-audio-provenance.ts', 'audio.ts', 'audio-cache.ts', 'audio-inspection.ts', 'audit-audio.ts', 'compress.ts', 'editorial.ts', 'encoding.ts', 'geometry.ts', 'hosting.ts', 'integrity.ts', 'materials.ts', 'metrics.ts', 'narration.ts', 'palette.ts', 'preflight.ts', 'prepare.ts', 'preview.ts', 'project.ts', 'project-models.ts', 'publish-copy.ts', 'qwen.ts', 'render.ts', 'repair-audio.ts', 'replay.ts', 'rule-cards.ts', 'rule-strip.ts', 'sample.ts', 'scene.ts', 'speaker.ts', 'synthesize.ts', 'timeline.ts', 'tts.ts', 'tts-types.ts', 'verify-sample.ts', 'verify.ts', 'voices.json', 'workflow.ts'];
await mkdir(new URL('assets/pipeline/', skill), { recursive: true });
await mkdir(new URL('assets/art/moon-village/', skill), { recursive: true });
// Keep the installable bundle self-contained even when this checkout shares speech
// code with live playback. Older target checkouts may not have session/src/speech.
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
      .replaceAll("from '../../packages/protocol/src/skill-effects'", "from './skill-effects-core'"));
    continue;
  }
  const source = await readFile(new URL(`packages/session/src/speech/${speech}`, root), 'utf8');
  await writeFile(destination, source.replaceAll("from './types'", "from './tts-types'")
    .replaceAll("from '../project-models'", "from './project-models'")
    .replaceAll("from './secret'", "from '../../packages/session/src/secret'"));
}
const art = new URL('apps/web/public/art/moon-village/', root);
for (const name of await readdir(art)) if (name.endsWith('.webp')) await copyFile(new URL(name, art), new URL(`assets/art/moon-village/${name}`, skill));
await writeFile(new URL('assets/bundle.json', skill), JSON.stringify({ format: 'werewolf-video-skill-bundle', version: 11, pipelineFiles: files.length, artFiles: 10, source: 'scripts/video/', features: ['authorized-player-view', 'player-audio-provenance', 'shared-skill-animation', 'video-ui-languages', 'perspective-safe-death-glyphs', 'tts-language-hints', 'project-owned-model-credentials', 'preproduction-review', 'reviewed-materials-gate', 'truthful-action-hosting', 'source-integrity', 'tts-provider-adapter', 'exact-request-audio-cache', 'all-role-rule-scroll', 'compact-vote-card', 'speaker-portrait-and-host-emblems', 'centered-caption-region', 'reviewed-judge-cue-delivery', 'pcm-waveform-audit', 'selective-seeded-audio-repair', 'public-seat-model-roster', 'recorded-rule-card-description', 'native-compact-export', 'strict-gpu-encoding'], generatedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ skill: decodeURIComponent(skill.pathname), pipelineFiles: files.length, artFiles: 10 }));
