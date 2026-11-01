import { writeFile } from 'node:fs/promises';
import { buildRules, createGame, projectSeat, seatTools } from '../../engine/src/index';
import { buildMessages } from '../src/prompt';
import { STYLES } from '../src/styles';
import { TestGame } from '../../engine/test/harness';

const rules = buildRules('mirror12');
const { state, events } = createGame({ id: 'prompt-review-example', rules, seed: 'synthetic-review', deal: rules.roles });
const standardRules = buildRules('standard12');
const standard = createGame({ id: 'prompt-review-standard', rules: standardRules, seed: 'synthetic-standard', deal: standardRules.roles });
const base = projectSeat(state, events, 9);
const projection = structuredClone(base);
projection.ruleCard = '{{本局规则卡}}';
projection.me!.appendix = '{{该座位身份说明}}';
projection.me!.factionName = '{{真实阵营名称}}';
const template = (buildMessages(projection, '{{扮演风格与可选补充性格}}')[0].content as string)
  .replaceAll('180 秒', '{{发言限时秒数}} 秒').replaceAll('90 秒', '{{技能限时秒数}} 秒');
const makeHidden = () => new TestGame({ preset: 'mirror12', deal: rules.roles, values: { 'sheriff.enabled': false } });
const hidden = makeHidden();
hidden.ok(4, 'awakened_mimic', { targetSeat: 5 });
const mimicNotice = hidden.view(4).events.find((e) => e.type === 'awakened.mimic')!.text;
hidden.night();
const activeNotice = hidden.view(4).events.find((e) => e.type === 'awakened.activated')!.text;
hidden.toNight(); hidden.until((g) => g.pending?.step.type === 'night:awakened_skill');
const inheriting = makeHidden();
inheriting.ok(4, 'awakened_mimic', { targetSeat: 9 }); inheriting.night();
inheriting.removeSeats(1, 2, 3); inheriting.toNight();
const inheritNotice = inheriting.view(4).events.find((e) => e.type === 'awakened.inherit')!.text;
inheriting.untilTool('awakened_kill');
const L = [
  '# 系统提示词审阅稿', '',
  '更新：2026-11-02。由 packages/llm/scripts/export-prompt-review.ts 直接从当前源码展开固定系统模板、默认规则卡、各身份开局说明和工具说明。固定规则明确昼夜编号与「昨夜／今晚」，并澄清信息分发、身份与职务、行动与结算及自爆边界；不增加逐轮状态总结、历史纠错或策略提示，也不声称文字更新已经改善真实模型表现。', '',
  '## 外层完整模板', '',
  '默认发言限时 180 秒，技能限时由座位配置确定（默认 90 秒，会话层设有最低值）。花括号占位符在运行时替换，规则卡和身份说明不是省略项，完整镜隐迷踪样例见下文。', '',
  '```text', template, '```', '',
  '## 本局规则卡：标准十二人默认配置', '',
  '同一房间所有座位收到相同公共规则卡，内容按开局配置生成。以下两张卡分别对应两个独立合成房间，不来自真实房间或历史。', '',
  '```text', projectSeat(standard.state, standard.events, 9).ruleCard, '```', '',
  '## 本局规则卡：镜隐迷踪默认配置', '',
  '```text', base.ruleCard, '```', '',
  '## 身份说明：开局样例', '',
  '以下按镜隐迷踪、标准十二人两组合成发牌展开并按身份去重。每个模型只收到自己的身份说明，座位编号仅属于对应示例房间。系统消息在座位上下文首次建立时写入，后续库存、查验、守护等实际游戏事件通过有受众限制的法官消息追加，不覆盖开局 system，也不每轮重述当前身份、能力或历史。', '',
];
const seen = new Set<string>();
const tools = new Map<string, { description: string; params: unknown }>();
for (const sample of [{ state, events }, standard]) {
  for (const player of sample.state.players) {
    const p = projectSeat(sample.state, sample.events, player.seat);
    for (const tool of seatTools(sample.state, player.seat)) if (!tools.has(tool.name)) tools.set(tool.name, tool);
    if (seen.has(p.me!.role)) continue;
    seen.add(p.me!.role);
    L.push(`### ${p.me!.roleName}（${sample.state.rules.presetName}）`, '', '```text', p.me!.appendix, '```', '');
  }
}
L.push('## 扮演风格的实际内容', '', '这部分同样进入 system，会影响表达与冒险倾向，并非纯装饰标签。房主还可附加「补充性格」。', '');
for (const style of STYLES) L.push(`- **${style.name}**：${style.text}`);
L.push('', '## 动态消息与工具不在 system 正文中', '',
  '每席保留独立对话。自己的回复和工具回执留在自己的历史；其他席发言以带座位号的 user 消息引用，法官消息以 judge 来源标记。当前行动许可、目标菜单和拒绝原因也在后续消息中。固定工具目录另以模型协议的工具 Schema 发送，目录存在不代表此时允许使用。', '',
  '查验行为和结果不会通知被查验者，未收到通知不代表没有被查验。公共规则已明确此边界；原始记录核对、模型小样本与验证范围见 [查验通知与信息边界](查验通知与信息边界.md)。', '',
  '其他玩家发言的格式示意（占位符不是原文）：', '', '```text',
  '{{第几天／第几夜及座位与发言类型}}（玩家原话）：', '「{{该玩家的原话}}」', '{{针对接收者的轮次提示与许可菜单}}', '```', '',
  '### 觉醒隐狼的动态通知与工具许可', '',
  '从第 1 夜起即可在法官询问的模仿阶段选择学习，也可暂不学习；整局只限成功一次。成功后立即私密告知目标真实身份；学习夜结束再追加技能获得通知。夜间主动技能从下一夜起由当前菜单开放，复制猎人则在有资格开枪的出局职责中开放。模仿平民不会产生主动技能。', '',
  '开局的固定工具目录已经包含各种可能的模仿动作。它不随模仿结果更换；能否调用仍由所学身份、启用夜晚、剩余资源和当前法官任务决定。模仿女巫没有解药；模仿狼人得到的额外爪击还须先继承刀权。', '',
  '以下通知正文由独立合成对局直接提取：4 号在第 1 夜模仿 5 号魔镜少女，目标和其他座位不会收到这些私密通知。通知本身不等于允许立即行动，需等当前法官菜单。', '',
  '```text',
  `第1夜 · 模仿成功：${mimicNotice}`,
  `第1夜结束 · 技能获得：${activeNotice}`,
  `第2夜 · 模仿技能任务：${hidden.view(4).task!.prompt}`,
  `本轮许可工具：${hidden.view(4).task!.tools.map((t) => t.name).join('、')}`,
  '```', '',
  '继承刀权在下一夜开始时私密通知，不让隐狼加入普通狼队密谈，也不补发队友身份。随后在独立的「继承狼刀」阶段询问落刀；若同时有可用模仿技能，稍后另行询问，不合并为同一次行动。下面另用一局合成对局展示其余狼人白天全部出局后的通知与许可：', '',
  '```text',
  `第2夜开始 · 刀权继承：${inheritNotice}`,
  `第2夜 · 继承狼刀任务：${inheriting.view(4).task!.prompt}`,
  `本轮许可工具：${inheriting.view(4).task!.tools.map((t) => t.name).join('、')}`,
  '```', '',
  '### 工具说明补充审阅', '',
  '下面按工具名去重列出两个十二人版型固定目录中的原始说明。它们不是 system 文本，但模型也会看到，因此一并提供审阅。参数 Schema 与当前合法目标由协议和引擎提供；此处保留完整说明文字。', '');
