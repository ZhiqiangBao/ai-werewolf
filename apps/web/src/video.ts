import { buildVideoScript, type GodProjection, type RoomBrief } from '@werewolf/protocol';

/** 先导出无时长剪辑稿，配音完成后再按音频时长排画面。 */
export function downloadVideoScript(projection: GodProjection, room: RoomBrief): void {
  const script = buildVideoScript(projection, room);
  const url = URL.createObjectURL(new Blob([JSON.stringify(script, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `werewolf-${room.roomId}-video-script.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
