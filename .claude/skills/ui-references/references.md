# Reference brands

Principles to borrow, with concrete values. Don't copy logos, mascots, illustrations, brand colors or exact layouts.

## Linear: smoothness and restraint
- **Take:** fast, consistent motion. Most transitions are 150–200ms with a strong ease-out (`cubic-bezier(.2, .8, .2, 1)`), so things feel instant but never snap. Hover and press states on everything you can click.
- **Take:** layered, very soft shadows (a 1px tight shadow plus a wide, faint one) and 1px borders at low contrast, so surfaces separate without heavy lines.
- **Take:** in dark mode, raised surfaces get *lighter*, not shadowed, and a faint top highlight (`inset 0 1px 0 rgb(255 255 255 / 4–6%)`).
- **Avoid:** dense, tiny text and the desktop-app information density. Trivio is a phone game.

## Duolingo: game feel
- **Take:** buttons feel physical. A press moves them down 1–2px and drops the shadow (or scales to ~0.97), and releasing springs back. Every press gets an answer the same instant.
- **Take:** generous, rounded, friendly shapes: large radii (14–20px on cards) and big, bold primary buttons that fill the width on phones.
- **Take:** progress and streaks made visible and rewarding (levels, XP, daily streaks), with a short celebratory moment at the *end* of something, not during play.
- **Avoid:** loud colors everywhere, a bouncing mascot, confetti during a question. The owner wants it minimal.

## Apple: type and space
- **Take:** clear type hierarchy. Big, tight headlines (letter-spacing about −0.02em, weight 700–750), calm body text, muted secondary text. Use fewer sizes, but make each one count.
- **Take:** whitespace as structure. Group with space before reaching for borders, and use a consistent 4/8px spacing scale.
- **Take:** content enters gently, fading and rising 6–12px over about 240ms, once, and never on every re-render.
- **Avoid:** huge marketing-page scroll effects and full-bleed hero imagery.

## Trivio-specific taste (from the owner)
- Smooth and minimalistic, nothing flashy (`CLAUDE.md`).
- The orange accent (`--accent`) is the brand. Keep it, and refine how it's used rather than replacing it.
- The reading experience (serif question text, word-by-word) is the heart of the game. Polish it, don't redesign it.