for (const [name, tool] of tools) L.push(`#### ${name}`, '', '```text', tool.description, '```', '');
L.push('## 本次边界与兼容', '',
  '- 只澄清固定规则和工具含义，不规定站边、验人顺序、技能策略或公开发言的真假；记忆、引用与推理由玩家自行承担。',
  '- 外层时限、扮演风格、阵营目标及允许隐瞒身份的范围保持原设定；普通助手正文和旁听回应与成功送达的游戏发言明确分开。',
  '- 不逐轮回注身份、局势或纠错总结，不新增显式缓存写入；新增退水只按当前窗口提供对应行动许可，保持事件受众、既有前缀和原生协议续接。',
  '- 已存在座位的 system 历史不回写；新建房间使用本次固定规则，旧记录不重新裁定。',
  '- 新开局采用竞选版本 3：普通警上可在他人发言期间退水，全部发言结束后最终确认再投票；旧版本保持原流程，延期竞选仍直接续投。详见 [真人玩家接入](真人玩家接入.md)。',
  '- 修改依据、静态反馈范围与验证局限见 [固定规则与信息分发](固定规则与信息分发.md)。', '',
  '## 对应源码', '',
  '- [外层系统模板](../packages/llm/src/prompt.ts)',
  '- [规则卡生成](../packages/engine/src/rulecard.ts)',
  '- [身份说明与授权投影](../packages/engine/src/projection.ts)',
  '- [觉醒隐狼模仿、技能与继承狼刀](../packages/engine/src/roles/awakened-wolf.ts)',
  '- [风格与补充性格](../packages/llm/src/styles.ts)',
  '- [每席消息与当前许可](../packages/session/src/agent.ts)',
  '- [动作 Schema 与显式工具](../packages/protocol/src/action-tools.ts)', '',
);
await writeFile(new URL('../../../docs/系统提示词审阅稿.md', import.meta.url), L.join('\n'), 'utf8');
console.log(JSON.stringify({ characters: L.join('\n').length, templateCharacters: template.length, roles: seen.size, tools: tools.size }));
