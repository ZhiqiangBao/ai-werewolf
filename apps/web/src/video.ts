import { buildVideoScript, type GodProjection, type RoomBrief } from '@werewolf/protocol';
import { completeHosting } from '../../../scripts/video/hosting';

/** 导出完整主持稿；制作流程可从事实流恢复原始章节。 */
export function buildHostedVideoScript(projection: GodProjection, room: RoomBrief) {
  const source = buildVideoScript(projection, room);
  const fallbackSeqs = source.chapters.flatMap((chapter) => chapter.entries
    .filter((entry) => entry.data.systemFallback === true).map((entry) => entry.sourceSeq));
  return { ...source, chapters: completeHosting(source, source).chapters, hosting: { version: 1, fallbackSeqs } };
}

/** 先导出无时长剪辑稿，配音完成后再按音频时长排画面。 */
export function downloadVideoScript(projection: GodProjection, room: RoomBrief): void {
  const script = buildHostedVideoScript(projection, room);
  const url = URL.createObjectURL(new Blob([JSON.stringify(script, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `werewolf-${room.roomId}-video-script.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
