/** The Trivio mark: the power asterisk (*) on an accent tile. Follows the theme's accent colors. */
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="24" fill="var(--accent)" />
      <g stroke="var(--accent-ink)" strokeWidth="11" strokeLinecap="round">
        <line x1="50" y1="25" x2="50" y2="75" />
        <line x1="28.35" y1="37.5" x2="71.65" y2="62.5" />
        <line x1="28.35" y1="62.5" x2="71.65" y2="37.5" />
      </g>
    </svg>
  );
}
