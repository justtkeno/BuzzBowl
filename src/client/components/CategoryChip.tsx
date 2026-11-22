/** Each category gets its own hue, so you can tell at a glance what came up. Lightness comes from the theme in CSS. */
const HUE: Record<string, number> = {
  Literature: 215, History: 28, Science: 150, 'Fine Arts': 315, Religion: 265, Mythology: 0,
  Philosophy: 185, 'Social Science': 45, 'Current Events': 350, Geography: 120, 'Other Academic': 240, 'Pop Culture': 290,
};

/** A stable hue for any category, including ones the list doesn't know (uploaded packets, lightning). */
export function categoryHue(category: string): number {
  if (category in HUE) return HUE[category];
  let h = 0;
  for (const ch of category) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function CategoryChip({ category, sub, icon }: { category: string; sub?: string; icon?: string }) {
  return (
    <span className="cat-chip" style={{ ['--h' as string]: categoryHue(category) }}>
      {icon ? <span aria-hidden="true">{icon}</span> : <span className="cat-dot" aria-hidden="true" />}{category}{sub && sub !== category ? <span className="cat-sub"> · {sub}</span> : null}
    </span>
  );
}

export function CategoryDot({ category }: { category: string }) {
  return <span className="cat-dot solo" style={{ ['--h' as string]: categoryHue(category) }} aria-hidden="true" />;
}
