import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { seatPosition } from './geometry';
import { replay, type ReplayState } from './replay';
import type { Cast, Script, TimedClip } from './project';

const require = createRequire(import.meta.url);
const { createCanvas, loadImage, GlobalFonts, Path2D } = require(process.env.VIDEO_CANVAS_MODULE || '@napi-rs/canvas');
for (const [file, family] of [['msyh.ttc', 'GameCN'], ['msyhbd.ttc', 'GameCNBold']]) {
  const path = `C:/Windows/Fonts/${file}`; if (existsSync(path)) GlobalFonts.registerFromPath(path, family);
}
const W = 1920, H = 1080, CX = 714, CY = 520;
const colors: Record<string, string> = { werewolf: '#ff8d94', seer: '#c3a6f6', witch: '#cfabf6', hunter: '#f2c57c', guard: '#8fcfe9', villager: '#b1d4bd' };
const paths: Record<string, string> = {
  mic: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V5Z M5 10v1a7 7 0 0 0 14 0v-1 M12 18v4 M8 22h8',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  sun: 'M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6 7 7 M17 17l1.4 1.4 M5.6 18.4 7 17 M17 7l1.4-1.4 M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z',
  moon: 'M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6 8.6 8.6 0 1 0 20.4 14.2Z M17.5 3v4 M15.5 5h4',
  flag: 'M5 22V3 M5 4c5-4 9 4 15 0v10c-6 4-10-4-15 0',
  badge: 'm12 2 3 3.2 4.4.7.7 4.4L23 13l-3.2 3-.7 4.4-4.4.7L12 24l-3-2.9-4.4-.7-.7-4.4L1 13l2.9-2.7.7-4.4L9 5.2 12 2Z M12 7l1.6 3.2 3.5.5-2.6 2.5.7 3.5-3.2-1.7-3.2 1.7.7-3.5-2.6-2.5 3.5-.5L12 7Z',
  shield: 'M12 2 3 6v6c0 6 9 10 9 10s9-4 9-10V6l-9-4Z M8 12l3 3 5-6',
  potion: 'M9 2h6 M10 2v6l-6 10a3 3 0 0 0 2.6 4h10.8a3 3 0 0 0 2.6-4L14 8V2 M7 15h10',
  target: 'M21 12a9 9 0 1 1-9-9 M17 2v5h5 M21 3l-9 9 M16 12a4 4 0 1 1-4-4',
  person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M4 21v-2a8 8 0 0 1 16 0v2',
  wolf: 'm13 13 8 5h6l8-5-2 18-9 8-9-8-2-18Z M13 13l9 16-7 2 M35 13l-9 16 7 2 M22 29h4l-2 5-2-5Z M18 24l3 1 M30 24l-3 1',
};
export const sceneVersion = 'moon-village-video-v4';
export async function createSceneRenderer(script: Script) {
  const art = resolve('apps/web/public/art/moon-village');
  const theme = process.env.VIDEO_AVATAR_STYLE || 'campus';
  const themes: Record<string, string> = { campus: '日式校园', storybook: '童话绘本', gufeng: '中式古风', fantasy: '剑与魔法', urban: '现代都市', future: '未来科技' };
  if (!themes[theme]) throw Error('Unsupported avatar theme');
  const [day, night, tableDay, tableNight, atlas] = await Promise.all(['village-day-v1.webp', 'village-night-v1.webp', 'table-day-v1.webp', 'table-night-v1.webp', `avatars-${theme}-v1.webp`].map((f) => loadImage(`${art}/${f}`)));
  const canvas = createCanvas(W, H), g = canvas.getContext('2d');
  function round(x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string, thickness = 1) {
    g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = fill; g.fill();
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = thickness; g.stroke(); }
  }
  function text(value: string, x: number, y: number, size: number, color = '#f9eed7', weight = false, align = 'left', maxWidth?: number) {
    g.font = `${size}px ${weight ? 'GameCNBold' : 'GameCN'}`;
    if (maxWidth && g.measureText(value).width > maxWidth) g.font = `${size * maxWidth / g.measureText(value).width}px ${weight ? 'GameCNBold' : 'GameCN'}`;
    g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(value, x, y);
  }
  function paragraph(value: string, x: number, y: number, width: number, size: number, lineHeight: number, color: string, maxLines = 20) {
    g.font = `${size}px GameCN`; const lines: string[] = []; let current = '';
    for (const char of value) {
      if (char === '\n' || (current && g.measureText(current + char).width > width)) { lines.push(current); current = char === '\n' ? '' : char; }
      else current += char;
    }
    if (current) lines.push(current);
    lines.slice(0, maxLines).forEach((l, i) => text(l, x, y + i * lineHeight, size, color));
    return Math.min(lines.length, maxLines) * lineHeight;
  }
  function icon(name: string, x: number, y: number, size: number, color: string, fill?: string) {
    const path = new Path2D(paths[name] ?? paths.eye), units = name === 'wolf' ? 48 : 26;
    g.save(); g.translate(x, y); g.scale(size / units, size / units); g.lineWidth = name === 'wolf' ? 1.7 : 1.5;
    g.lineCap = 'round'; g.lineJoin = 'round'; if (fill) { g.fillStyle = fill; g.fill(path); } g.strokeStyle = color; g.stroke(path); g.restore();
  }
  function portrait(seat: number, x: number, y: number, size: number, radius: number, dim = false) {
    const cellW = atlas.width / 4, cellH = atlas.height / 3, i = seat - 1;
    g.save(); g.beginPath(); g.roundRect(x, y, size, size, radius); g.clip();
    g.drawImage(atlas, (i % 4) * cellW, Math.floor(i / 4) * cellH, cellW, cellH, x, y, size, size);
    if (dim) { g.fillStyle = 'rgba(6,15,26,.68)'; g.fillRect(x, y, size, size); } g.restore();
  }
  function roleIcon(c: Cast) { return c.role === 'werewolf' ? 'wolf' : c.role === 'seer' ? 'eye' : c.role === 'guard' ? 'shield' : c.role === 'witch' ? 'potion' : c.role === 'hunter' ? 'target' : 'person'; }
  function seat(c: Cast, i: number, state: ReplayState, clip: TimedClip) {
    const { cos, sin } = seatPosition(i, script.cast.length), x = CX + cos * 565, y = CY + sin * 292 + (sin < -.7 ? -12 : 10);
    const active = clip.seat === c.seat, alive = state.alive.has(c.seat), tint = colors[c.role] ?? '#c4d4cb';
    const left = x - 58, top = y - 60;
    if (active) {
      g.save(); g.shadowBlur = 25; g.shadowColor = '#8df5cd'; round(left - 7, top - 7, 130, 130, 27, 'rgba(112,241,195,.12)', '#91efd1', 3); g.restore();
    }
    round(left - 2, top - 2, 120, 120, 23, '#142932', active ? '#a8ffe1' : '#e4c896', active ? 4 : 2);
    portrait(c.seat, left, top, 116, 21, !alive);
    round(left - 4, top + 88, 35, 31, 11, '#122a37', '#d7ba80', 1.4);
    text(String(c.seat), left + 13, top + 103, 21, '#fff1c9', true, 'center');
    round(left + 40, top + 90, 81, 29, 10, '#132d37', tint, 1);
    icon(roleIcon(c), left + 44, top + 94, 20, tint); text(c.roleName, left + 86, top + 105, 16, tint, true, 'center', 50);
    round(left - 10, top + 125, 136, 33, 12, 'rgba(12,31,41,.93)', 'rgba(225,198,150,.38)');
    text(c.name, x, top + 141, 21, alive ? '#fff2d9' : '#a6adb3', true, 'center', 122);
    if (!alive) { round(left + 31, top + 24, 60, 30, 12, '#26323ae6', '#a4b4bb'); text('出局', x + 3, top + 39, 17, '#d8e0df', false, 'center'); }
    if (state.sheriff === c.seat) { round(left - 18, top - 21, 45, 45, 16, '#f6d693', '#fff3c7', 2); icon('badge', left - 9, top - 13, 28, '#70511e'); }
    if (state.election && state.candidates.has(c.seat)) {
      const withdrawn = state.withdrawn.has(c.seat); round(left + 64, top - 24, 71, 27, 10, withdrawn ? '#54616c' : '#284d78', withdrawn ? '#b6c2cb' : '#a2cfff');
      icon('flag', left + 69, top - 20, 19, '#d2e9ff'); text(withdrawn ? '退水' : '上警', left + 110, top - 11, 16, '#e7f3ff', true, 'center');
    }
    if (active) {
      const pillX = cos > .8 ? left - 101 : cos < -.8 ? left + 124 : left + 7;
      const pillY = Math.abs(cos) > .8 ? top + 40 : sin < 0 ? top + 164 : top - (state.election && state.candidates.has(c.seat) ? 58 : 37);
      round(pillX, pillY, 100, 30, 14, '#225c50', '#a0f5d1', 1.5); icon('mic', pillX + 7, pillY + 5, 20, '#b9ffe4'); text('发言中', pillX + 63, pillY + 16, 16, '#dcffed', true, 'center');
    }
    const target = typeof clip.data.target === 'number' ? clip.data.target : clip.type === 'wolf.kill.result' ? clip.data.knife : undefined;
    if (target === c.seat) { round(left + 10, top + 47, 95, 28, 12, '#102d3aee', '#f6d48f', 1.5); text(clip.type.startsWith('guard.') ? '守护目标' : clip.type.startsWith('seer.') ? '查验目标' : clip.type === 'witch.save' ? '使用解药' : clip.type === 'witch.poison' ? '使用毒药' : '狼刀目标', x, top + 61, 16, '#ffe2a0', true, 'center'); }
  }
  function central(clip: TimedClip, state: ReplayState) {
    const voting = clip.type === 'vote.result', ending = clip.phase === 'end', event = state.lastVote?.sourceSeq === clip.sourceSeq ? state.lastVote : undefined;
    const h = voting ? 266 : 178, top = voting ? 379 : 425;
    round(462, top, 504, h, 27, 'rgba(9,39,45,.91)', 'rgba(249,219,158,.62)', 1.5);
    if (voting && event) {
      icon('badge', 491, top + 22, 29, '#f7da9c'); text(event.data.kind === 'sheriff' ? '警长投票' : '放逐投票', 535, top + 39, 25, '#f9e2ad', true);
      (event.data.rows ?? []).slice(0, 4).forEach((r: any, i: number) => {
        const y = top + 87 + i * 48; text(`${r.target}号`, 493, y, 23, '#fff1d3', true); text(`${r.weight} 票`, 906, y, 23, '#f7cf87', true, 'right');
        text((r.voters ?? []).map((n: number) => `${n}`).join(' · '), 553, y + 1, 17, '#b8d6d0', false, 'left', 240);
      });
      text(event.data.conclusion ?? '', CX, top + h - 31, 21, '#e9e5ca', false, 'center', 440);
    } else {
      icon(ending ? 'badge' : clip.phase === 'night' ? 'moon' : 'sun', 495, top + 22, 32, '#f3d99f');
      text(ending ? `终局 · ${state.result?.winnerName ?? '胜利阵营'}获胜` : clip.chapter, 542, top + 40, 28, '#ffe5ae', true);
      text(clip.seat ? `${clip.seat}号 · ${script.cast.find((c) => c.seat === clip.seat)?.name}` : clip.voiceKey === 'commentator' ? '上帝解说' : '法官播报', CX, top + 91, 28, '#f6f3df', true, 'center', 440);
      text(ending ? '对局已结束' : clip.type === 'wolf.chat' ? '狼队密谈 · 仅上帝观众可见' : clip.seat ? '正在发言' : '对局进行中', CX, top + 127, 18, '#a7cebe', false, 'center');
    }
    round(532, 612, 364, 57, 17, 'rgba(6,25,34,.9)', 'rgba(133,229,195,.25)');
  }
  return async function draw(clip: TimedClip) {
    const state = replay(script, clip.sourceSeq), isNight = clip.phase === 'night';
    g.clearRect(0, 0, W, H); const bg = isNight ? night : day;
    const scale = Math.max(W / bg.width, H / bg.height); g.drawImage(bg, (W - bg.width * scale) / 2, (H - bg.height * scale) / 2, bg.width * scale, bg.height * scale);
    const shade = g.createLinearGradient(0, 0, W, H); shade.addColorStop(0, isNight ? '#07132440' : '#173b3d25'); shade.addColorStop(1, '#081425ce'); g.fillStyle = shade; g.fillRect(0, 0, W, H);
    round(28, 25, 1864, 80, 26, '#0e2332eb', '#d3bc824f');
    icon('wolf', 50, 40, 51, '#ead19a'); text('月影议事厅', 116, 63, 29, '#f7e4b7', true); text('十二人预女猎守', 333, 64, 21, '#adc7ca');
    round(760, 42, 210, 44, 20, isNight ? '#253750' : '#425548', '#cbdac04f'); icon(isNight ? 'moon' : 'sun', 778, 51, 25, '#f3da9b'); text(clip.chapter, 869, 64, 22, '#f8eacb', true, 'center');
    icon('eye', 1510, 51, 28, '#93d6cb'); text('上帝视角 · 完整对局', 1556, 64, 23, '#d5f1e8');
    round(28, 126, 1375, 799, 30, '#122b352d', '#e8d7a74a');
    const tw = 1042, th = tw * tableDay.height / tableDay.width; g.save(); g.shadowBlur = 32; g.shadowColor = '#07131a99'; g.shadowOffsetY = 20;
    g.drawImage(isNight ? tableNight : tableDay, CX - tw / 2, CY - th / 2 + 10, tw, th); g.restore();
    central(clip, state); script.cast.forEach((c, i) => seat(c, i, state, clip));
    round(1430, 126, 462, 799, 29, '#0d2333ed', '#d5c18c5c');
    const player = script.cast.find((c) => c.seat === clip.seat);
    const accent = clip.type === 'wolf.chat' ? '#f3a2ae' : clip.voiceKey === 'commentator' ? '#a7ead6' : '#efd397';
    text(clip.type === 'wolf.chat' ? '夜间 · 狼队密谈' : player ? state.election ? '白天 · 警上发言' : '白天 · 玩家发言' : clip.voiceKey === 'commentator' ? '上帝解说' : '法官播报', 1456, 160, 17, accent, true);
    if (player) portrait(player.seat, 1456, 189, 80, 19);
    else { round(1456, 189, 80, 80, 20, '#25453f', '#acd5bb7f'); icon(clip.voiceKey === 'commentator' ? 'eye' : 'badge', 1477, 209, 40, '#edd598'); }
    text(player?.name ?? clip.speaker, 1553, 216, 28, '#faf1db', true, 'left', 308);
    text(player ? `${player.seat}号 · ${player.roleName}` : clip.voiceKey === 'commentator' ? '陪你看懂这场对局' : '阶段、行动与结果', 1553, 251, 18, '#a4c4c3');
    g.strokeStyle = '#d3cfab38'; g.lineWidth = 1; g.beginPath(); g.moveTo(1456, 289); g.lineTo(1867, 289); g.stroke();
    const used = paragraph(clip.text, 1456, 323, 405, 23, 36, '#e3e9e2', 15);
    if (clip.parts > 1) text(`本次发言 ${clip.part} / ${clip.parts}`, 1456, Math.min(864, 337 + used), 16, '#88a8aa');
    const aliveWolves = script.cast.filter((c) => c.role === 'werewolf' && state.alive.has(c.seat)).length;
    round(1456, 866, 408, 35, 12, '#162e3c'); text(`存活 ${state.alive.size} 人     狼人 ${aliveWolves}     好人 ${state.alive.size - aliveWolves}`, 1660, 883, 17, '#bdd4ca', false, 'center');
    round(28, 942, 1864, 111, 25, '#0a1b2bee', '#cdbb864c');
    text(clip.seat ? `${clip.seat}号 ${player?.name}` : clip.speaker, 57, 966, 17, accent, true);
    text('AI 配音 · 对局实录', 1863, 966, 15, '#88a4ad', false, 'right');
    // Timestamped subtitles are burned in this empty strip by the encoder.
    text(`对局 ${script.roomId}  ·  ${themes[theme]}人物`, 30, 1071, 12, '#c7d7d6');
    return canvas.encode('jpeg', 94);
  };
}
