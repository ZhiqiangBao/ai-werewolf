export function Moon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" fill="#6355e8" />
      <circle cx="17.4" cy="6.4" r="1.1" fill="#a99bff" />
      <circle cx="20.5" cy="9.6" r="0.7" fill="#a99bff" />
    </svg>
  );
}

export function Sun({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="4.5" fill="#f59e0b" />
      <g stroke="#f7b733" strokeWidth="2" strokeLinecap="round">
        <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
      </g>
    </svg>
  );
}

/** 紫色圆角方块里一弯新月和狼牙，在浅色和深色背景上都清楚。 */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#5b49e0" />
      <path d="M22.4 19.4A7.7 7.7 0 0 1 12.6 9.6a7.7 7.7 0 1 0 9.8 9.8Z" fill="#fff3c9" />
      <path d="M7 26.5l3-6 2 3 2-5 2 5 2-3 3 6z" fill="#ff8f9a" />
    </svg>
  );
}

export function PhaseIcon({ phase, size }: { phase: string; size?: number }) {
  return phase === 'night' ? <Moon size={size} /> : <Sun size={size} />;
}
