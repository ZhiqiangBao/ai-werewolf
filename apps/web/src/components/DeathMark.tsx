import { DEATH_GLYPHS, deathLabel, deathShortLabel, type DeathCause } from '@werewolf/protocol';

export function DeathMark({ causes = ['other'], locale, size = 22 }: { causes?: readonly DeathCause[]; locale?: string; size?: number }) {
  const label = deathLabel(causes, locale);
  return <span className="death-mark" role="img" aria-label={label} title={label}>
    {causes.map((cause) => <span className="death-symbol" key={cause} aria-hidden="true"><svg viewBox="0 0 24 24" width={size} height={size} fill="none" strokeLinecap="round" strokeLinejoin="round">
      {DEATH_GLYPHS[cause].layers.map((layer, i) => <path key={i} d={layer.path} fill={layer.fill ?? 'none'} stroke={layer.stroke ?? 'currentColor'} strokeWidth={layer.width ?? 1.4} />)}
    </svg><span>{deathShortLabel(cause, locale)}</span></span>)}
  </span>;
}
