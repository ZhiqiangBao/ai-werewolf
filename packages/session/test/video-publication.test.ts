import { expect, it } from 'vitest';
import { publicationMetadata, withPublicationDetails } from '../../../scripts/video/publish-copy';
import type { Script } from '../../../scripts/video/project';

const script = { roomId: 'fixture', ruleCard: '【本局规则】\n守卫不能连续两夜守护同一人。', cast: [1, 2].map((seat) => ({ seat, name: `玩家${seat}` })) } as Script;

it('uses human control in preference to a leftover model field and exports no credentials', () => {
  const raw = { hostToken: 'private-host', seats: [
    { seat: 1, controller: 'ai', model: 'recorded-model', apiKeyEnc: 'private-key', baseUrl: 'private-endpoint' },
    { seat: 2, controller: 'human', model: 'unused-model', apiKeyMask: 'private-mask' },
  ] };
  const metadata = publicationMetadata(raw, script), json = JSON.stringify(metadata);
  expect(metadata.seats[1]).toMatchObject({ controller: 'human', model: null });
  expect(json).not.toMatch(/private|unused-model|baseUrl|apiKey/);
  const copy = withPublicationDetails('# 标题\n\n已确认标题\n\n# 简介\n\n作者本人加入AI聚会。\n', metadata);
  expect(copy).toContain('| 1号 | 玩家1 | recorded-model |');
  expect(copy).toContain('| 2号 | 玩家2 | 真人 |');
  expect(copy.replace(/  \n/g, '\n')).toContain(script.ruleCard!);
});

it('refreshes managed seat/rule details idempotently while preserving approved prose and later notes', () => {
  const metadata = publicationMetadata({ seats: [] }, script), prose = '# 标题\n\n原题\n\n# 简介\n\n原简介保持。\n';
  const first = withPublicationDetails(prose, metadata) + '\n手动后记。\n';
  const second = withPublicationDetails(first, metadata);
  expect(second).toBe(first);
  const changed = withPublicationDetails(first, { ...metadata, ruleCard: '不同的真实规则。' });
  expect(changed.startsWith(prose)).toBe(true); expect(changed.endsWith('手动后记。\n')).toBe(true);
  expect(changed).toContain('不同的真实规则。');
  expect(changed).not.toContain('守卫不能连续两夜');
});

it('requires actual rules and refuses malformed markers instead of guessing or deleting user copy', () => {
  expect(() => publicationMetadata({}, { ...script, ruleCard: undefined })).toThrow('Missing recorded rule card');
  const metadata = publicationMetadata({}, script);
  expect(() => withPublicationDetails('# 标题\n# 简介\n<!-- werewolf-publication-details:start -->', metadata)).toThrow('malformed');
});
