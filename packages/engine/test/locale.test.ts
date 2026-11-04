import { describe, expect, it } from 'vitest';
import { gameText, registerGameLanguage } from '@werewolf/protocol';
import { allPresets, buildRules, buildRuleCard, createGame, projectSeat, seatTools, submit, waitingSeats } from '../src/index';
import { makeRand, randomCall } from './random';

describe('对局语言', () => {
  it('缺省保持中文，注册语言可继承模板且不会替换参数里的玩家原话', () => {
    expect(buildRules('standard12').locale).toBe('zh-CN');
    registerGameLanguage({ id: 'en-GB', label: 'English UK', languageName: 'British English', speechLang: 'en-GB', ttsLanguageHints: ['en'], fallback: 'en', messages: { 发言: 'Speak (UK)' } });
    registerGameLanguage({ id: 'fr-FR', label: 'Français fallback', languageName: 'French', speechLang: 'fr-FR', ttsLanguageHints: ['fr'], fallback: 'en', messages: {} });
    expect(gameText('en-GB', '发言')).toBe('Speak (UK)');
    expect(gameText('fr-FR', '发言')).toBe('Speak');
    expect(gameText('en', 'toString')).toBe('toString');
    expect(gameText('en-GB', '{0}号', 3)).toBe('Player 3');
    expect(gameText('en', '法官：{0}{1}', '原话{1}', 'end')).toBe('Moderator: 原话{1}end');
    expect(() => buildRules('standard12', {}, { locale: 'unsupported' })).toThrow('Unsupported');
    expect(() => registerGameLanguage({ id: 'fr', label: 'Français', languageName: 'French', speechLang: 'fr-FR', ttsLanguageHints: ['fr'], fallback: 'en', messages: { '{0}号': 'Player' } })).toThrow('placeholders');
  });

  for (const preset of allPresets()) {
    it(`${preset.id} 的英语局覆盖规则、身份、动态问话和终局，日语使用同一规则分支`, () => {
      const english = buildRules(preset.id, {}, { locale: 'en' });
      const japanese = buildRules(preset.id, {}, { locale: 'ja' });
      expect(buildRuleCard(english)).not.toMatch(/[\u4e00-\u9fff]/);
      expect(buildRuleCard(japanese)).toContain('勝利');
      const rand = makeRand(518);
      let { state, events } = createGame({ id: 'locale', rules: english, seed: 'locale', names: english.roles.map((_, i) => `Name${i + 1}`) });
      let steps = 0;
      while (!state.result && steps++ < 2000) {
        const seat = waitingSeats(state)[0];
        const p = projectSeat(state, events, seat);
        expect(p.ruleCard + p.me!.appendix + p.task!.title + p.task!.prompt + JSON.stringify(p.task!.tools)).not.toMatch(/[\u4e00-\u9fff]/);
        const outcome = submit(state, { seat, call: randomCall(rand, state.pending!.tools[seat]) });
        const next = outcome.error ? submit(state, { seat, call: { tool: '', args: {} }, auto: true }) : outcome;
        state = next.state;
        events.push(...next.events);
        for (const event of next.events) {
          if (event.type !== 'speech' && event.type !== 'wolf.chat') expect(event.text, event.type).not.toMatch(/[\u4e00-\u9fff]/);
        }
      }
      expect(state.result).not.toBeNull();
    });
  }

  it('三语实际规则卡分别保留新旧判胜、竞选顺序与可达身份条件', () => {
    const wording = {
      'zh-CN': {
        newVictory: '每次确认新的出局后，先判定胜负',
        oldVictory: '先处理本次出局触发的技能及其引发的后续出局，再判定胜负',
        newHunter: '若猎枪造成你的出局，且胜负未分、枪仍可用',
        oldHunter: '开枪条件与猎人规则相同；若胜负已分，不再发动开枪技能',
        legacyHunter: '学习夜天亮出局时，开枪条件与猎人规则相同',
        chainLastWords: '连续开枪时，被枪带走玩家的遗言资格按第一枪触发的出局情形确定',
        electionLater: '警长选举结束或被自爆中断后，才通报昨夜出局结算情况并判定胜负',
        electionEarlier: '先通报昨夜出局结算情况并判定胜负，胜负未分才处理出局技能',
        electionLaterLegacy: '警长选举结束或被自爆中断后，才通报昨夜出局结算情况并处理出局职责',
        electionEarlierLegacy: '先通报昨夜出局结算情况并处理出局职责',
        announcedExplosion: '若警长竞选自爆时昨夜出局结算情况尚未通报，法官先通报夜间出局',
        legacyExplosionLastWords: '胜负未分时，由有遗言资格的自爆者和夜间出局者按本局规则遗言，随后入夜',
        postponedCandidateSpeech: '续选时保留未退出且仍存活的原候选人，候选人多于一名时重新进行竞选发言',
        nightPending: '被狼人选为攻击目标不等于已经出局',
        idiot: '首次被放逐时翻牌并留在场上；之后再次被放逐才出局',
      },
      en: {
        newVictory: 'Check victory after each newly confirmed elimination',
        oldVictory: 'Resolve abilities triggered by the current eliminations and any further eliminations they cause before checking victory',
        newHunter: 'If a Hunter shot eliminates you, and victory is undecided and your shot remains available',
        oldHunter: 'shooting follows the Hunter rules; if victory is decided, the ability is not triggered',
        legacyHunter: 'shooting follows the Hunter rules',
        chainLastWords: 'During consecutive shots, the last-word eligibility of each shot victim follows the elimination circumstance that triggered the first shot',
        electionLater: "Only after the Sheriff election ends or is interrupted by a reveal, announce last night's elimination results and check victory",
        electionEarlier: "Announce last night's elimination results and check victory; resolve elimination abilities only if no winner is decided",
        electionLaterLegacy: "Only after the Sheriff election ends or is interrupted by a reveal, announce last night's elimination results and resolve elimination duties",
        electionEarlierLegacy: "Announce last night's elimination results and resolve elimination duties first",
        announcedExplosion: "If a wolf reveals during the Sheriff election while last night's elimination results remain unannounced",
        legacyExplosionLastWords: 'If victory remains undecided, eligible revealers and night-eliminated players give last words according to this match\'s rules before nightfall.',
        postponedCandidateSpeech: 'keep the original candidates who have not withdrawn and remain alive. Repeat campaign speeches only if more than one candidate remains.',
        nightPending: "Being chosen as the wolves' attack target does not itself mean a player is eliminated",
        idiot: 'On the first exile, the Idiot reveals their role and stays in play; a later exile eliminates them',
      },
      ja: {
        newVictory: '新たな脱落を確定するたびに、先に勝敗を判定する',
        oldVictory: '今回の脱落で発動する能力と、それによって起きる追加の脱落を処理してから勝敗を判定する',
        newHunter: '猟師の射撃で脱落し、勝敗未決着で射撃権が残っていれば',
        oldHunter: '勝敗が決まっていれば能力は発動しない',
        legacyHunter: '射撃条件は猟師の規則に従う',
        chainLastWords: '連続射撃時、撃たれた者の遺言資格は最初の射撃を発生させた脱落状況に従う',
        electionLater: '警長選挙の終了後、または自爆で中断された後に限り、昨夜の脱落処理結果を告知して勝敗を判定し',
        electionEarlier: '昨夜の脱落処理結果を告知して勝敗を判定し、未決着の場合のみ脱落時能力を処理する',
        electionLaterLegacy: '警長選挙の終了後、または自爆で中断された後に限り、昨夜の脱落処理結果を告知して脱落時の役目を処理する',
        electionEarlierLegacy: '先に昨夜の脱落処理結果を告知して脱落時の役目を処理する',
        announcedExplosion: '昨夜の脱落処理結果が未告知の間に警長選挙中の自爆が起きた場合',
        legacyExplosionLastWords: '勝敗未決の場合に限り、遺言資格のある自爆者と夜間脱落者が本局の規則に従って遺言を述べて夜へ進む',
        postponedCandidateSpeech: '辞退しておらず生存している元の候補者を残す。候補者が2人以上残っている場合は、選挙演説をやり直す',
        nightPending: '人狼に攻撃対象として選ばれただけでは脱落は確定しない',
        idiot: '初めて追放されたときは正体を公開して場に残る。その後に再び追放されると脱落する',
      },
    } as const;

    for (const locale of ['zh-CN', 'en', 'ja'] as const) {
      for (const deathVersion of [2, 1, undefined] as const) {
        for (const electionVersion of [3, 2, 1, undefined] as const) {
          const rules = buildRules('mirror12', {}, { locale, electionVersion });
          rules.values['sheriff.explodeInElection'] = 'postpone_vote';
          rules.values['sheriff.timing'] = 'before_announcement';
          if (deathVersion === undefined) delete rules.deathResolutionVersion;
          else rules.deathResolutionVersion = deathVersion;
          if (deathVersion !== 2) rules.hunterShotVersion = 1;
          if (electionVersion === undefined) delete rules.electionVersion;
          const card = buildRuleCard(rules);
          expect(card).toContain(wording[locale].nightPending);
          expect(card).toContain(wording[locale][deathVersion === 2 ? 'newVictory' : 'oldVictory']);
          const chainShot = deathVersion === 2 && rules.hunterShotVersion === 2;
          expect(card).toContain(wording[locale][chainShot ? 'newHunter' : deathVersion === 2 ? 'oldHunter' : 'legacyHunter']);
          if (chainShot) expect(card).toContain(wording[locale].chainLastWords);
          const resumedAfterElection = (electionVersion ?? 1) >= 2;
          expect(card).toContain(wording[locale][resumedAfterElection
            ? deathVersion === 2 ? 'electionLater' : 'electionLaterLegacy'
            : deathVersion === 2 ? 'electionEarlier' : 'electionEarlierLegacy']);
          if (locale === 'en') expect(card).not.toMatch(/[\u4e00-\u9fff]/);
          if (locale === 'ja') {
            expect(card).toContain('## 脱落');
            expect(card).not.toContain('## 出局');
            expect(card).not.toContain('自白');
            expect(card).toContain('自爆');
          }
        }
      }
    }

    const idiom = buildRuleCard(buildRules('idiot12'));
    expect(idiom).toContain(wording['zh-CN'].idiot);
    expect(idiom).not.toContain('票数最高即出局');
    const standard = buildRuleCard(buildRules('standard12'));
    expect(standard).not.toContain('模仿守卫');
    expect(standard).not.toContain('猎枪造成的出局');
    const mirrorNew = buildRules('mirror12');
    expect(buildRuleCard(mirrorNew)).toContain(wording['zh-CN'].newHunter);
    expect(buildRuleCard(mirrorNew)).toContain(wording['zh-CN'].chainLastWords);
    const mirrorLegacy = buildRules('mirror12', {}, { deathResolutionVersion: 1 });
    expect(mirrorLegacy.hunterShotVersion).toBe(1);
    expect(buildRuleCard(mirrorLegacy)).not.toContain(wording['zh-CN'].newHunter);
    expect(buildRuleCard(mirrorLegacy)).not.toContain('猎枪造成的出局');
    const oldShot = buildRules('mirror12', {}, { deathResolutionVersion: 2, hunterShotVersion: 1 });
    expect(buildRuleCard(oldShot)).not.toContain(wording['zh-CN'].newHunter);
    expect(buildRuleCard(oldShot)).not.toContain(wording['zh-CN'].chainLastWords);
    for (const locale of ['zh-CN', 'en', 'ja'] as const) {
      const missingShotVersion = buildRules('mirror12', {}, { locale, deathResolutionVersion: 2 });
      delete missingShotVersion.hunterShotVersion;
      const card = buildRuleCard(missingShotVersion);
      expect(card).not.toContain(wording[locale].newHunter);
      expect(card).not.toContain(wording[locale].chainLastWords);
      if (locale === 'en') expect(card).not.toMatch(/[\u4e00-\u9fff]/);
    }
    const alreadyAnnounced = buildRules('mirror12', {}, { deathResolutionVersion: 2 });
    alreadyAnnounced.values['sheriff.explodeInElection'] = 'postpone_vote';
    alreadyAnnounced.values['sheriff.timing'] = 'after_last_words';
    expect(buildRuleCard(alreadyAnnounced)).toContain(wording['zh-CN'].announcedExplosion);
    const legacyResume = buildRules('mirror12', {}, { deathResolutionVersion: 2, electionVersion: 1 });
    legacyResume.values['sheriff.explodeInElection'] = 'postpone_vote';
    legacyResume.values['sheriff.timing'] = 'after_last_words';
    expect(buildRuleCard(legacyResume)).not.toContain(wording['zh-CN'].announcedExplosion);
    for (const policy of ['lost', 'postpone'] as const) {
      const separateNight = buildRules('mirror12');
      separateNight.values['sheriff.explodeInElection'] = policy;
      separateNight.values['sheriff.timing'] = 'before_announcement';
      const card = buildRuleCard(separateNight);
      expect(card).toContain('若警长竞选自爆时昨夜出局结算情况尚未通报，先单独结算自爆者');
      expect(card).not.toContain(wording['zh-CN'].announcedExplosion);
      expect(card).toContain('## 自爆');
      if (policy === 'lost') expect(card).not.toContain('## 自爆与延期竞选');
      else expect(card).toContain('## 自爆与延期竞选');
    }

    for (const locale of ['zh-CN', 'en', 'ja'] as const) {
      const legacyElectionExplosion = buildRules('mirror12', {}, { locale, deathResolutionVersion: 1 });
      legacyElectionExplosion.values['sheriff.timing'] = 'before_announcement';
      legacyElectionExplosion.values['sheriff.explodeInElection'] = 'postpone_vote';
      legacyElectionExplosion.values['lastWords.explode'] = false;
      expect(buildRuleCard(legacyElectionExplosion)).toContain(wording[locale].legacyExplosionLastWords);

      const postponedCampaign = buildRules('mirror12', {}, { locale });
      postponedCampaign.values['sheriff.explodeInElection'] = 'postpone';
      const postponedCard = buildRuleCard(postponedCampaign);
      expect(postponedCard).toContain(wording[locale].postponedCandidateSpeech);
      expect(postponedCard).not.toContain('候选人不变');
    }

    const noSheriff = buildRules('idiot12');
    noSheriff.values['sheriff.enabled'] = false;
    const noSheriffCard = buildRuleCard(noSheriff);
    expect(noSheriffCard).toContain('首次被放逐时翻牌亮明身份');
    expect(noSheriffCard).not.toContain('警长白痴翻牌');
    expect(noSheriffCard).not.toContain('警徽');
    expect(noSheriffCard).not.toContain('## 警徽、白天发言与放逐');
    expect(noSheriffCard).not.toContain('警上自爆与尚未公布的昨夜出局结算情况');
    expect(noSheriffCard).not.toContain('延期竞选');

    const noSheriffEnglish = buildRules('mirror12', {}, { locale: 'en' });
    noSheriffEnglish.values['sheriff.enabled'] = false;
    noSheriffEnglish.values['sheriff.explodeInElection'] = 'lost';
    const noSheriffEnglishCard = buildRuleCard(noSheriffEnglish);
    expect(noSheriffEnglishCard).toContain('## Wolf reveal');
    expect(noSheriffEnglishCard).not.toContain('## 自爆');
    expect(noSheriffEnglishCard).not.toContain('## Wolf reveal and postponed election');
    expect(noSheriffEnglishCard).not.toMatch(/[\u4e00-\u9fff]/);

    const lostPolicyEnglish = buildRules('mirror12', {}, { locale: 'en' });
    lostPolicyEnglish.values['sheriff.explodeInElection'] = 'lost';
    const lostPolicyEnglishCard = buildRuleCard(lostPolicyEnglish);
    expect(lostPolicyEnglishCard).toContain('## Wolf reveal');
    expect(lostPolicyEnglishCard).not.toContain('## Wolf reveal and postponed election');
    expect(lostPolicyEnglishCard).not.toMatch(/[\u4e00-\u9fff]/);

    const noExplosion = buildRules('mirror12');
    noExplosion.values['explode.enabled'] = false;
    const noExplosionCard = buildRuleCard(noExplosion);
    expect(noExplosionCard).not.toContain('## 自爆与延期竞选');
    expect(noExplosionCard).not.toContain('警上自爆与尚未公布的昨夜出局结算情况');

    const noHunter = buildRules('mirror12');
    noHunter.roles = noHunter.roles.filter((role) => role !== 'hunter');
    expect(buildRuleCard(noHunter)).not.toContain('· 猎人：');
    expect(buildRuleCard(noHunter)).not.toContain('猎枪造成的出局');
  });

  it('三语身份规则卡使用独立、可读的守卫、普通狼人和女巫说明', () => {
    const assertions = {
      'zh-CN': [
        '守卫：每晚可以守护一名存活玩家，也可以选择不守护任何人。',
        '普通狼人：本局普通狼人互相知道队友身份。',
        '女巫：有一瓶解药和一瓶毒药，每瓶只能使用一次。',
        '法官不会告知守卫的选择。',
        '用药选择在游戏期间不公开，用药目标不会收到通知。',
      ],
      en: [
        'Guard: Each night, you may protect one living player or choose to protect nobody.',
        'Ordinary Werewolves: In this setup, ordinary Werewolves know one another\'s identities.',
        'Witch: You have one antidote and one poison, and each can be used once.',
        'The moderator does not tell the Witch the Guard\'s choice.',
        'Potion choices are not revealed during the game, and targets are not notified.',
      ],
      ja: [
        '守衛：毎夜、生存者1人を護衛するか、誰も護衛しないかを選べる。',
        '通常の人狼：本局では通常の人狼同士がお互いの正体を知っている。',
        '魔女：解毒薬と毒薬を1本ずつ持ち、それぞれ1回だけ使える。',
        '司会は魔女に守衛の選択を知らせない。',
        '薬の選択は対局中に公開されず、対象にも通知されない。',
      ],
    } as const;
    for (const locale of ['zh-CN', 'en', 'ja'] as const) {
      const card = buildRuleCard(buildRules('standard12', {}, { locale }));
      for (const sentence of assertions[locale]) expect(card).toContain(sentence);
      if (locale === 'en') expect(card).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it('镜隐规则卡按觉醒夜间版本区分女巫目标与觉醒隐狼轮次', () => {
    const wording = {
      'zh-CN': {
        oldNotice: '法官只告知女巫普通狼刀的攻击目标，不告知额外爪击的目标',
        oldScope: '额外爪击与普通狼刀目标相同时也会被这瓶解药挡住',
        oldNoTarget: '额外爪击不会成为可选解药目标',
        multiNotice: '本夜受到普通狼刀或额外爪击的玩家，只报座位，不区分攻击来源',
        multiScope: '一瓶解药只能选一名当夜受到狼人攻击的玩家',
        nightLabel: '觉醒隐狼模仿或发动已学技能',
        nightFlow: '模仿和已学的夜间主动技能在觉醒隐狼自己的同一夜间轮次处理',
        takeoverAfter: '其他普通狼人全部出局后，觉醒隐狼从下一夜起负责普通狼人的攻击，并在狼人轮次单独提交',
        takeoverFirst: '从第 1 夜起负责普通狼人的攻击；不获得队友资料。',
        takeoverFirstPhase: '从第 1 夜起负责普通狼人的攻击，并在狼人轮次单独提交',
      },
      en: {
        oldNotice: 'privately tells the Witch the target of the ordinary Werewolf attack, but not the target of an extra claw',
        oldScope: 'If the extra claw targets the same player, this antidote also stops the claw',
        oldNoTarget: 'an extra-claw target is not offered for the antidote',
        multiNotice: 'players were attacked tonight by the ordinary wolf attack or an extra claw',
        multiScope: 'The single antidote can be used on only one player attacked by wolves tonight',
        nightLabel: 'Awakened Hidden Wolf: mimic or use a learned ability',
        nightFlow: "Mimicry and learned active night abilities are handled during the Awakened Hidden Wolf's own night turn",
        takeoverAfter: "takes over the ordinary Werewolves' attack starting the following night, submitting it separately during the Werewolf turn",
        takeoverFirst: "Takes over the ordinary Werewolves' attack starting on Night 1. It receives no teammate information.",
        takeoverFirstPhase: "Takes over the ordinary Werewolves' attack starting on Night 1, submitting it separately during the Werewolf turn",
      },
      ja: {
        oldNotice: '通常の人狼襲撃の対象だけを魔女に個別に知らせ、追加爪撃の対象は知らせない',
        oldScope: '追加爪撃も同じプレイヤーを狙った場合は、この解毒薬でその爪撃も防げる',
        oldNoTarget: '追加爪撃の対象は解毒薬の選択肢にならない',
        multiNotice: '通常襲撃または追加爪撃を受けたプレイヤーを魔女に個別に知らせる',
        multiScope: '解毒薬1本で救えるのは、今夜人狼に襲撃されたプレイヤー1人だけです',
        nightLabel: '覚醒隠狼の模倣または習得済み能力',
        nightFlow: '模倣と習得済みの夜間能動能力は、覚醒隠狼自身の夜の手番で処理する',
        takeoverAfter: '覚醒隠狼は次の夜から通常の人狼の襲撃を担当し、人狼の手番で別に提出する',
        takeoverFirst: '第1夜から通常の人狼の襲撃を担当する。仲間の情報は得ない。',
        takeoverFirstPhase: '第1夜から通常の人狼の襲撃を担当し、人狼の手番で別に提出する',
      },
    } as const;

    const awOnlyRoles = ['awakened_wolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'];
    for (const locale of ['zh-CN', 'en', 'ja'] as const) {
      const legacy = buildRuleCard(buildRules('mirror12', {}, { locale, awakenedNightVersion: 1 }));
      expect(legacy).toContain(wording[locale].oldNotice);
      expect(legacy).toContain(wording[locale].oldScope);
      expect(legacy).toContain(wording[locale].oldNoTarget);
      expect(legacy).not.toContain(wording[locale].multiNotice);

      const current = buildRuleCard(buildRules('mirror12', {}, { locale, awakenedNightVersion: 2 }));
      expect(current).toContain(wording[locale].multiNotice);
      expect(current).toContain(wording[locale].multiScope);
      expect(current).toContain(wording[locale].nightLabel);
      expect(current).toContain(wording[locale].nightFlow);
      expect(current).not.toContain(wording[locale].oldNotice);

      const awOnlyCurrent = buildRuleCard(buildRules('classic9', {}, { locale, roles: awOnlyRoles, awakenedNightVersion: 2 }));
      expect(awOnlyCurrent).toContain(wording[locale].nightLabel);
      expect(awOnlyCurrent).toContain(wording[locale].takeoverFirstPhase);
      expect(awOnlyCurrent).not.toContain('awakened_mimic');

      const awOnlyLegacy = buildRuleCard(buildRules('classic9', {}, { locale, roles: awOnlyRoles, awakenedNightVersion: 1 }));
      expect(awOnlyLegacy).toContain(wording[locale].takeoverFirst);
      expect(awOnlyLegacy).not.toContain('awakened_mimic');
    }
  });

  it('规则卡按实际发言依据和狼人私密信息权限表述三语规则', () => {
    const wording = {
      'zh-CN': {
        knifeFirst: '若该目标没有出局，就从其他昨夜出局玩家中选择座位号最小者作为发言依据',
        randomDead: '法官从昨夜出局玩家中随机选择一人作为发言依据',
        wolfVisibility: '开局不提供队友名单；夜间参与狼人会看到彼此座位和投刀选择，因此可以识别当夜参与的狼人',
        noDiscussion: '多名存活普通狼人时不进行密谈，直接提交攻击目标；只剩一名时也直接提交',
        knownPack: '本局普通狼人互相知道队友身份',
        noOrdinaryTarget: '所有参与普通狼刀的玩家都选择不攻击时，普通狼刀没有目标',
        guardAndSave: '守卫或模仿守卫当晚守护，且女巫同时救治同一名狼人攻击目标时',
      },
      en: {
        knifeFirst: 'otherwise, use the eliminated player with the lowest seat number',
        randomDead: 'the moderator chooses one player eliminated last night at random as the reference',
        wolfVisibility: 'No teammate list is provided at the start; Werewolves participating that night see one another’s seats and submitted attack choices, so they can identify who took part that night',
        noDiscussion: 'When multiple ordinary Werewolves are alive, they do not discuss and submit attack targets directly; a lone Werewolf also submits directly',
        knownPack: 'ordinary Werewolves know one another\'s identities',
        noOrdinaryTarget: 'If everyone participating in the ordinary attack chooses not to attack, the ordinary attack has no target',
        guardAndSave: 'Guard or copied Guard protects and the Witch saves the same wolf attack target',
      },
      ja: {
        knifeFirst: '脱落していなければ昨夜の脱落者のうち席番号が最も小さい者を基準として選ぶ',
        randomDead: '司会は昨夜の脱落者から無作為に1人を発言順の基準として選ぶ',
        wolfVisibility: '開局時に仲間の一覧は提供されない。夜間に参加する人狼は互いの席番号と襲撃の選択を見られるため、その夜に参加した人狼を判別できる',
        noDiscussion: '生存中の通常の人狼が複数いても相談せず、直接攻撃対象を提出する。1人だけの場合も直接提出する',
        knownPack: '通常の人狼同士がお互いの正体を知っている',
        noOrdinaryTarget: '通常の人狼襲撃に参加する全員が攻撃しない場合、通常襲撃の対象はいない',
        guardAndSave: '守衛または模倣した守衛がその夜に護衛し、魔女が同じ人狼の攻撃対象を同時に救命した場合',
      },
    } as const;

    for (const locale of ['zh-CN', 'en', 'ja'] as const) {
      const knifeFirst = buildRules('classic9', {}, { locale });
      knifeFirst.values['speech.anchor'] = 'knife_first';
      expect(buildRuleCard(knifeFirst)).toContain(wording[locale].knifeFirst);

      const randomDead = buildRules('classic9', {}, { locale });
      randomDead.values['speech.anchor'] = 'random_dead';
      expect(buildRuleCard(randomDead)).toContain(wording[locale].randomDead);

      const hiddenTeammates = buildRules('classic9', {}, { locale });
      hiddenTeammates.values['wolf.knowTeammates'] = false;
      hiddenTeammates.values['wolf.discussRounds'] = 0;
      const card = buildRuleCard(hiddenTeammates);
      expect(card).toContain(wording[locale].wolfVisibility);
      expect(card).toContain(wording[locale].noDiscussion);
      if (locale === 'en') expect(card).not.toMatch(/[\u4e00-\u9fff]/);

      const mirror = buildRules('mirror12', {}, { locale });
      mirror.values['resolve.guardAndSaveKills'] = true;
      const mirrorCard = buildRuleCard(mirror);
      expect(mirrorCard).toContain(wording[locale].knownPack);
      expect(mirrorCard).toContain(wording[locale].noOrdinaryTarget);
      expect(mirrorCard).toContain(wording[locale].guardAndSave);
      if (locale === 'en') expect(mirrorCard).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it('魔镜规则卡、工具目录和实时菜单只按本局是否有觉醒隐狼说明', () => {
    const wording = {
      'zh-CN': {
        awakeCard: '觉醒隐狼未模仿时显示觉醒隐狼；模仿后立即显示模仿身份',
        awakePrompt: '模仿后的觉醒隐狼会显示模仿身份',
        genericTool: '查验表现不保证真实阵营',
        forbiddenName: '觉醒隐狼',
      },
      en: {
        awakeCard: 'An Awakened Hidden Wolf appears as itself before mimicking',
        awakePrompt: 'A mimicked Awakened Hidden Wolf shows the copied role',
        genericTool: 'the displayed role does not guarantee true alignment',
        forbiddenName: 'Awakened Hidden Wolf',
      },
      ja: {
        awakeCard: '覚醒隠狼は模倣前は覚醒隠狼',
        awakePrompt: '模倣後の覚醒隠狼は模倣役職として見えます',
        genericTool: '表示される役職は真の陣営を保証しない',
        forbiddenName: '覚醒隠狼',
      },
    } as const;

    for (const locale of ['zh-CN', 'en', 'ja'] as const) {
      const mirrorPreset = buildRules('mirror12', {}, { locale });
      const configurations = [
        { rules: mirrorPreset, hasAwakenedWolf: true },
        {
          rules: buildRules('mirror12', {}, {
            locale,
            name: 'Mirror Maiden custom setup',
            roles: mirrorPreset.roles.filter((role) => role !== 'awakened_wolf'),
          }),
          hasAwakenedWolf: false,
        },
      ];

      for (const { rules, hasAwakenedWolf } of configurations) {
        const card = buildRuleCard(rules);
        if (hasAwakenedWolf) expect(card).toContain(wording[locale].awakeCard);
        else expect(card).not.toContain(wording[locale].forbiddenName);
        if (locale === 'en') expect(card).not.toMatch(/[\u4e00-\u9fff]/);
        if (locale === 'ja') expect(card).not.toContain('自白');

        const mirrorSeat = rules.roles.indexOf('mirror_maiden') + 1;
        const created = createGame({
          id: `mirror-${locale}-${hasAwakenedWolf}`,
          rules,
          seed: 'mirror-tools',
          deal: rules.roles,
          names: rules.roles.map((_, index) => `Player ${index + 1}`),
        });
        const catalogTool = seatTools(created.state, mirrorSeat).find((tool) => tool.name === 'mirror_inspect');
        expect(catalogTool).toBeDefined();
        expect(catalogTool!.description).toContain(wording[locale].genericTool);
        expect(catalogTool!.description).not.toContain(wording[locale].forbiddenName);

        if (hasAwakenedWolf) {
          const awakenedSeat = rules.roles.indexOf('awakened_wolf') + 1;
          const copiedCatalogTool = seatTools(created.state, awakenedSeat).find((tool) => tool.name === 'mirror_inspect');
          expect(copiedCatalogTool).toMatchObject({ title: catalogTool!.title, description: catalogTool!.description });
        }

        let state = created.state;
        const events = [...created.events];
        const rand = makeRand(817);
        let mirrorTask: ReturnType<typeof projectSeat>['task'] | undefined;
        for (let step = 0; step < 200 && !mirrorTask; step++) {
          const view = projectSeat(state, events, mirrorSeat);
          if (view.task?.tools.some((tool) => tool.name === 'mirror_inspect')) {
            mirrorTask = view.task;
            break;
          }
          const seat = waitingSeats(state)[0];
          const outcome = submit(state, { seat, call: randomCall(rand, state.pending!.tools[seat]) });
          const next = outcome.error ? submit(state, { seat, call: { tool: '', args: {} }, auto: true }) : outcome;
          state = next.state;
          events.push(...next.events);
        }
        expect(mirrorTask).toBeDefined();
        const liveTool = mirrorTask!.tools.find((tool) => tool.name === 'mirror_inspect');
        expect(liveTool).toMatchObject({ title: catalogTool!.title, description: catalogTool!.description });
        if (hasAwakenedWolf) expect(mirrorTask!.prompt).toContain(wording[locale].awakePrompt);
        else expect(mirrorTask!.prompt).not.toContain(wording[locale].forbiddenName);
      }
    }
  });

  it('规则卡格式跟随语言包回退链处理英文方言与自定义回退', () => {
    for (const locale of ['en-GB', 'fr-FR']) {
      const card = buildRuleCard(buildRules('standard12', {}, { locale }));
      expect(card).not.toMatch(/[\u4e00-\u9fff]/);
      expect(card).toContain('Werewolf ×4, Villager ×4, Seer, Witch, Hunter, and Guard');
      expect(card).toContain('Guard: Each night, you may protect one living player or choose to protect nobody. You may protect yourself.');
      expect(card).toContain("The player with the most votes becomes the wolves' final attack target.");
      expect(card).toContain('· Last words:');
      expect(card).toContain('; ');
    }
  });
});
