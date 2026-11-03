import type { VoiceCatalog, Cast } from './project';

// 描述来自 design/ui-redesign/prompts.json 的立绘提示词；音色标注来自本机 Qwen 音色目录。
// 按行从左至右对应 1–12 席，不能在主题之间假定同一席的性别相同。
type Character = { appearance: string; gender: '男' | '女'; voice: string };
const person = (appearance: string, gender: Character['gender'], voice: string): Character => ({ appearance, gender, voice });
export const characterVoices = {
  campus: [
    person('沉静黑发男生', '男', 'longyanfengying'), person('沉着黑长发女生', '女', 'longlingxingxia'),
    person('亲切沙棕发男生', '男', 'longxinruixuan'), person('开朗桃发侧马尾女生', '女', 'longlingjinquan'),
    person('聪明深棕发眼镜男生', '男', 'longwangjixi'), person('害羞栗色短发女生', '女', 'longlanlingying'),
    person('悠闲银发男生', '男', 'longlanyufu'), person('自信深紫短发女生', '女', 'longshuangxuandie'),
    person('认真的蓝黑发男生', '男', 'longfenglanlu'), person('温柔蜜金发女生', '女', 'longluanlanju'),
    person('顽皮棕发男生', '男', 'longlinhongxi'), person('沉思青黑发眼镜辫女生', '女', 'longlanqinluan'),
  ],
  storybook: [
    person('亲切赤褐发青年男', '男', 'longxinruixuan'), person('机智黑短发青年女', '女', 'longlingxingxia'),
    person('白发白须年长男', '男', 'longlingzhixing'), person('开朗深卷发青年女', '女', 'longlingjinquan'),
    person('严肃银短发青年男', '男', 'longyanfengying'), person('温暖短卷发女', '女', 'longlanqinluan'),
    person('活泼姜发双辫女', '女', 'longluanlanju'), person('亲切栗发短须男', '男', 'longlangmoyue'),
    person('机智银发盘髻年长女', '女', 'longyiqinghui'), person('平静蓝黑束发青年男', '男', 'longlanyufu'),
    person('沉思深卷发眼镜青年男', '男', 'longwangjixi'), person('自信深色波浪发青年女', '女', 'longshuangxuandie'),
  ],
  gufeng: [
    person('黑发高髻青年书生', '男', 'longfenglanlu'), person('端庄玉簪长发女', '女', 'longlingxingxia'),
    person('温和栗发束发男', '男', 'longxinruixuan'), person('明眸双髻青年女', '女', 'longlingjinquan'),
    person('清冷银发半束男', '男', 'longyanfengying'), person('优雅黑发侧辫女', '女', 'longlanqinluan'),
    person('成熟黑发短须男', '男', 'longlangmoyue'), person('自信红带长发女', '女', 'longshuangxuandie'),
    person('庄重灰发长者书生', '男', 'longlingzhixing'), person('温柔低髻女', '女', 'longlanlingying'),
    person('沉思棕发眼镜青年男', '男', 'longwangjixi'), person('优雅银发女', '女', 'longluanlanju'),
  ],
  fantasy: [
    person('温暖红发人类男', '男', 'longxinruixuan'), person('优雅深发精灵女', '女', 'longlingxingxia'),
    person('开朗白须年长矮人男', '男', 'longlingzhixing'), person('好奇卷发半身人女', '女', 'longlingjinquan'),
    person('内敛银发精灵男', '男', 'longyanfengying'), person('自信短卷发人类女', '女', 'longlanqinluan'),
    person('活泼姜发双辫人类女', '女', 'longluanlanju'), person('开朗棕须矮人男', '男', 'longlangmoyue'),
    person('庄重银发年长人类女', '女', 'longyiqinghui'), person('黑发半精灵男', '男', 'longlanyufu'),
    person('沉思卷发眼镜青年男', '男', 'longwangjixi'), person('自信深波浪发精灵女', '女', 'longshuangxuandie'),
  ],
  urban: [
    person('悠闲赤褐发男', '男', 'longxinruixuan'), person('聪明黑短发女', '女', 'longlingxingxia'),
    person('老练银发中年男', '男', 'longlangmoyue'), person('微笑深卷发女', '女', 'longlingjinquan'),
    person('冷酷银短发青年男', '男', 'longyanfengying'), person('自然卷发女', '女', 'longlanqinluan'),
    person('活泼姜发双辫女', '女', 'longluanlanju'), person('亲切栗发胡须男', '男', 'longjinmeicheng'),
    person('自信银短发年长女', '女', 'longyiqinghui'), person('沉着黑发男', '男', 'longlanyufu'),
    person('沉思卷发眼镜男', '男', 'longwangjixi'), person('自信深波浪发女', '女', 'longshuangxuandie'),
  ],
  future: [
    person('红发侧削青年男', '男', 'longxinruixuan'), person('冷静黑短发紫挑染女', '女', 'longlingxingxia'),
    person('银发年长男', '男', 'longlingzhixing'), person('深卷发耳机女', '女', 'longlingjinquan'),
    person('严肃银发青年男', '男', 'longyanfengying'), person('短卷发金发夹女', '女', 'longlanqinluan'),
    person('活泼姜发双辫女', '女', 'longluanlanju'), person('亲切栗发胡须男', '男', 'longlangmoyue'),
    person('机智银短发年长女', '女', 'longyiqinghui'), person('沉着蓝黑束发男', '男', 'longlanyufu'),
    person('卷发眼镜青年男', '男', 'longwangjixi'), person('自信深波浪发女', '女', 'longshuangxuandie'),
  ],
} as const;

export function applyCharacterVoices(voices: VoiceCatalog, cast: Cast[], theme: string): VoiceCatalog {
  if (!Object.hasOwn(characterVoices, theme)) throw Error(`Unsupported avatar theme: ${theme}`);
  const characters: readonly Character[] = characterVoices[theme as keyof typeof characterVoices];
  const result: VoiceCatalog = { ...voices, profiles: { ...voices.profiles } };
  for (const c of cast) {
    const character = characters[c.seat - 1];
    if (!character || !voices.profiles[c.voiceKey]) throw Error(`A voice profile is required for ${c.voiceKey}`);
    result.profiles[c.voiceKey] = { voice: `qwen-audio-3.0-tts-plus-${character.voice}`, label: `${c.seat}号 ${c.name}`, rate: 1.04, instruction: '' };
  }
  return result;
}
