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

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Typo-tolerant equality for normalized strings. Numbers must match exactly. */
export function fuzzyEq(a: string, b: string): boolean {
  if (a === b) return true;
  const at = a.split(' ');
  const bt = b.split(' ');
  // Same number of words: compare word by word so "vitamin b" never matches "vitamin a".
  if (at.length > 1 && at.length === bt.length) return at.every((w, i) => fuzzyWord(w, bt[i]));
  return fuzzyWord(a, b);
}

function fuzzyWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  const len = Math.max(a.length, b.length);
  const allowed = len <= 3 ? 0 : len <= 6 ? 1 : len <= 10 ? 2 : Math.floor(len * 0.2);
  return levenshtein(a, b) <= allowed;
}
