---
name: ui-references
description: Use whenever designing, restyling or revamping any Trivio screen or component (home, lobby, stage, profile, menus, buttons, motion). Applies the design principles distilled from the owner's reference brands in references.md, the project's own taste rules, and a before/after screenshot check at phone width.
---

# Trivio UI reference workflow

The owner wants Trivio to feel **engaging, smooth and polished, but minimal: nothing flashy**. These reference brands set the bar. Borrow their *principles* (spacing, motion, hierarchy, feedback), never their logos, illustrations, mascots, exact layouts or brand colors.

## Before changing anything
1. Read `references.md` (next to this file) and pick the patterns that fit the screen you're working on.
2. Take "before" screenshots at **375 × 812**, in light and dark, of every screen you'll touch (see "Screenshots" below).
3. Change design tokens in `src/client/styles.css` `:root` first (color, radius, shadow, motion). Only touch components after that.

## The top goal: it must not look AI-generated
The owner's main reason for the revamp is that Trivio shouldn't look "clearly AI generated". Polish isn't enough. It needs a point of view that comes from quiz bowl itself. Before finishing any UI change, check the screen against these tells and remove any you find:
- the default system/Inter-style font as the only typeface, with a heavy wordmark
- a pastel rounded-square icon, then a title, a gray subtitle and a chevron (the stock "feature card")
- everything inside one centered, rounded, soft-shadowed card on a beige or near-white background
- warm beige with burnt orange, or purple-to-blue gradients
- glossy gradient sheen on buttons, colored glow shadows, soft radial background glows
- numbered step circles, ⓘ bubbles everywhere, pills and chips for every label
- uniform 12–16px radii on everything, with every element equally rounded
- copy that explains every heading in a gray subtitle; generic phrases ("at your own pace", "see how you rank")
- stock line icons doing the work that type, layout or a real illustration should do
What to do instead: a distinctive typeface pairing, layout with hierarchy and asymmetry (not stacks of equal cards), details drawn from quiz bowl (packets, score sheets, buzzer hardware, scoreboards), varied radii (sharp where things are "printed"), short copy with a voice, and one accent used sparingly.

## Rules that always apply
- **Phones first.** Most players are on phones. Everything must work at 375px with no sideways scroll, and every tap target must be at least 44px tall.
- **Light and dark.** Every color is a token defined in all three places in `styles.css`: `:root`, the `prefers-color-scheme: dark` block and `[data-theme='dark']`. Never hard-code a color in a component.
- **Motion is feedback, not decoration.** Use the `--ease-*` and `--dur-*` tokens. UI moves in 120–240ms; nothing loops forever except a loading indicator. Everything respects `prefers-reduced-motion`.
- **Animate only `transform` and `opacity`** (plus colors), so it stays at 60fps on cheap phones. Never animate width, height or top/left during play.
- **One primary button per screen.** It gets the accent color and depth; everything else stays quiet.
- **The game screen is sacred.** The question text, buzz button and timers must never shift, jump or get covered by an animation. Feedback stays a thin edge glow, small chips and soft sounds (see `Feedback.tsx`).
- Keep the names the app already uses (Room settings, Game settings, etc.). See `CLAUDE.md` "Layout and wording".

## Screenshots
Run the app (`npm run build && npm run serve`, port 3000), then use Playwright with `viewport {width: 375, height: 812}` and `colorScheme` set to `light` and to `dark`. QBReader is often unreachable from sandboxes, so switch the room's question source to built-in questions before starting a game. Compare before and after side by side, and check for overflow, clipped text, contrast in dark mode and layout shift.

## Adding a new reference
When the owner names a new site, add it to `references.md` as: name, what to take from it, and what *not* to take. If the network allows, screenshot it at 375px and 1280px, and pull concrete values from its CSS (font sizes, spacing steps, transition durations and easings). Record the values, not the brand.
