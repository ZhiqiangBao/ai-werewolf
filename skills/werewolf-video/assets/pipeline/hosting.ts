import type { Entry, Script } from './project';
import { replay } from './replay';
import { videoText } from './video-locale';

const required = new Set(['phase', 'witch.knife', 'witch.idle', 'sheriff.start', 'sheriff.order', 'speech.order', 'vote.result', 'dawn', 'badge.transfer', 'badge.tear']);
const copiedSkillName: Record<string, string> = { awakened_poison: '模仿毒药', awakened_guard: '增强守护', awakened_claw: '额外爪击' };

/** 行动转述只使用已记录的动作；完整性校验也以此规则核对。 */
export function hostingChoice(locale: string, type: string, data: Record<string, any>): string | undefined {
  const t = (key: string, ...args: unknown[]) => videoText(locale, key, ...args);
  switch (type) {
    case 'guard.protect': return t('我守护{0}号。', data.target);
    case 'guard.skip': return t('今晚空守。');
    case 'seer.result': return t('我查验{0}号。', data.target);
    case 'seer.skip': return t('本夜不查验。');
    case 'witch.save': return t('我用解药救{0}号。', data.target);
    case 'witch.poison': return t('我用毒药毒{0}号。', data.target);
    case 'witch.idle': return t('今晚不用药。');
    case 'speech.order': return t('我选{0}，从{1}号开始。', t(data.direction === 'counterclockwise' ? '逆时针' : '顺时针'), data.order?.[0]);
    case 'awakened.mimic': return typeof data.target === 'number' ? t('我模仿{0}号。', data.target) : undefined;
    case 'awakened.wait':
    case 'awakened.skip':
    case 'mirror.skip': return t('本夜不发动技能。');
    case 'awakened.skill': {
      const name = copiedSkillName[data.tool];
      return name && typeof data.target === 'number' ? t('我使用{0}，目标是{1}号。', t(name), data.target) : undefined;
    }
    case 'mirror.result': return typeof data.target === 'number' ? t('我使用{0}，目标是{1}号。', t('模仿魔镜'), data.target) : undefined;
    case 'awakened.knife':
      if (!Object.prototype.hasOwnProperty.call(data, 'target')) return undefined;
      return data.target === null ? t('我今晚空刀。') : typeof data.target === 'number' ? t('我今晚刀{0}号。', data.target) : undefined;
    default: return undefined;
  }
}

export function wolfSeatLine(locale: string, target: unknown): string | undefined {
  const t = (key: string, ...args: unknown[]) => videoText(locale, key, ...args);
  if (target === null) return t('我今晚空刀。');
  return typeof target === 'number' ? t('我今晚刀{0}号。', target) : undefined;
}

