import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Clip, Script } from './project';
import { replay } from './replay';
const require = createRequire(import.meta.url);
const { createCanvas, loadImage, Path2D, GlobalFonts } = require(process.env.VIDEO_CANVAS_MODULE || '@napi-rs/canvas');
for (const file of ['arial.ttf', 'arialbd.ttf']) { const p = `C:/Windows/Fonts/${file}`; if (existsSync(p)) GlobalFonts.registerFromPath(p, 'VideoSans'); }
export interface StoryCard { headline: string; detail?: string; focusSeats?: number[] }

export function isPlayerSpeech(clip: Clip) {
  return clip.seat !== undefined && !clip.data.presentationOnly && clip.voiceKey !== 'judge' && clip.voiceKey !== 'commentator' && clip.type !== 'vote.result';
}

/** A transparent, bounded overlay; RMS is measured from the actual selected PCM. */
export function avatarWaveFrame(samples: Int16Array, frame: number): Buffer {
  const canvas = createCanvas(820, 820), g = canvas.getContext('2d');
  const end = Math.min(samples.length, (frame + 1) * 800), start = Math.max(0, frame * 800 - 1600);
  let energy = 0, weight = 0;
  for (let i = start; i < end; i++) { const w = .3 + .7 * (i - start) / Math.max(1, end - start); energy += (samples[i] / 32768) ** 2 * w; weight += w; }
  const rms = Math.sqrt(energy / Math.max(240, weight)), intensity = Math.sqrt(Math.min(1, rms / .06));
  if (intensity > .01) {
    // Three actual spectral measurements change the local lobes independently.
    const bands = [170, 480, 1300].map(hz => {
      const coefficient = 2 * Math.cos(2 * Math.PI * hz / 24000); let a = 0, b = 0;
      for (let i = start; i < end; i++) { const next = samples[i] / 32768 + coefficient * a - b; b = a; a = next; }
      return Math.min(1, Math.sqrt(Math.max(0, a * a + b * b - coefficient * a * b)) / (Math.max(1, end - start) * Math.max(.001, rms)) * 8);
    });
    const contour = new Path2D();
    for (let i = 0; i <= 180; i++) {
      const angle = i / 180 * Math.PI * 2, t = frame / 30;
      const wave = 31 + (9 + bands[0] * 6) * Math.sin(3 * angle + t * 2.2) + (6 + bands[1] * 4) * Math.sin(5 * angle - t * 2.8) + (3 + bands[2] * 2) * Math.sin(8 * angle + t * 1.7);
      const radius = 354 + intensity * .8 * wave, x = 410 + Math.cos(angle) * radius, y = 410 + Math.sin(angle) * radius;
      if (i) contour.lineTo(x, y); else contour.moveTo(x, y);
    }
    contour.closePath();
    const halo = new Path2D(contour); halo.arc(410, 410, 352, 0, Math.PI * 2, true);
    g.fillStyle = `rgba(170,235,255,${intensity * .16})`; g.fill(halo, 'evenodd');
    g.shadowColor = '#b5eeff'; g.shadowBlur = 18 * intensity; g.strokeStyle = `rgba(187,239,255,${intensity * .8})`; g.lineWidth = 3.5; g.stroke(contour);
  }
  // Leave the two avatar badges unobscured while preserving the moving rings elsewhere.
  g.clearRect(136, 634, 80, 76); g.clearRect(450, 634, 238, 76);
  return canvas.toBuffer('image/png') as Buffer;
}

