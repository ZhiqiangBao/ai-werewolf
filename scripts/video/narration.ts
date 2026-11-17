import { getRole } from '../../packages/engine/src/index';
import type { Script } from './project';
export interface NarrationEdit { omit?: boolean; text?: string; voiceKey?: string; reason: string; after?: { text: string; reason: string }[] }
export function draftNarration(script: Script) {
  const edits: Record<string, NarrationEdit> = {};
  if (script.perspective === 'player') return { roomId: script.roomId, playerSeat: script.playerSeat, policy: '仅朗读座位可见的原始记录，不添加自由解说。', edits };
  const wolf = (seat: number) => { const cast = script.cast.find((c) => c.seat === seat); return !!cast && getRole(cast.role).faction === 'wolf'; };
  const role = (seat: number) => script.cast.find((c) => c.seat === seat)?.role;
  const all = script.chapters.flatMap((c) => c.entries);
  for (const e of all) {
    if (e.seat !== undefined) continue;
    const d = e.data;
    const omit = (reason: string) => { edits[e.sourceSeq] = { omit: true, reason }; };
    const say = (text: string, reason: string, commentary = false) => { edits[e.sourceSeq] = { text, reason, ...(commentary ? { voiceKey: 'commentator' } : {}) }; };
    if (e.type === 'game.start') say(`${script.presetName}，上帝视角。先看本局身份，再进入对局。`, '简短交代板型和视角', true);
    else if (e.type === 'phase') {
      const event = script.events.find((f) => f.sourceSeq === e.sourceSeq)!;
      say(event.phase === 'night' ? `第${event.day}夜，天黑请闭眼。` : `第${event.day}天，天亮了，所有玩家请睁眼。`, '昼夜章节转场');
    } else if (['sheriff.withdraw', 'game.decided'].includes(e.type)) omit('与紧邻的公开表达重复，画面仍保留事实');
    else if (e.type === 'sheriff.signup') say(`警长竞选开始。${(d.candidates ?? []).map((n: number) => `${n}号`).join('、')}上警。`, '只读上警者，警下名单显示在画面');
    else if (e.type === 'sheriff.order' || e.type === 'speech.order') {
      const order = d.order ?? []; say(`从${order[0]}号开始，${d.direction === 'counterclockwise' ? '逆时针' : '顺时针'}发言。`, '保留方向与起点，不逐个点名');
    } else if (e.type === 'wolf.kill.result') say(typeof d.knife === 'number' ? `狼队选择刀${d.knife}号。` : '狼队今晚空刀。', '投刀明细由票型图承担');
    else if (e.type === 'vote.result') {
      const rows = (d.rows ?? []).slice(0, 3).map((r: any) => `${r.target}号${r.weight}票`).join('，');
      let comment = '';
      if (d.kind === 'sheriff' && d.outcome === 'elected' && wolf(d.seat)) comment = '警徽落在了狼队手里。';
      if (d.kind === 'exile' && d.outcome === 'exile' && role(d.seat) === 'seer') comment = '真预言家出局，后面要回头看发言和票型了。';
      say(`${rows}。${d.conclusion ?? ''}`, '法官先公布票数和结果');
      if (comment) edits[e.sourceSeq].after = [{ text: comment, reason: '结果公布后再由上帝解释已经发生的转折' }];
    } else if (e.type === 'badge.transfer') {
      say(`${d.from}号把警徽交给${d.to}号。`, '法官交代警徽归属变化');
      if (wolf(d.to)) edits[e.sourceSeq].after = [{ text: '警徽仍在狼队手里。', reason: '移交完成后依据真实身份解释阵营归属' }];
    } else if (e.type === 'witch.poison' && wolf(d.target)) {
      say(e.text, '保留用毒确认');
      edits[e.sourceSeq].after = [{ text: '这瓶毒药命中了狼人。', reason: '只依据该条已记录的目标与真实身份点出用药对象' }];
    }
    else if (e.type === 'dawn') {
      const event = script.events.find((f) => f.sourceSeq === e.sourceSeq)!;
      const resolution = script.events.findLast((f) => f.sourceSeq < e.sourceSeq && f.type === 'night.resolution' && f.day === event.day);
      const guarded = resolution?.data.rows?.find((r: any) => r.kind === 'wolf' && r.blocked && r.blockers?.includes('guard'));
      if (guarded) {
        say(e.text, '法官先公布出局或平安夜');
        const guards = script.events.filter((f) => f.day === event.day && f.sourceSeq < e.sourceSeq && f.data.target === guarded.target && (f.type === 'guard.protect' || f.type === 'lucky.guard'));
        const roles = [...new Set(guards.map((f) => f.type === 'guard.protect' ? '守卫' : '幸运儿'))];
        const source = roles.join('和');
        const text = guarded.blockers.includes('antidote')
          ? `${guarded.target}号同时受到${source ? `${source}的` : ''}守护和解药保护，狼刀未造成出局。`
          : source ? `${source}守护${guarded.target}号，挡住了狼刀。` : `对${guarded.target}号的守护挡住了狼刀。`;
        edits[e.sourceSeq].after = [{ text, reason: '结算后根据记录的守护行动解释实际效果' }];
      }
    } else if (e.type === 'review') {
      const nights = script.chapters.filter((c) => c.phase === 'night').length;
      say(`本局经过${nights}个夜晚，${script.result?.winnerName ?? '胜利阵营'}获胜。身份、票型与各夜行动已经保留在画面和完整记录中。`, '简明收束，不重复朗读整份复盘', true);
    }
  }
  return { roomId: script.roomId, policy: '默认完整保留玩家原话；法官去重；上帝点评仅依据已经发生的事实。', edits };
}

