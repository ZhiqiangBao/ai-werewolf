interface SceneClip { phase: string; chapter: string; frames: number }
export const transitionRevision = 'day-night-hard-cut-v1';
export const transitionDescription = 'hard cuts between day and night and within scenes; four-frame fades at other phase or chapter boundaries';

const dayOrNight = (phase: string) => phase === 'day' || phase === 'night';

export function sceneTransition(current: SceneClip, previous?: SceneClip, next?: SceneClip) {
  const frames = 4;
  const changesScene = (other?: SceneClip) => !!other && current.frames > frames * 2 && other.frames > frames * 2
    && (other.phase !== current.phase || other.chapter !== current.chapter)
    && !(other.phase !== current.phase && dayOrNight(other.phase) && dayOrNight(current.phase));
  return { fadeIn: changesScene(previous), fadeOut: changesScene(next), frames };
}
export function sceneFadeFilters(transition: ReturnType<typeof sceneTransition>, frames: number): string[] {
  return [
    ...(transition.fadeIn ? [`fade=t=in:start_frame=0:nb_frames=${transition.frames}`] : []),
    ...(transition.fadeOut ? [`fade=t=out:start_frame=${Math.max(0, frames - transition.frames)}:nb_frames=${transition.frames}`] : []),
  ];
}
