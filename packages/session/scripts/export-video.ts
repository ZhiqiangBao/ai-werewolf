import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVideoScript, type RoomBrief } from '@werewolf/protocol';
import { projectGod } from '@werewolf/engine';
import type { RoomRecord } from '../src/store';

// 本地文件导出，不启动房间、不发模型请求、不改原始对局。
const roomId = process.argv.find((s) => s.startsWith('--room='))?.slice(7);
if (!roomId || !/^[a-zA-Z0-9_-]+$/.test(roomId)) throw new Error('请用 --room 指定房间');
const directory = process.env.WEREWOLF_DATA ?? 'data';
const record = JSON.parse(readFileSync(join(directory, 'rooms', `${roomId}.json`), 'utf8')) as RoomRecord;
if (!record.state) throw new Error('该房间尚未开局');
const projection = projectGod(record.state, record.events);
const room: RoomBrief = { roomId, viewer: 'host', status: record.status, paused: record.paused, presetName: projection.presetName, seats: record.seats.map((s) => ({ seat: s.seat, name: s.name, controller: s.controller })) };
const script = buildVideoScript(projection, room);
const path = join(directory, 'exports', `${roomId}-video-script.json`);
mkdirSync(join(directory, 'exports'), { recursive: true });
writeFileSync(path, JSON.stringify(script, null, 2));
console.log(JSON.stringify({ path, status: script.status, chapters: script.chapters.length, entries: script.chapters.reduce((n, c) => n + c.entries.length, 0), facts: script.events.length }));
