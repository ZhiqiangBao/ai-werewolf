import { gameText } from './locale';
import { DEATH_GLYPHS, type DeathCause } from './death-glyphs';
export * from './death-glyphs';

export const deathLabel = (causes: readonly DeathCause[], locale?: string): string => causes.map((cause) => gameText(locale, DEATH_GLYPHS[cause].label)).join(' / ');
export const deathShortLabel = (cause: DeathCause, locale?: string): string => gameText(locale, `death.short.${cause}`);
