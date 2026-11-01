import type { Entry, Script } from './project';
import { replay } from './replay';

const seats = (values: number[]) => values.map((n) => `${n}号`).join('、');
const required = new Set(['phase', 'witch.knife', 'witch.idle', 'sheriff.start', 'sheriff.order', 'speech.order', 'vote.result', 'dawn', 'badge.transfer', 'badge.tear']);

/** Presentation cues reconstruct recorded actions; the immutable fact stream is never extended. */
export function completeHosting(source: Script, edited: Script): Script {
  const editedEntries = edited.chapters.flatMap((c) => c.entries);
  const bySeq = new Map(editedEntries.filter((e) => !e.data.editorialAfter).map((e) => [e.sourceSeq, e]));
  const chapters = source.chapters.map((chapter) => {
    const entries: Entry[] = [];
    let wolfOpened = false;
    const cue = (anchor: Entry, key: string, text: string, seat?: number, data: Record<string, unknown> = {}) => {
      entries.push({ sourceSeq: anchor.sourceSeq, type: seat === undefined ? 'hosting.judge' : 'hosting.choice',
        speaker: seat === undefined ? '法官' : `${seat}号`, voiceKey: seat === undefined ? 'judge' : `seat-${seat}`,
        ...(seat === undefined ? {} : { seat }), text, visibility: anchor.visibility,
        data: { presentationOnly: true, presentationKey: key, replayThrough: anchor.sourceSeq - 1,
          provenance: seat === undefined ? '流程衔接' : '按该事件记录的行动转述，非玩家原话', ...data } });
    };
    for (const original of chapter.entries) {
      let e = bySeq.get(original.sourceSeq) ?? (required.has(original.type) ? original : undefined);
      if (!e) { entries.push(...editedEntries.filter((comment) => comment.sourceSeq === original.sourceSeq && comment.data.editorialAfter)); continue; }
      const d = original.data, prior = replay(source, original.sourceSeq - 1);
      const actor = source.events.find((f) => f.sourceSeq === original.sourceSeq)?.audience;
      const roleSeat = Array.isArray(actor) && actor.length === 1 ? actor[0] : undefined;
      const judge = (text: string) => { e = { ...e!, text, voiceKey: 'judge', speaker: '法官' }; };
      if (e.type === 'phase') judge(chapter.phase === 'night' ? `第${chapter.day}夜，天黑请闭眼。` : `第${chapter.day}天，天亮了，所有玩家请睁眼。`);
      if (['dawn', 'badge.transfer', 'badge.tear'].includes(e.type)) judge(original.text);
      if (e.type === 'guard.protect' || e.type === 'guard.skip') {
        cue(original, 'guard-open', '守卫请睁眼，请选择今晚守护的玩家，也可以空守。');
        if (roleSeat && !d.systemFallback) cue(original, 'guard-choice', e.type === 'guard.skip' ? '今晚空守。' : `我守护${d.target}号。`, roleSeat, { target: d.target });
        judge(`${e.type === 'guard.skip' ? '确认空守' : `确认守护${d.target}号`}。守卫请闭眼。`);
      }
      if (e.type === 'wolf.chat' && !wolfOpened) {
        cue(original, 'wolves-open', '狼人请睁眼，确认同伴。请商量今晚的击杀目标。');
        wolfOpened = true;
      }
      if (e.type === 'wolf.kill.result') {
        if (!wolfOpened) cue(original, 'wolves-open', '狼人请睁眼。');
        cue(original, 'wolves-vote', '狼人请确认今晚的击杀目标。');
        judge(`${typeof d.knife === 'number' ? `确认刀口${d.knife}号` : '确认今晚空刀'}。狼人请闭眼。`);
      }
      if (e.type === 'seer.result' || e.type === 'seer.skip') {
        cue(original, 'seer-open', '预言家请睁眼，请选择今晚要查验的一名玩家。');
        if (roleSeat && !d.systemFallback) cue(original, 'seer-choice', e.type === 'seer.skip' ? '本夜不查验。' : `我查验${d.target}号。`, roleSeat, { target: d.target });
        judge(`${e.type === 'seer.skip' ? '本夜没有查验' : `你查验的${d.target}号是${d.result === 'wolf' ? '狼人' : '好人'}`}。预言家请闭眼。`);
      }
      if (e.type === 'witch.knife') {
        // Only the recorded knife notification authorizes revealing a target to the witch.
        judge(`女巫请睁眼。${typeof d.knife === 'number' ? `今晚被狼人袭击的是${d.knife}号，是否使用解药` : '今晚没有刀口'}？你也可以选择使用毒药，或不用药。`);
      }
      if (['witch.save', 'witch.poison', 'witch.idle'].includes(e.type)) {
        const knifeKnown = source.events.some((f) => f.day === chapter.day && f.sourceSeq < e!.sourceSeq && f.type === 'witch.knife');
        if (!knifeKnown) cue(original, 'witch-open', '女巫请睁眼，请决定今晚是否使用剩余药剂。');
        if (roleSeat && !d.systemFallback) cue(original, 'witch-choice', e.type === 'witch.save' ? `我用解药救${d.target}号。` : e.type === 'witch.poison' ? `我用毒药毒${d.target}号。` : '今晚不用药。', roleSeat, { target: d.target });
        judge(`${e.type === 'witch.save' ? `确认对${d.target}号使用解药` : e.type === 'witch.poison' ? `确认对${d.target}号使用毒药` : '确认不用药'}。女巫请闭眼。`);
      }
      if (e.type === 'sheriff.start') judge('现在开始警长竞选，有意竞选警长的玩家请上警。');
      if (e.type === 'sheriff.signup') judge(`上警的玩家有${seats(d.candidates ?? [])}。`);
      if (e.type === 'sheriff.order') judge(`警上发言从${d.order?.[0]}号开始，${d.direction === 'counterclockwise' ? '逆时针' : '顺时针'}依次发言。`);
      let skipOrderRepeat = false;
      if (e.type === 'speech.order') {
        const direction = d.direction === 'counterclockwise' ? '逆时针' : '顺时针';
        if (prior.sheriff) {
          cue(original, 'sheriff-ask', `请${prior.sheriff}号警长选择发言方向。`);
          if (!d.systemFallback) {
            cue(original, 'sheriff-choice', `我选${direction}，从${d.order?.[0]}号开始。`, prior.sheriff);
            skipOrderRepeat = true;
          }
        }
        judge(`从${d.order?.[0]}号开始，${direction}依次发言。${prior.sheriff ? `${prior.sheriff}号警长最后发言。` : ''}`);
      }
      if (e.type === 'vote.result') {
        cue(original, 'vote-open', `${d.round > 1 ? 'PK发言结束。' : '发言结束。'}现在进行${d.kind === 'sheriff' ? '警长投票，请有投票资格的玩家投给支持的候选人' : '放逐投票，请有投票资格的存活玩家选择放逐目标'}。三、二、一，请投票。`, undefined, { kind: d.kind });
        judge(`投票结果：${(d.rows ?? []).map((r: any) => `${r.target}号${r.weight}票`).join('，') || '没有有效票'}。${d.abstain?.length ? `${seats(d.abstain)}弃票。` : ''}${d.conclusion ?? ''}`);
      }
      if (!skipOrderRepeat) entries.push(e);
      entries.push(...editedEntries.filter((comment) => comment.sourceSeq === original.sourceSeq && comment.data.editorialAfter));
    }
    return { ...chapter, entries };
  });
  return { ...edited, chapters };
}
