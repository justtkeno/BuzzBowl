import { decodeEntities, normalize } from './text';

/** One acceptable (or promptable / rejected) answer. All strings normalized. */
export interface Alt {
  full: string;
  /** Required (bold/underlined) segments. Equals [full] when nothing is marked. */
  required: string[];
  /** Readable form for "accepted as …" feedback, e.g. "mitochondria". */
  display?: string;
}

export interface AnswerLine {
  accept: Alt[];
  prompt: Alt[];
  reject: Alt[];
}

const OPEN = '\u0001';
const CLOSE = '\u0002';

/** Turn bold/underline tags into marker characters, drop other tags and editor notes. */
function toMarked(raw: string): string {
  let s = raw.replace(/^\s*answer\s*:\s*/i, '');
  s = s.replace(/<\s*(b|u|strong)\b[^>]*>/gi, OPEN).replace(/<\s*\/\s*(b|u|strong)\s*>/gi, CLOSE);
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>\s*$/g, ''); // trailing editor tags like <ED> written as entities
  // Collapse nested markers (<b><u>x</u></b>) by tracking depth.
  let depth = 0;
  let out = '';
  for (const ch of s) {
    if (ch === OPEN) { if (depth++ === 0) out += OPEN; }
    else if (ch === CLOSE) { if (depth > 0 && --depth === 0) out += CLOSE; }
    else out += ch;
  }
  if (depth > 0) out += CLOSE;
  return out.replace(/\s+/g, ' ').trim();
}

function makeAlt(marked: string): Alt | null {
  const plain = marked.replace(/[\u0001\u0002]/g, '');
  const full = normalize(plain.replace(/["“”]/g, ''));
  if (!full) return null;
  const required: string[] = [];
  const re = /\u0001([^\u0002]*)\u0002/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(marked))) {
    const seg = normalize(m[1]);
    if (seg) required.push(seg);
  }
  const marks = [...marked.matchAll(/\u0001([^\u0002]*)\u0002/g)].map((x) => x[1].trim()).filter(Boolean);
  // Short answers read best in full ("Sikhism", "Leo Tolstoy"); long ones by their underlined part.
  const tidy = (x: string) => x.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  const display = tidy(plain).split(' ').length <= 4 || !marks.length ? tidy(plain) : tidy(marks.join(' '));
  return { full, required: required.length ? required : [full], display };
}

type Directive = 'accept' | 'prompt' | 'reject';

const DIRECTIVES: [RegExp, Directive][] = [
  [/^(?:do not|don'?t|dont)\s+(?:accept|prompt)(?:\s+or\s+prompt)?(?:\s+on)?\s+/i, 'reject'],
  [/^reject\s+/i, 'reject'],
  [/^(?:anti-?prompt|prompt)(?:\s+on)?\s+/i, 'prompt'],
  [/^(?:also\s+)?accept(?:s)?\s+/i, 'accept'],
  [/^or\s+/i, 'accept'],
];

const QUALIFIER = /\s+(?:before|until|after|by asking|with\s+"|when|if|since|as\s+in)\b.*$/i;
const FILLER = /^(?:answers?|anything|word forms?)\s+(?:mentioning|involving|describing|of|like)\s+|^(?:equivalents?|synonyms?)(?:\s+(?:of|like|such as))?\s*/i;

/** Split "X, Y, or Z" into items, without breaking inside a required segment. */
function splitItems(segment: string): string[] {
  const items: string[] = [];
  let cur = '';
  let inMark = false;
  const tokens = segment.split(/(\u0001|\u0002|,|\s+or\s+)/i);
  for (const t of tokens) {
    if (t === OPEN) inMark = true;
    if (t === CLOSE) inMark = false;
    if (!inMark && (t === ',' || /^\s+or\s+$/i.test(t))) { items.push(cur); cur = ''; }
    else cur += t;
  }
  items.push(cur);
  return items.map((i) => i.trim()).filter(Boolean);
}

export function parseAnswerLine(raw: string): AnswerLine {
  const line: AnswerLine = { accept: [], prompt: [], reject: [] };
  const marked = toMarked(raw);
  const firstBracket = marked.search(/[\[(]/);
  const main = firstBracket === -1 ? marked : marked.slice(0, firstBracket);
  const clauses: string[] = [];
  const re = /\[([^\]]*)\]|\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  if (firstBracket !== -1) {
    const rest = marked.slice(firstBracket);
    while ((m = re.exec(rest))) clauses.push(m[1] ?? m[2] ?? '');
  }

  // The main answer may itself be "X or Y" when both sides carry markers.
  const mainParts = main.split(/\s+or\s+/i);
  const mainSplit = mainParts.length > 1 && mainParts.filter((p) => p.includes(OPEN)).length > 1;
  for (const p of mainSplit ? mainParts : [main]) {
    const alt = makeAlt(p);
    if (alt) line.accept.push(alt);
  }

  for (const clause of clauses) {
    let directive: Directive = 'accept';
    for (let seg of clause.split(';')) {
      seg = seg.trim();
      let matched = false;
      for (const [rx, d] of DIRECTIVES) {
        // Directive words sit outside markers; peek at text with markers removed.
        const probe = seg.replace(/[\u0001\u0002]/g, '');
        const hit = probe.match(rx);
        if (hit) {
          directive = d;
          seg = dropPrefix(seg, hit[0].length);
          matched = true;
          break;
        }
      }
      if (!matched && /^(?:note|this|the moderator|accept equivalents)/i.test(seg)) continue;
      for (let item of splitItems(seg)) {
        item = item.replace(QUALIFIER, '').replace(FILLER, '').trim();
        if (!item || /^equivalents?$/i.test(item)) continue;
        const alt = makeAlt(item);
        if (alt) line[directive].push(alt);
      }
    }
  }
  return line;
}

/** Remove `n` visible characters from the front of a marked string, keeping markers. */
function dropPrefix(seg: string, n: number): string {
  let i = 0;
  let seen = 0;
  let kept = '';
  while (i < seg.length && seen < n) {
    const ch = seg[i];
    if (ch === OPEN || ch === CLOSE) kept += ch; else seen++;
    i++;
  }
  return (kept + seg.slice(i)).trim();
}
