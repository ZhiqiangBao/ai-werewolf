import type { Script } from './project';
export interface NarrationEdit { omit?: boolean; text?: string; voiceKey?: string; reason: string }
export function draftNarration(script: Script) {
  const edits: Record<string, NarrationEdit> = {};
  const wolf = (seat: number) => /狼/.test(script.cast.find((c) => c.seat === seat)?.factionName ?? '');
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
      say(event.phase === 'night' ? `进入第${event.day}夜。` : `第${event.day}天，天亮。`, '昼夜章节转场');
    } else if (['witch.knife', 'witch.idle', 'sheriff.withdraw', 'game.decided'].includes(e.type)) omit('信息已由行动、玩家原话或下一条播报表达，画面仍保留事实');
    else if (e.type === 'sheriff.start' && all.some((a) => a.sourceSeq > e.sourceSeq && a.type === 'sheriff.signup')) omit('合并到上警名单');
    else if (e.type === 'sheriff.signup') say(`警长竞选开始。${(d.candidates ?? []).map((n: number) => `${n}号`).join('、')}上警。`, '只读上警者，警下名单显示在画面');
    else if (e.type === 'sheriff.order' || e.type === 'speech.order') {
      const order = d.order ?? []; say(`从${order[0]}号开始，${d.direction === 'counterclockwise' ? '逆时针' : '顺时针'}发言。`, '保留方向与起点，不逐个点名');
    } else if (e.type === 'wolf.kill.result') say(typeof d.knife === 'number' ? `狼队选择刀${d.knife}号。` : '狼队今晚空刀。', '投刀明细由票型图承担');
    else if (e.type === 'vote.result') {
      const rows = (d.rows ?? []).slice(0, 3).map((r: any) => `${r.target}号${r.weight}票`).join('，');
      let comment = '';
      if (d.kind === 'sheriff' && d.outcome === 'elected' && wolf(d.seat)) comment = '警徽落在了狼队手里。';
      if (d.kind === 'exile' && d.outcome === 'exile' && role(d.seat) === 'seer') comment = '真预言家出局，后面要回头看发言和票型了。';
      say(`${rows}。${d.conclusion ?? ''}${comment}`, '读主要票数与结果，完整投票人显示在图中', !!comment);
    } else if (e.type === 'badge.transfer') say(`${d.from}号把警徽交给${d.to}号。${wolf(d.to) ? '警徽仍在狼队手里。' : ''}`, '警徽归属变化', wolf(d.to));
    else if (e.type === 'witch.poison' && wolf(d.target)) say(`${e.text}这瓶毒药命中了狼人。`, '只依据真实身份点出用药效果', true);
    else if (e.type === 'dawn') {
      const event = script.events.find((f) => f.sourceSeq === e.sourceSeq)!;
      const resolution = script.events.findLast((f) => f.sourceSeq < e.sourceSeq && f.type === 'night.resolution' && f.day === event.day);
      const guarded = resolution?.data.rows?.find((r: any) => r.blocked && r.blockers?.includes('guard'));
      if (guarded) say(`${e.text}守卫守中${guarded.target}号，挡住了狼刀。`, '结算后解释实际守护效果', true);
    } else if (e.type === 'review') {
      const nights = script.chapters.filter((c) => c.phase === 'night').length;
      say(`本局经过${nights}个夜晚，${script.result?.winnerName ?? '胜利阵营'}获胜。身份、票型与各夜行动已经保留在画面和完整记录中。`, '简明收束，不重复朗读整份复盘', true);
    }
  }
  return { roomId: script.roomId, policy: '默认完整保留玩家原话；法官去重；上帝点评仅依据已经发生的事实。', edits };
}