/** One large focal element; subtitles are burned separately without a box. */
export async function verticalScene(clip: Clip, theme: string, script: Script, story?: StoryCard) {
  const art = resolve('apps/web/public/art/moon-village');
  const [background, atlas, table] = await Promise.all([
    loadImage(resolve(art, `village-${clip.phase === 'night' ? 'night' : 'day'}-v1.webp`)),
    loadImage(resolve(art, `avatars-${theme}-v1.webp`)),
    loadImage(resolve(art, `table-${clip.phase === 'night' ? 'night' : 'day'}-v1.webp`)),
  ]);
  const canvas = createCanvas(1080, 1920), g = canvas.getContext('2d');
  const scale = Math.max(1080 / background.width, 1920 / background.height);
  g.drawImage(background, (1080 - background.width * scale) / 2, (1920 - background.height * scale) / 2, background.width * scale, background.height * scale);
  g.fillStyle = 'rgba(9,15,28,.55)'; g.fillRect(0, 0, 1080, 1920);
  g.textAlign = 'center'; g.fillStyle = '#fff'; g.strokeStyle = '#111927'; g.lineWidth = 10; g.lineJoin = 'round';
  // Match the game's warm gold seat badge; size to its contents, never a name bar.
  const badge = (text: string, x: number, y: number, width: number, size: number, number = false) => {
    g.save(); g.beginPath(); g.roundRect(x, y + 5, width, 64, 16); g.fillStyle = '#876d4b'; g.fill();
    g.beginPath(); g.roundRect(x, y, width, 64, 16);
    const fill = g.createLinearGradient(x, y, x, y + 64); fill.addColorStop(0, '#ffe5aa'); fill.addColorStop(1, '#ecc981');
    g.fillStyle = fill; g.fill(); g.lineWidth = 3; g.strokeStyle = '#ffe2a2'; g.stroke();
    g.font = `bold ${size}px ${number ? 'Georgia, serif' : 'VideoSans'}`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#4c3826'; g.fillText(text, x + width / 2, y + 33, width - 20); g.restore();
  };
  const phase = clip.phase === 'day' ? `DAY ${clip.day}` : clip.phase === 'night' ? `NIGHT ${clip.day}` : clip.phase.toUpperCase();
  const brandTitle = 'MOONSHADOW HALL';
  g.font = 'bold 48px Georgia, serif'; const brandLeft = (1080 - g.measureText(brandTitle).width - 96) / 2;
  g.save(); g.translate(brandLeft, 146); g.scale(1.6, 1.6); g.strokeStyle = '#f0d398'; g.lineWidth = 1.5;
  g.stroke(new Path2D('m24 2 19 11v22L24 46 5 35V13L24 2Z m-11 11 8 5h6l8-5-2 18-9 8-9-8-2-18Z m0 0 9 16-7 2 M35 13l-9 16 7 2 M22 29h4l-2 5-2-5Z M18 24l3 1 M30 24l-3 1 M24 7v4 M22 9h4')); g.restore();
  g.textAlign = 'left'; g.fillStyle = '#f4d795'; g.font = 'bold 48px Georgia, serif'; g.fillText(brandTitle, brandLeft + 96, 190);
  g.fillStyle = '#d5cdb6'; g.font = '21px VideoSans'; g.fillText('AI WEREWOLF', brandLeft + 99, 230);
  const recordedVote = clip.type === 'vote.result' ? clip.data : clip.voiceKey === 'commentator' ? script.events.find(event => event.sourceSeq === clip.sourceSeq && event.type === 'vote.result')?.data : undefined;
  const stage = recordedVote ? recordedVote.kind === 'sheriff' ? 'SHERIFF VOTE' : 'EXILE VOTE' : clip.type === 'wolf.chat' ? 'WOLF CHAT' : isPlayerSpeech(clip) ? 'DISCUSSION' : 'GOD VIEW';
  g.font = '27px VideoSans'; g.fillStyle = '#d7dfd1'; g.textAlign = 'center';
  const stageText = `${phase}  ·  ${stage}`;
  g.save(); g.translate(540 - g.measureText(stageText).width / 2 - 40, 286); g.scale(1.2, 1.2); g.strokeStyle = '#e8cf96'; g.lineWidth = 1.5;
  g.stroke(new Path2D(clip.phase === 'night' ? 'M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6 8.6 8.6 0 1 0 20.4 14.2Z M17.5 3v4 M15.5 5h4' : 'M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6 7 7 M17 17l1.4 1.4 M5.6 18.4 7 17 M17 7l1.4-1.4 M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z')); g.restore();
  g.fillText(stageText, 540, 310);
  g.beginPath(); g.moveTo(365, 337); g.lineTo(715, 337); g.strokeStyle = 'rgba(240,211,152,.35)'; g.lineWidth = 1; g.stroke();
  if (isPlayerSpeech(clip)) {
    const w = atlas.width / 4, h = atlas.height / 3, index = clip.seat! - 1;
    if (!Number.isInteger(index) || index < 0 || index >= 12) throw Error('Invalid avatar seat');
    g.save(); g.beginPath(); g.arc(540, 780, 350, 0, 2 * Math.PI); g.clip();
    g.drawImage(atlas, (index % 4) * w, Math.floor(index / 4) * h, w, h, 190, 430, 700, 700); g.restore();
    const player = script.cast.find(c => c.seat === clip.seat);
    if (!player) throw Error(`Missing speaker seat ${clip.seat}`);
    const state = replay(script, clip.data.replayThrough ?? clip.sourceSeq);
    badge(String(clip.seat), 270, 1008, 72, 46, true);
    g.font = 'bold 36px VideoSans';
    const roleWidth = Math.max(112, Math.min(230, Math.ceil(g.measureText(player.roleName).width) + 32));
    badge(player.roleName, 810 - roleWidth, 1008, roleWidth, 36);
    g.font = '30px VideoSans'; g.lineWidth = 5; g.strokeStyle = '#111927'; g.fillStyle = '#e7ebe5';
    g.strokeText(player.name, 540, 1225, 600); g.fillText(player.name, 540, 1225, 600);
    if (state.sheriff === player.seat) {
      g.save(); g.translate(800, 525); g.beginPath();
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 22 : 42; if (i) g.lineTo(Math.cos(a) * r, Math.sin(a) * r); else g.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
      g.closePath(); g.fillStyle = '#e8b954'; g.fill(); g.strokeStyle = '#725028'; g.lineWidth = 3; g.stroke(); g.restore();
    }
  } else {
    // Reconstruct only facts known through this scene, never final game state.
    const state = replay(script, clip.data.replayThrough ?? clip.sourceSeq);
    g.save(); g.shadowColor = '#081a19aa'; g.shadowBlur = 35; g.shadowOffsetY = 20; g.drawImage(table, 140, 570, 800, 520); g.restore();
    const at = (text: string, x: number, y: number, size: number, width: number) => {
      g.font = `bold ${size}px VideoSans`; g.lineWidth = 6; g.strokeStyle = '#111927'; g.fillStyle = '#fff';
      g.strokeText(text, x, y, width); g.fillText(text, x, y, width);
    };
    const count = script.cast.length, w = atlas.width / 4, h = atlas.height / 3;
    const leaders = Array.isArray(recordedVote?.rows) ? recordedVote.rows.filter((row: any) => row.weight === Math.max(...recordedVote.rows.map((r: any) => r.weight))).map((row: any) => row.target) : [];
    script.cast.forEach((player, i) => {
      const angle = -Math.PI / 2 + 2 * Math.PI * i / count;
      const x = 540 + Math.cos(angle) * 412, y = 820 + Math.sin(angle) * 280, index = player.seat - 1;
      if (!Number.isInteger(index) || index < 0 || index >= 12) throw Error('Invalid avatar seat');
      if (leaders.includes(player.seat) || story?.focusSeats?.includes(player.seat)) { g.save(); g.beginPath(); g.arc(x, y, 72, 0, Math.PI * 2); g.strokeStyle = '#f4d795'; g.lineWidth = 5; g.shadowBlur = 25; g.shadowColor = '#ffce74'; g.stroke(); g.restore(); }
      g.save(); g.beginPath(); g.arc(x, y, 66, 0, Math.PI * 2); g.clip();
      g.drawImage(atlas, (index % 4) * w, Math.floor(index / 4) * h, w, h, x - 66, y - 66, 132, 132);
      if (!state.alive.has(player.seat)) { g.fillStyle = 'rgba(15,18,25,.72)'; g.fillRect(x - 66, y - 66, 132, 132); }
      g.restore();
      g.beginPath(); g.arc(x, y, 66, 0, Math.PI * 2); g.lineWidth = 5; g.strokeStyle = state.alive.has(player.seat) ? '#e3d2a3' : '#9c9c9c'; g.stroke();
      at(`${player.seat} · ${player.name}`, x, y + 92, 27, 180);
      if (story?.focusSeats?.includes(player.seat)) {
        g.save(); g.font = 'bold 42px VideoSans'; const width = Math.max(110, g.measureText(player.roleName).width + 26);
        g.translate(x + 4, y + 35); g.scale(.5, .5); badge(player.roleName, 0, 0, width, 42); g.restore();
      }
      if (!state.alive.has(player.seat)) at('OUT', x, y + 12, 32, 110);
      if (state.sheriff === player.seat) {
        g.beginPath(); g.arc(x + 48, y - 48, 23, 0, Math.PI * 2); g.fillStyle = '#f3cf6b'; g.fill();
        g.fillStyle = '#30200a'; g.font = 'bold 24px VideoSans'; g.fillText('S', x + 48, y - 39);
      }
    });
    if (Array.isArray(recordedVote?.rows)) {
      const title = recordedVote.kind === 'sheriff' ? (recordedVote.round > 1 ? 'SHERIFF RUNOFF' : 'SHERIFF VOTE') : recordedVote.kind === 'exile' ? 'EXILE VOTE' : 'VOTE';
      at(title, 540, 715, 36, 480);
      const rows = recordedVote.rows.slice(0, 9), spacing = Math.min(65, 290 / Math.max(rows.length, 1));
      rows.forEach((row: any, i: number) => {
        const player = script.cast.find(c => c.seat === row.target), y = 765 + i * spacing;
        at(`${row.target} · ${player?.name ?? 'Unknown'}   ${row.weight} VOTES`, 540, y, Math.min(31, spacing * .55), 460);
        at(`Voters: ${(row.voters ?? []).join(', ') || '—'}`, 540, y + spacing * .38, Math.min(22, spacing * .36), 450);
      });
    } else {
      // Compact center emblem identifies the host while leaving the table visible.
      g.save(); g.translate(540, 805); g.lineWidth = 8; g.strokeStyle = '#fff'; g.fillStyle = '#fff';
      if (clip.voiceKey === 'judge') {
        g.rotate(-.75); g.fillRect(-44, -42, 88, 40); g.fillRect(-10, 0, 20, 72); g.fillRect(-60, 70, 120, 10);
      } else {
        g.beginPath(); g.ellipse(0, 0, 76, 42, 0, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(0, 0, 20, 0, Math.PI * 2); g.fill();
      }
      g.restore();
      at(clip.data.presentationOnly && clip.seat !== undefined ? `PLAYER ${clip.seat} · ACTION` : clip.voiceKey === 'judge' ? 'JUDGE' : 'NARRATOR', 540, 930, 37, 440);
    }
  }
  if (story) {
    g.save(); g.textAlign = 'center'; g.lineWidth = 5; g.strokeStyle = '#17242b'; g.fillStyle = '#f4d795';
    g.font = 'bold 39px VideoSans';
    const words = story.headline.split(/\s+/), lines: string[] = []; let line = '';
    for (const word of words) { const next = line ? `${line} ${word}` : word; if (line && g.measureText(next).width > 900) { lines.push(line); line = word; } else line = next; }
    if (line) lines.push(line);
    for (const [i, text] of lines.entries()) { const y = 1285 + i * 47; g.strokeText(text, 540, y, 930); g.fillText(text, 540, y, 930); }
    if (story.detail) { g.font = '28px VideoSans'; g.fillStyle = '#d9e3d9'; const y = 1305 + lines.length * 47; g.strokeText(story.detail, 540, y, 920); g.fillText(story.detail, 540, y, 920); }
    g.restore();
  }
  const marker = clip.type === 'hosting.choice' ? 'Action paraphrase' : clip.type === 'wolf.chat' ? 'Wolf chat' : 'Excerpt';
  g.font = '23px VideoSans'; g.textAlign = 'left'; g.fillStyle = '#b7d6ca'; g.fillText(marker, 65, story ? 370 : 1375);
  return canvas.toBuffer('image/png') as Buffer;
}