/** Presentation cues reconstruct recorded actions; the immutable fact stream is never extended. */
export function completeHosting(source: Script, edited: Script): Script {
  const locale = source.locale ?? 'zh-CN';
  const t = (key: string, ...args: unknown[]) => videoText(locale, key, ...args);
  const seats = (values: number[]) => values.map((n) => t('{0}号', n)).join(t('、'));
  const editedEntries = edited.chapters.flatMap((c) => c.entries);
  const bySeq = new Map(editedEntries.filter((e) => !e.data.editorialAfter).map((e) => [e.sourceSeq, e]));
  const chapters = source.chapters.map((chapter) => {
    const entries: Entry[] = [];
    let wolfOpened = false;
    const cue = (anchor: Entry, key: string, text: string, seat?: number, data: Record<string, unknown> = {}, speaker?: string) => {
      entries.push({ sourceSeq: anchor.sourceSeq, type: seat === undefined ? 'hosting.judge' : 'hosting.choice',
        speaker: seat === undefined ? '法官' : (speaker ?? `${seat}号`), voiceKey: seat === undefined ? 'judge' : `seat-${seat}`,
        ...(seat === undefined ? {} : { seat }), text, visibility: anchor.visibility,
        data: { presentationOnly: true, presentationKey: key, replayThrough: anchor.sourceSeq - 1,
          provenance: seat === undefined ? '流程衔接' : '按该事件记录的行动转述，非玩家原话', ...data } });
    };
    const fallen = (data: Record<string, any>) => new Set<number>(Array.isArray(data.fallbackSeats) ? data.fallbackSeats.filter((seat: unknown) => typeof seat === 'number') : []);
    const summary = (seat: number, kind: 'kill' | 'pass', target?: unknown) => kind === 'kill'
      ? (target === null ? t('系统托管，{0}号今晚空刀。', seat) : typeof target === 'number' ? t('系统托管，{0}号的攻击目标记为{1}号。', seat, target) : undefined)
      : t('系统托管，{0}号本夜不发动技能。', seat);
    for (const original of chapter.entries) {
      let e = bySeq.get(original.sourceSeq) ?? (required.has(original.type) ? original : undefined);
      if (!e) { entries.push(...editedEntries.filter((comment) => comment.sourceSeq === original.sourceSeq && comment.data.editorialAfter)); continue; }
      const d = original.data, prior = replay(source, original.sourceSeq - 1);
      const actor = source.events.find((f) => f.sourceSeq === original.sourceSeq)?.audience;
      const roleSeat = Array.isArray(actor) && actor.length === 1 ? actor[0] : undefined;
      const judge = (text: string) => { e = { ...e!, text, voiceKey: 'judge', speaker: '法官' }; };
      if (e.type === 'phase') judge(t(chapter.phase === 'night' ? '第{0}夜，天黑请闭眼。' : '第{0}天，天亮了，所有玩家请睁眼。', chapter.day));
      if (['dawn', 'badge.transfer', 'badge.tear'].includes(e.type)) judge(original.text);
      if (e.type === 'guard.protect' || e.type === 'guard.skip') {
        cue(original, 'guard-open', t('守卫请睁眼，请选择今晚守护的玩家，也可以空守。'));
        if (roleSeat && !d.systemFallback) cue(original, 'guard-choice', hostingChoice(locale, e.type, d)!, roleSeat, { target: d.target });
        judge(t(e.type === 'guard.skip' ? '确认空守。守卫请闭眼。' : '确认守护{0}号。守卫请闭眼。', d.target));
      }
      if (e.type === 'wolf.chat' && !wolfOpened) {
        cue(original, 'wolves-open', t('狼人请睁眼，确认同伴。请商量今晚的击杀目标。'));
        wolfOpened = true;
      }
      if (e.type === 'wolf.kill.result' || e.type === 'awakened.knife') {
        const automatic = fallen(d);
        if (!wolfOpened) cue(original, 'wolves-open', t('狼人请睁眼，请提交今晚的攻击目标。'));
        wolfOpened = true;
        if (e.type === 'awakened.knife') {
          const line = hostingChoice(locale, e.type, d);
          const backed = roleSeat !== undefined && (d.systemFallback || automatic.has(roleSeat));
          if (backed) {
            const text = summary(roleSeat, 'kill', d.target);
            if (text) cue(original, 'wolf-summary', text, undefined, { actionSummary: true });
          } else if (roleSeat && line) {
            cue(original, 'wolf-choice', line, roleSeat, { target: d.target }, t('觉醒隐狼'));
          }
        } else {
          for (const pick of Array.isArray(d.picks) ? d.picks : []) {
            if (!Array.isArray(pick) || typeof pick[0] !== 'number') continue;
            const [seat, target] = pick as [number, number | null];
            if (automatic.has(seat)) {
              const text = summary(seat, 'kill', target);
              if (text) cue(original, `wolf-summary-${seat}`, text, undefined, { actionSummary: true });
              continue;
            }
            const line = wolfSeatLine(locale, target);
            if (!line) continue;
            const awakened = source.cast.find((player) => player.seat === seat)?.role === 'awakened_wolf';
            cue(original, `wolf-choice-${seat}`, line, seat, { target }, awakened ? t('觉醒隐狼') : t('{0}号狼人', seat));
          }
        }
        judge(t('狼人请闭眼。'));
      }
      if (d.round?.roundKind === 'awakened' && ['awakened.mimic', 'awakened.wait', 'awakened.skill', 'awakened.skip', 'mirror.result', 'mirror.skip'].includes(e.type)) {
        const automatic = fallen(d);
        const backed = roleSeat !== undefined && (d.systemFallback || automatic.has(roleSeat));
        cue(original, 'awakened-open', t('觉醒隐狼请睁眼。'));
        cue(original, 'awakened-prompt', t('觉醒隐狼请提交本夜行动。'));
        const line = hostingChoice(locale, e.type, d);
        if (backed && roleSeat !== undefined) {
          const text = summary(roleSeat, 'pass');
          if (text) cue(original, 'awakened-summary', text, undefined, { actionSummary: true });
        } else if (roleSeat && line) cue(original, 'awakened-choice', line, roleSeat, { target: d.target }, t('觉醒隐狼'));
        judge(t('觉醒隐狼请闭眼。'));
      }
      if (e.type === 'seer.result' || e.type === 'seer.skip') {
        cue(original, 'seer-open', t('预言家请睁眼，请选择今晚要查验的一名玩家。'));
        if (roleSeat && !d.systemFallback) cue(original, 'seer-choice', hostingChoice(locale, e.type, d)!, roleSeat, { target: d.target });
        judge(e.type === 'seer.skip' ? t('本夜没有查验。预言家请闭眼。') : t('你查验的{0}号是{1}。预言家请闭眼。', d.target, t(d.result === 'wolf' ? '查验结果：狼人' : '查验结果：好人')));
      }
      if (e.type === 'witch.knife') {
        // Only the recorded knife notification authorizes revealing a target to the witch.
        judge(t(typeof d.knife === 'number' ? '女巫请睁眼。今晚被狼人袭击的是{0}号，是否使用解药？你也可以选择使用毒药，或不用药。' : '女巫请睁眼。今晚没有刀口？你也可以选择使用毒药，或不用药。', d.knife));
      }
      if (['witch.save', 'witch.poison', 'witch.idle'].includes(e.type)) {
        const knifeKnown = source.events.some((f) => f.day === chapter.day && f.sourceSeq < e!.sourceSeq && f.type === 'witch.knife');
        if (!knifeKnown) cue(original, 'witch-open', t('女巫请睁眼，请决定今晚是否使用剩余药剂。'));
        if (roleSeat && !d.systemFallback) cue(original, 'witch-choice', hostingChoice(locale, e.type, d)!, roleSeat, { target: d.target });
        judge(t(e.type === 'witch.save' ? '确认对{0}号使用解药。女巫请闭眼。' : e.type === 'witch.poison' ? '确认对{0}号使用毒药。女巫请闭眼。' : '确认不用药。女巫请闭眼。', d.target));
      }
      if (e.type === 'sheriff.start') judge(t('现在开始警长竞选，有意竞选警长的玩家请上警。'));
      if (e.type === 'sheriff.signup') judge(t('上警的玩家有{0}。', seats(d.candidates ?? [])));
      if (e.type === 'sheriff.order') judge(t('警上发言从{0}号开始，{1}依次发言。', d.order?.[0], t(d.direction === 'counterclockwise' ? '逆时针' : '顺时针')));
      let skipOrderRepeat = false;
      if (e.type === 'speech.order') {
        const direction = t(d.direction === 'counterclockwise' ? '逆时针' : '顺时针');
        if (prior.sheriff) {
          cue(original, 'sheriff-ask', t('请{0}号警长选择发言方向。', prior.sheriff));
          if (!d.systemFallback) {
            cue(original, 'sheriff-choice', hostingChoice(locale, e.type, d)!, prior.sheriff);
            skipOrderRepeat = true;
          }
        }
        judge(t('从{0}号开始，{1}依次发言。', d.order?.[0], direction) + (prior.sheriff ? t('{0}号警长最后发言。', prior.sheriff) : ''));
      }
      if (e.type === 'vote.result') {
        cue(original, 'vote-open', t(d.round > 1 ? 'PK发言结束。' : '发言结束。') + t(d.kind === 'sheriff' ? '现在进行警长投票，请有投票资格的玩家投给支持的候选人。三、二、一，请投票。' : '现在进行放逐投票，请有投票资格的存活玩家选择放逐目标。三、二、一，请投票。'), undefined, { kind: d.kind });
        judge(t('投票结果：{0}。', (d.rows ?? []).map((r: any) => t('{0}号{1}票', r.target, r.weight)).join(t('，')) || t('没有有效票')) + (d.abstain?.length ? t('{0}弃票。', seats(d.abstain)) : '') + (d.conclusion ?? ''));
      }
      if (!skipOrderRepeat) entries.push(e);
      entries.push(...editedEntries.filter((comment) => comment.sourceSeq === original.sourceSeq && comment.data.editorialAfter));
    }
    return { ...chapter, entries };
  });
  return { ...edited, chapters };
}
