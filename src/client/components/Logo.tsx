/**
 * The Trivio mark: the "i" of Trivio, dotted with the power star (*). Same shapes as public/icons/icon.svg
 * (regenerate the PNGs with scripts/make-icons.cjs after changing either). Follows the theme's accent colors.
 */
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="15" fill="var(--accent)" />
      <rect x="27.5" y="32.5" width="9" height="22" rx="4.5" fill="var(--accent-ink)" />
      <g stroke="var(--accent-ink)" strokeWidth="4.6" strokeLinecap="round">
        <line x1="32" y1="10" x2="32" y2="27" />
        <line x1="24.64" y1="14.25" x2="39.36" y2="22.75" />
        <line x1="24.64" y1="22.75" x2="39.36" y2="14.25" />
      </g>
    </svg>
  );
}
