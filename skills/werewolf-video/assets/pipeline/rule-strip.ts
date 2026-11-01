import { createRequire } from 'node:module';
import type { Script } from './project';
import { palettes } from './palette';
import { allRoleRules } from './rule-cards';

const require = createRequire(import.meta.url);
const { createCanvas, loadImage } = require(process.env.VIDEO_CANVAS_MODULE || '@napi-rs/canvas');
export const RULE_VIEW = { x: 1455, y: 206, width: 412, height: 610 };
export const RULE_SCROLL_SPEED = 16;

export async function createRuleStrip(script: Script, phase: 'day' | 'night') {
  const ui = palettes[phase], width = RULE_VIEW.width;
  const measure = createCanvas(width, 1).getContext('2d'); measure.font = '22px GameCN';
  const cards = allRoleRules(script).map((card) => {
    const lines: string[] = []; let line = '';
    for (const char of card.text) {
      if (char === '\n' || (line && measure.measureText(line + char).width > 360 && !'，。！？；：、）》」'.includes(char))) {
        lines.push(line); line = char === '\n' ? '' : char;
      } else line += char;
    }
    if (line) lines.push(line);
    return { ...card, lines, height: 69 + lines.length * 31 };
  });
  const cycleHeight = Math.max(RULE_VIEW.height, cards.reduce((n, c) => n + c.height + 16, 0) + 24);
  const canvas = createCanvas(width, cycleHeight * 2 + RULE_VIEW.height), g = canvas.getContext('2d');
  g.fillStyle = ui.panel.slice(0, 7); g.fillRect(0, 0, width, canvas.height);
  for (let repeat = 0; repeat < 3; repeat++) {
    let y = repeat * cycleHeight + 4;
    for (const [i, card] of cards.entries()) {
      g.beginPath(); g.roundRect(0.75, y, width - 1.5, card.height, 17);
      g.fillStyle = ui.card; g.fill(); g.strokeStyle = ui.borderSoft; g.lineWidth = 1; g.stroke();
      g.font = '23px GameCNBold'; g.fillStyle = ui.accent; g.textBaseline = 'middle'; g.fillText(card.title, 21, y + 29);
      g.font = '14px GameCN'; g.fillStyle = ui.muted; g.textAlign = 'right'; g.fillText(`${i + 1} / ${cards.length}`, width - 21, y + 29); g.textAlign = 'left';
      g.font = '22px GameCN'; g.fillStyle = ui.text;
      card.lines.forEach((line: string, index: number) => g.fillText(line, 21, y + 68 + index * 31));
      y += card.height + 16;
    }
  }
  const png = await canvas.encode('png');
  return { png, image: await loadImage(png), cycleHeight, cards: cards.map(({ title, role, text }) => ({ title, role, text })) };
}
