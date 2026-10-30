import type { RoleModule } from '../types';

export const villager: RoleModule = {
  id: 'villager',
  name: '平民',
  faction: 'good',
  category: 'villager',
  maxPerGame: 8,
  summary: '没有夜间技能，依靠发言和投票找出狼人。',
};
