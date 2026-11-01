import type { PresetDef } from './types';

const times = (role: string, n: number) => Array.from({ length: n }, () => role);

/** 版型只是数据：人数由身份列表长度决定，流程差异只来自身份列表和规则开关。 */
export const BUILTIN_PRESETS: PresetDef[] = [
  {
    id: 'mirror12',
    version: 1,
    name: '十二人镜隐迷踪',
    description: '狼人 ×3、觉醒隐狼、平民 ×4，魔镜少女、女巫、猎人、守卫。精确查验与延迟模仿，屠边，有警长。',
    roles: [...times('werewolf', 3), 'awakened_wolf', 'mirror_maiden', 'witch', 'hunter', 'guard', ...times('villager', 4)],
    overrides: { 'witch.selfSave': 'never' },
    tag: '进阶',
  },
  {
    id: 'standard12',
    name: '十二人预女猎守',
    description: '狼人 ×4、平民 ×4，预言家、女巫、猎人、守卫。屠边，有警长。',
    roles: [...times('werewolf', 4), 'seer', 'witch', 'hunter', 'guard', ...times('villager', 4)],
    tag: '标准',
  },
  {
    id: 'classic9',
    name: '九人经典（预女猎）',
    description: '狼人 ×3、平民 ×3，预言家、女巫、猎人。屠边，有警长。',
    roles: [...times('werewolf', 3), 'seer', 'witch', 'hunter', ...times('villager', 3)],
    tag: '标准',
  },
  {
    id: 'idiot12',
    name: '十二人预女猎白',
    description: '狼人 ×4、平民 ×4，预言家、女巫、猎人、白痴。用来演示新增身份只需注册模块。',
    roles: [...times('werewolf', 4), 'seer', 'witch', 'hunter', 'idiot', ...times('villager', 4)],
    tag: '扩展示例',
  },
];

export const DEFAULT_PRESET = 'standard12';