/** Require actual authored narrative, rather than a reviewed copy of the generated draft. */
export function narrationWritingIssues(script: Script, narration: unknown): string[] {
  if (script.perspective === 'player') return [];
  const entries = script.chapters.flatMap((chapter) => chapter.entries);
  const opening = entries.find((entry) => entry.type === 'game.start');
  const ending = entries.find((entry) => entry.type === 'review');
  if (!opening || !ending) return ['完整上帝稿缺少开场或终局锚点'];
  if (!narration || typeof narration !== 'object' || Array.isArray(narration)) return ['缺少完整上帝解说稿'];
  const edits = (narration as { edits?: Record<string, NarrationEdit> }).edits;
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) return ['缺少完整上帝解说稿 edits'];
  const template = draftNarration(script).edits;
  const changedText = (seq: number) => {
    const edit = edits[String(seq)];
    return edit?.omit !== true && edit?.voiceKey === 'commentator' && typeof edit.text === 'string' && !!edit.text.trim() && edit.text.trim() !== template[String(seq)]?.text?.trim();
  };
  const commentary = Object.entries(edits).some(([seq, edit]) => {
    const anchor = entries.find((entry) => String(entry.sourceSeq) === seq);
    if (!edit || !anchor || anchor.seat !== undefined || seq === String(opening.sourceSeq) || seq === String(ending.sourceSeq)) return false;
    const before = template[seq];
    return (Array.isArray(edit.after) ? edit.after : []).some((item) => typeof item?.text === 'string' && !!item.text.trim() && !(before?.after ?? []).some((original) => original.text.trim() === item.text.trim())) ||
      (edit.omit !== true && edit.voiceKey === 'commentator' && typeof edit.text === 'string' && !!edit.text.trim() && edit.text.trim() !== before?.text?.trim());
  });
  const issues: string[] = [];
  if (!changedText(opening.sourceSeq)) issues.push('请针对本局实际撰写开场，不能仅审核模板');
  if (!commentary) issues.push('请结合本局原话和事实，在转折锚点撰写过程点评');
  if (!changedText(ending.sourceSeq)) issues.push('请针对本局实际撰写终局收尾，不能仅审核模板');
  return issues;
}

/** Check that the authored words actually survive hosting and use the commentator voice. */
export function narrationSpokenIssues(source: Script, narration: { edits: Record<string, NarrationEdit> }, spoken: Script): string[] {
  const entries = source.chapters.flatMap((c) => c.entries);
  const actual = spoken.chapters.flatMap((c) => c.entries);
  const template = draftNarration(source).edits;
  const opening = entries.find((entry) => entry.type === 'game.start');
  const ending = entries.find((entry) => entry.type === 'review');
  if (!opening || !ending) return ['完整上帝稿缺少开场或终局锚点'];
  const read = (seq: number, text: unknown) => typeof text === 'string' && actual.some((entry) => entry.sourceSeq === seq && entry.voiceKey === 'commentator' && entry.text === text);
  const issues: string[] = [];
  if (!read(opening.sourceSeq, narration.edits[String(opening.sourceSeq)]?.text)) issues.push('撰写的开场没有作为上帝解说实际发声');
  if (!read(ending.sourceSeq, narration.edits[String(ending.sourceSeq)]?.text)) issues.push('撰写的收尾没有作为上帝解说实际发声');
  const commentary = entries.some((entry) => {
    if (entry.seat !== undefined || entry.sourceSeq === opening.sourceSeq || entry.sourceSeq === ending.sourceSeq) return false;
    const edit = narration.edits[String(entry.sourceSeq)], before = template[String(entry.sourceSeq)];
    if (!edit) return false;
    const after = Array.isArray(edit.after) ? edit.after : [];
    return after.some((item) => typeof item?.text === 'string' && item.text.trim() && !(before?.after ?? []).some((old) => old.text.trim() === item.text.trim()) && read(entry.sourceSeq, item.text)) ||
      (edit.voiceKey === 'commentator' && edit.omit !== true && typeof edit.text === 'string' && edit.text.trim() !== before?.text?.trim() && read(entry.sourceSeq, edit.text));
  });
  if (!commentary) issues.push('撰写的转折点评没有作为上帝解说实际发声');
  return issues;
}
