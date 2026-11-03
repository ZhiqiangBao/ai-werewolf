import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SkillAnimation } from '../src/components/SkillAnimation';

it('renders decorative SVG without disclosing a target or identity', () => {
  const html = renderToStaticMarkup(createElement(SkillAnimation, { kind: 'poison' }));
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('<path');
  expect(html).not.toContain('target');
});
