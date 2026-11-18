import type { Entry, Script } from './project';
import { replay } from './replay';
import { videoText } from './video-locale';

export const hostingRevision = 'recorded-seat-choices-v2';
const witchFirst = new Set(['witch.save', 'witch.no_save']);
const witchLast = new Set(['witch.poison', 'witch.no_poison']);
const required = new Set(['phase', 'witch.knife', 'witch.targets', ...witchFirst, ...witchLast, 'witch.idle', 'sheriff.start', 'sheriff.order', 'speech.order', 'vote.result', 'dawn', 'badge.transfer', 'badge.tear']);
const merchantActions = new Set(['merchant.gift', 'merchant.wait']);
const luckyActions = new Set(['lucky.inspect', 'lucky.poison', 'lucky.guard', 'lucky.skip']);
const giftSkillName: Record<string, string> = { seer: '查验', poison: '毒药', guard: '守护' };
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
    case 'merchant.wait': return t('今晚先等等，保留交易机会。');
    case 'merchant.gift': return typeof data.target === 'number' && giftSkillName[data.skill]
      ? t('我把{0}送给{1}号。', t(giftSkillName[data.skill]), data.target) : undefined;
    case 'lucky.skip': return giftSkillName[data.skill] ? t('我先留着{0}。', t(giftSkillName[data.skill])) : t('本夜不发动技能。');
    case 'lucky.inspect': return typeof data.target === 'number' ? t('我用查验看{0}号。', data.target) : undefined;
    case 'lucky.poison': return typeof data.target === 'number' ? t('我用毒药毒{0}号。', data.target) : undefined;
    case 'lucky.guard': return typeof data.target === 'number' ? t('我守护{0}号。', data.target) : undefined;
    case 'hunter.shot':
    case 'wolf_king.shot':
    case 'shot': return typeof data.target === 'number' ? t('我对{0}号开枪。', data.target) : undefined;
    case 'hunter.decline':
    case 'wolf_king.decline': return t('我放弃开枪。');
    case 'badge.transfer': return typeof data.to === 'number' ? t('我把警徽交给{0}号。', data.to) : undefined;
    case 'badge.tear': return data.badgeDecision === true ? t('我撕掉警徽。') : undefined;
    case 'sheriff.withdraw': return t('我退水。');
    case 'explode': return t('我自爆。');
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
  const separator = locale === 'en' ? ' ' : '';
  const seats = (values: number[]) => values.map((n) => t('{0}号', n)).join(t('、'));
  const editedEntries = edited.chapters.flatMap((c) => c.entries);
  const bySeq = new Map(editedEntries.filter((e) => !e.data.editorialAfter).map((e) => [e.sourceSeq, e]));
  const facts = new Map(source.events.map((fact) => [fact.sourceSeq, fact]));
  const seatFor = (entry?: Entry) => {
    const fact = entry && facts.get(entry.sourceSeq);
    return fact?.type === entry?.type && Array.isArray(fact?.audience) && fact.audience.length === 1 ? fact.audience[0] : undefined;
  };
  const automatic = (entry: Entry, seat: number | undefined) => {
    const recorded = facts.get(entry.sourceSeq)?.data;
    return entry.data.systemFallback === true || recorded?.systemFallback === true ||
      (seat !== undefined && Array.isArray(recorded?.fallbackSeats) && recorded.fallbackSeats.includes(seat));
  };
  const chapters = source.chapters.map((chapter) => {
    const entries: Entry[] = [];
    const witchNotified = new Set<number>();
    let wolfOpened = false;
    const cue = (anchor: Entry, key: string, text: string, seat?: number, data: Record<string, unknown> = {}, speaker?: string) => {
      const fact = facts.get(anchor.sourceSeq);
      entries.push({ sourceSeq: anchor.sourceSeq, type: seat === undefined ? 'hosting.judge' : 'hosting.choice',
        speaker: seat === undefined ? '法官' : (speaker ?? `${seat}号`), voiceKey: seat === undefined ? 'judge' : `seat-${seat}`,
        ...(seat === undefined ? {} : { seat }), text, visibility: fact ? (fact.audience === 'public' ? 'public' : 'private') : anchor.visibility,
        data: { presentationOnly: true, presentationKey: key, replayThrough: anchor.sourceSeq - 1,
          provenance: seat === undefined ? '流程衔接' : '按该事件记录的行动转述，非玩家原话',
          ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) } });
    };
    const summary = (seat: number, kind: 'kill' | 'pass', target?: unknown) => kind === 'kill'
      ? (target === null ? t('系统托管，{0}号今晚空刀。', seat) : typeof target === 'number' ? t('系统托管，{0}号的攻击目标记为{1}号。', seat, target) : undefined)
      : t('系统托管，{0}号本夜不发动技能。', seat);
    for (const [index, original] of chapter.entries.entries()) {
      let e = bySeq.get(original.sourceSeq) ?? (required.has(original.type) ? original : undefined);
      const appendCommentary = () => entries.push(...editedEntries.filter((comment) => comment.sourceSeq === original.sourceSeq && comment.data.editorialAfter));
      if (!e) { appendCommentary(); continue; }
      const fact = facts.get(original.sourceSeq);
      const recorded = fact?.type === original.type;
      const d = recorded ? fact.data : original.data, roleSeat = seatFor(original);
      const previous = chapter.entries[index - 1], next = chapter.entries[index + 1];
      const judge = (text: string) => { e = { ...e!, text, voiceKey: 'judge', speaker: '法官' }; };
      const choice = (key: string, seat: number | undefined, text = hostingChoice(locale, original.type, d), data: Record<string, unknown> = { target: d.target }, speaker?: string) => {
        if (recorded && typeof seat === 'number' && Number.isInteger(seat) && seat > 0 && text && !automatic(original, seat)) cue(original, key, text, seat, data, speaker);
      };
      if (e.type === 'phase') judge(t(chapter.phase === 'night' ? '第{0}夜，天黑请闭眼。' : '第{0}天，天亮了，所有玩家请睁眼。', chapter.day));
      if (['dawn', 'badge.transfer', 'badge.tear'].includes(e.type)) judge(original.text);
      if (e.type === 'guard.protect' || e.type === 'guard.skip') {
        cue(original, 'guard-open', t('守卫请睁眼，请选择今晚守护的玩家，也可以空守。'));
        choice('guard-choice', roleSeat);
        judge(t(e.type === 'guard.skip' ? '确认空守。守卫请闭眼。' : '确认守护{0}号。守卫请闭眼。', d.target));
      }
      if (e.type === 'wolf.chat' && !wolfOpened) {
        cue(original, 'wolves-open', t('狼人请睁眼，确认同伴。请商量今晚的击杀目标。'));
        wolfOpened = true;
      }
      if (['wolf.kill.split', 'wolf.kill.result', 'awakened.knife'].includes(e.type)) {
        if (!wolfOpened) cue(original, 'wolves-open', t('狼人请睁眼，请提交今晚的攻击目标。'));
        wolfOpened = true;
        if (e.type === 'awakened.knife') {
          const line = hostingChoice(locale, e.type, d);
          const backed = roleSeat !== undefined && automatic(original, roleSeat);
          if (backed) {
            const text = summary(roleSeat, 'kill', d.target);
            if (text) cue(original, 'wolf-summary', text, undefined, { actionSummary: true });
          } else {
            choice('wolf-choice', roleSeat, line, { target: d.target }, t('觉醒隐狼'));
          }
        } else if (recorded) {
          for (const pick of Array.isArray(d.picks) ? d.picks : []) {
            if (!Array.isArray(pick) || typeof pick[0] !== 'number') continue;
            const [seat, target] = pick as [number, number | null];
            if (automatic(original, seat)) {
              const text = summary(seat, 'kill', target);
              if (text) cue(original, `wolf-summary-${seat}`, text, undefined, { actionSummary: true });
              continue;
            }
            const awakened = source.cast.find((player) => player.seat === seat)?.role === 'awakened_wolf';
            choice(`wolf-choice-${seat}`, seat, wolfSeatLine(locale, target), { target }, awakened ? t('觉醒隐狼') : t('{0}号狼人', seat));
          }
        }
        if (e.type !== 'wolf.kill.split') judge(t('狼人请闭眼。'));
      }
      if (d.round?.roundKind === 'awakened' && ['awakened.mimic', 'awakened.wait', 'awakened.skill', 'awakened.skip', 'mirror.result', 'mirror.skip'].includes(e.type)) {
        const backed = roleSeat !== undefined && automatic(original, roleSeat);
        cue(original, 'awakened-open', t('觉醒隐狼请睁眼。'));
        cue(original, 'awakened-prompt', t('觉醒隐狼请提交本夜行动。'));
        const line = hostingChoice(locale, e.type, d);
        if (backed && roleSeat !== undefined) {
          const text = summary(roleSeat, 'pass');
          if (text) cue(original, 'awakened-summary', text, undefined, { actionSummary: true });
        } else choice('awakened-choice', roleSeat, line, { target: d.target }, t('觉醒隐狼'));
        judge(t('觉醒隐狼请闭眼。'));
      } else if (e.type === 'mirror.result' || e.type === 'mirror.skip') {
        choice('mirror-choice', roleSeat, e.type === 'mirror.result' && typeof d.target === 'number'
          ? t('我用魔镜查验{0}号。', d.target) : hostingChoice(locale, e.type, d));
      }
      if (e.type === 'merchant.gift.received' && roleSeat !== undefined) {
        const skill = giftSkillName[d.skill];
        if (skill) judge(t('{0}号成为幸运儿，获得一次{1}。', roleSeat, t(skill)));
      }
      if (roleSeat !== undefined && (merchantActions.has(e.type) || luckyActions.has(e.type))) {
        const merchant = merchantActions.has(e.type);
        const key = merchant ? 'merchant' : 'lucky';
        cue(original, `${key}-open`, t(merchant ? '奇迹商人请睁眼。' : '幸运儿请睁眼。'));
        const line = hostingChoice(locale, e.type, d);
        choice(`${key}-choice`, roleSeat, line);
        const report = automatic(original, roleSeat) ? [t('系统托管。').trim(), original.text] : !line ? [original.text] : [];
        if (line && !automatic(original, roleSeat) && e.type === 'lucky.inspect' && (d.result === 'wolf' || d.result === 'good')) {
          report.push(t('查验结果是{0}。', t(d.result === 'wolf' ? '查验结果：狼人' : '查验结果：好人')));
        }
        judge([...report, t(merchant ? '奇迹商人请闭眼。' : '幸运儿请闭眼。')].join(separator));
      }
      if (e.type === 'seer.result' || e.type === 'seer.skip') {
        cue(original, 'seer-open', t('预言家请睁眼，请选择今晚要查验的一名玩家。'));
        choice('seer-choice', roleSeat);
        judge(e.type === 'seer.skip' ? t('本夜没有查验。预言家请闭眼。') : t('你查验的{0}号是{1}。预言家请闭眼。', d.target, t(d.result === 'wolf' ? '查验结果：狼人' : '查验结果：好人')));
      }
      if (e.type === 'witch.knife' || e.type === 'witch.targets') {
        // Announce only the attack information the witch actually received.
        const targets: number[] = e.type === 'witch.targets' && Array.isArray(d.targets) ? d.targets : typeof d.knife === 'number' ? [d.knife] : [];
        const notice = targets.length ? t('今晚受到狼人攻击的玩家：{0}。', seats(targets)) : t('今晚无人受到狼人攻击。');
        judge([t('女巫请睁眼。'), notice].join(separator));
        if (roleSeat !== undefined) witchNotified.add(roleSeat);
      }
      if (witchFirst.has(e.type) || witchLast.has(e.type) || e.type === 'witch.idle') {
        // One tool call writes two potion facts. Keep a used potion or one explicit pass.
        const save = roleSeat !== undefined && witchLast.has(e.type) && previous && witchFirst.has(previous.type) && seatFor(previous) === roleSeat ? previous : undefined;
        const poison = roleSeat !== undefined && witchFirst.has(e.type) && next && witchLast.has(next.type) && seatFor(next) === roleSeat ? next : undefined;
        if (e.type === 'witch.no_save' || (e.type === 'witch.no_poison' && save?.type !== 'witch.no_save')) {
          appendCommentary();
          continue;
        }
        if (roleSeat === undefined || !witchNotified.has(roleSeat)) {
          cue(original, 'witch-open', t('女巫请睁眼。'));
          if (roleSeat !== undefined) witchNotified.add(roleSeat);
        }
        const backed = automatic(original, roleSeat) || (save !== undefined && automatic(save, roleSeat));
        const line = e.type === 'witch.no_poison' ? t('今晚不用药。') : hostingChoice(locale, e.type, d);
        if (!backed) choice('witch-choice', roleSeat, line);
        const result = backed ? [t('系统托管。').trim(), ...(['witch.save', 'witch.poison'].includes(e.type) ? [original.text] : [])] : [];
        if (poison?.type === 'witch.poison') result.push(t('确认对{0}号使用解药。', d.target));
        else result.push(t('女巫请闭眼。'));
        judge(result.join(separator));
      }
      if (e.type === 'sheriff.start') judge(t('现在开始警长竞选，有意竞选警长的玩家请上警。'));
      if (e.type === 'sheriff.signup') {
        for (const seat of Array.isArray(d.candidates) ? d.candidates : []) {
          if (typeof seat === 'number') choice(`signup-choice-${seat}`, seat, t('我上警。'));
        }
        if (d.candidates?.length) judge(t('上警的玩家有{0}。', seats(d.candidates)));
      }
      if (e.type === 'sheriff.order') judge(t('警上发言从{0}号开始，{1}依次发言。', d.order?.[0], t(d.direction === 'counterclockwise' ? '逆时针' : '顺时针')));
      if (e.type === 'hunter.shot' || e.type === 'wolf_king.shot' || e.type === 'shot') choice('shot-choice', d.shooter);
      if (e.type === 'hunter.decline' || e.type === 'wolf_king.decline') {
        const actor = roleSeat ?? d.seat;
        const repeated = previous?.type === e.type && seatFor(previous) === actor && roleSeat === undefined;
        if (!repeated) choice('shot-choice', actor);
        if (roleSeat !== undefined && !automatic(original, roleSeat)) { appendCommentary(); continue; }
      }
      if (e.type === 'badge.transfer' || e.type === 'badge.tear') choice('badge-choice', d.from);
      if (e.type === 'sheriff.withdraw' || e.type === 'explode') choice('day-choice', d.seat);
      let skipOrderRepeat = false;
      if (e.type === 'speech.order') {
        const prior = replay(source, original.sourceSeq - 1);
        const direction = t(d.direction === 'counterclockwise' ? '逆时针' : '顺时针');
        if (prior.sheriff) {
          cue(original, 'sheriff-ask', t('请{0}号警长选择发言方向。', prior.sheriff));
          if (!automatic(original, prior.sheriff)) {
            choice('sheriff-choice', prior.sheriff);
            skipOrderRepeat = true;
          }
        }
        judge(t('从{0}号开始，{1}依次发言。', d.order?.[0], direction) + (prior.sheriff ? t('{0}号警长最后发言。', prior.sheriff) : ''));
      }
      if (e.type === 'vote.result') {
        cue(original, 'vote-open', t(d.round > 1 ? 'PK发言结束。' : '发言结束。') + t(d.kind === 'sheriff' ? '现在进行警长投票，请有投票资格的玩家投给支持的候选人。三、二、一，请投票。' : '现在进行放逐投票，请有投票资格的存活玩家选择放逐目标。三、二、一，请投票。'), undefined, { kind: d.kind });
        for (const ballot of Array.isArray(d.ballots) ? d.ballots : []) {
          if (typeof ballot?.voter !== 'number') continue;
          if (ballot.target === null) choice(`vote-choice-${ballot.voter}`, ballot.voter, t('我弃票。'));
          else if (typeof ballot.target === 'number') choice(`vote-choice-${ballot.voter}`, ballot.voter, t('我投{0}号。', ballot.target), { target: ballot.target });
        }
        judge(t('投票结果：{0}。', (d.rows ?? []).map((r: any) => t('{0}号{1}票', r.target, r.weight)).join(t('，')) || t('没有有效票')) + (d.abstain?.length ? t('{0}弃票。', seats(d.abstain)) : '') + (d.conclusion ?? ''));
      }
      if (!skipOrderRepeat) entries.push(e);
      appendCommentary();
    }
    return { ...chapter, entries };
  });
  return { ...edited, chapters };
}
