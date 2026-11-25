const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'", '&mdash;': '—', '&ndash;': '–',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? (e.startsWith('&#') ? String.fromCharCode(Number(e.slice(2, -1))) : e));
}

export function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

const ALLOWED = new Set(['b', 'u', 'i', 'em', 'strong']);

/** Keep only b/u/i/em/strong tags (without attributes) and escape everything else. */
export function safeAnswerHtml(s: string): string {
  const out: string[] = [];
  const re = /<\s*(\/?)\s*([a-z0-9]+)[^>]*>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  const esc = (t: string) => decodeEntities(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  while ((m = re.exec(s))) {
    out.push(esc(s.slice(last, m.index)));
    const tag = m[2].toLowerCase();
    if (ALLOWED.has(tag)) out.push(`<${m[1]}${tag}>`);
    last = re.lastIndex;
  }
  out.push(esc(s.slice(last)));
  return out.join('');
}

const LEADING_ARTICLES = new Set(['a', 'an', 'the']);

/** Lowercase, strip accents and punctuation, drop "the" and leading articles. */
export function normalize(s: string): string {
  const words = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && LEADING_ARTICLES.has(words[0])) words.shift();
  return (words.length > 1 ? words.filter((w) => w !== 'the') : words).join(' ');
}

/** Edit distance where swapping two neighbouring letters ("hleium") counts as one typo. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** "mississipi" and "misissippi" both become "misisipi": doubled letters are the most common misspelling. */
const undouble = (s: string) => s.replace(/(.)\1+/g, '$1');

/** Keys next to each other on a QWERTY keyboard, where most phone typos land. */
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const NEIGHBORS = new Map<string, Set<string>>();
ROWS.forEach((row, r) => [...row].forEach((ch, c) => {
  const near = new Set<string>();
  for (const dr of [-1, 0, 1]) {
    const other = ROWS[r + dr];
    if (!other) continue;
    // Rows are staggered: the row below sits half a key to the right.
    const cols = dr === 0 ? [c - 1, c + 1] : dr === 1 ? [c - 1, c] : [c, c + 1];
    for (const k of cols) if (other[k]) near.add(other[k]);
  }
  NEIGHBORS.set(ch, near);
}));
const near = (x: string, y: string | undefined) => !!y && !!NEIGHBORS.get(x)?.has(y);

/**
 * Edit distance in half-typos, counting how phone keyboards fail: hitting the key next to the right one
 * ("jupitet"), or brushing it on the way ("jupiyter"), costs half a typo; any other slip costs a whole one.
 * `a` is what was typed, `b` the answer.
 */
export function typoCost(a: string, b: string): number {
  if (a === b) return 0;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j * 2);
  for (let i = 1; i <= a.length; i++) {
    const x = a[i - 1];
    const cur = [i * 2];
    for (let j = 1; j <= b.length; j++) {
      const y = b[j - 1];
      const sub = x === y ? 0 : near(x, y) ? 1 : 2;
      // An extra key typed next to the letter it sits beside.
      const extra = near(x, b[j - 1]) || near(x, b[j]) ? 1 : 2;
      cur[j] = Math.min(prev[j] + extra, cur[j - 1] + 2, prev[j - 1] + sub);
      if (i > 1 && j > 1 && x === b[j - 2] && a[i - 2] === y) cur[j] = Math.min(cur[j], prev2[j - 2] + 2);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length] / 2;
}

/** How many typos a word of this length may have. */
const typoBudget = (len: number) => (len <= 3 ? 0 : len <= 6 ? 1 : len <= 10 ? 2 : Math.floor(len * 0.2));

/**
 * Typo-tolerant equality for normalized strings (`a` typed, `b` the answer). Numbers must match exactly.
 * `loose` allows one more typo in words of five or more letters: close enough to ask the player to check
 * their spelling, never enough to accept.
 */
export function fuzzyEq(a: string, b: string, loose = false): boolean {
  if (a === b) return true;
  const at = a.split(' ');
  const bt = b.split(' ');
  // Same number of words: compare word by word so "vitamin b" never matches "vitamin a".
  if (at.length > 1 && at.length === bt.length) return at.every((w, i) => fuzzyWord(w, bt[i], loose));
  // Spacing slips: "vangogh" for "van gogh", "new york city" for "newyork city".
  if (at.length !== bt.length) {
    const as = a.replace(/ /g, '');
    const bs = b.replace(/ /g, '');
    // A one- or two-letter word ("vitamin a", "type b") is the whole point of the answer: no typos there.
    const hasTiny = [...at, ...bt].some((w) => w.length <= 2);
    if (/\d/.test(as + bs) || hasTiny) return as === bs || undouble(as) === undouble(bs);
    return fuzzyWord(as, bs, loose);
  }
  return fuzzyWord(a, b, loose);
}

/** Small linking words inside answers ("moons of Jupiter", "Leonardo da Vinci"). */
const CONNECTORS = new Set(['of', 'and', 'in', 'on', 'for', 'to', 'the', 'de', 'la', 'le', 'du', 'des', 'del', 'von', 'van']);

/** `a` is what the player typed, `b` the answer's word. */
function fuzzyWord(a: string, b: string, loose = false): boolean {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  // A slip on a linking word ("moons od jupiter") is still the answer, unless they typed a different
  // linking word ("in" for "on"), which can change the meaning.
  if (CONNECTORS.has(b) && !CONNECTORS.has(a) && a.length === b.length && levenshtein(a, b) <= 1) return true;
  // Loose only for slips that keep the length ("dickens" is not a misspelled "dickinson").
  const extra = loose && Math.max(a.length, b.length) >= 5 && Math.abs(a.length - b.length) <= 1 ? 1 : 0;
  if (closeEnough(a, b, extra)) return true;
  // Doubled-letter mistakes are free: "colosseum"/"coloseum", "gandhi"/"ghandi" still needs the h swap.
  const ua = undouble(a), ub = undouble(b);
  if (ua === a && ub === b) return false;
  return Math.max(ua.length, ub.length) > 3 && closeEnough(ua, ub, extra);
}

/** Within the word's typo budget, where neighbouring-key slips count half but buy at most one extra slip. */
function closeEnough(a: string, b: string, extra: number): boolean {
  const budget = typoBudget(Math.max(a.length, b.length)) + extra;
  return typoCost(a, b) <= budget && levenshtein(a, b) <= budget + 1;
}
