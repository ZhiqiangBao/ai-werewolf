export function Moon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" fill="#cfc8ff" />
    </svg>
  );
}

export function Sun({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="4.5" fill="#ffd28a" />
      <g stroke="#ffd28a" strokeWidth="2" strokeLinecap="round">
        <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
      </g>
    </svg>
  );
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="13" fill="#e8d9a8" />
      <circle cx="21" cy="12" r="11" fill="#0a0d18" />
      <path d="M7 25l3-6 2 3 2-5 2 5 2-3 3 6z" fill="#ff6b6b" opacity="0.85" />
    </svg>
  );
}

export function PhaseIcon({ phase, size }: { phase: string; size?: number }) {
  return phase === 'night' ? <Moon size={size} /> : <Sun size={size} />;
}
