import { describe, expect, it } from 'vitest';
import { checkAnswer } from '../src/server/game/answerCheck';
import { parseAnswerLine } from '../src/server/game/answerLine';
import { fuzzyEq, normalize, safeAnswerHtml } from '../src/server/game/text';

const MITO = '<b><u>mitochondria</u></b> [or <b><u>mitochondrion</u></b>; accept <b><u>powerhouse</u></b> of the cell; prompt on <u>organelle</u>s; do not accept "chloroplast"]';
const FRENCH = '<b><u>French</u></b> Revolution [accept <b><u>Revolution of 1789</u></b>; prompt on <u>revolution</u>]';

describe('normalize / fuzzy', () => {
  it('strips case, punctuation, accents and articles', () => {
    expect(normalize('  The Great Gatsby! ')).toBe('great gatsby');
    expect(normalize('Émile Zola')).toBe('emile zola');
    expect(normalize("Hammurabi's Code")).toBe('hammurabis code');
  });
  it('keeps a trailing "a" in vitamin A', () => expect(normalize('vitamin A')).toBe('vitamin a'));
  it('tolerates small typos but not short-word swaps', () => {
    expect(fuzzyEq('mitocondria', 'mitochondria')).toBe(true);
    expect(fuzzyEq('vitamin b', 'vitamin a')).toBe(false);
    expect(fuzzyEq('cat', 'car')).toBe(false);
  });
  it('requires exact numbers', () => expect(fuzzyEq('1798', '1789')).toBe(false));
});

describe('parseAnswerLine', () => {
  it('splits accept / prompt / reject clauses and reads underlines', () => {
    const line = parseAnswerLine(MITO);
    expect(line.accept.map((a) => a.full)).toEqual(['mitochondria', 'mitochondrion', 'powerhouse of cell']);
    expect(line.accept[2].required).toEqual(['powerhouse']);
    expect(line.prompt[0]).toEqual({ full: 'organelles', required: ['organelle'] });
    expect(line.reject[0].full).toBe('chloroplast');
  });
  it('handles plain answer lines without markup', () => {
    const line = parseAnswerLine('mitochondria [or mitochondrion; prompt on organelles]');
    expect(line.accept).toHaveLength(2);
    expect(line.prompt).toHaveLength(1);
  });
  it('drops qualifiers like "before" and "until read"', () => {
    const line = parseAnswerLine('<b><u>Amazon</u></b> River [accept <b><u>Solimões</u></b> before "Rio Negro"]');
    expect(line.accept[1].full).toBe('solimoes');
  });
});

describe('checkAnswer', () => {
  it.each([
    ['mitochondria', MITO, 'correct'],
    ['Mitocondria', MITO, 'correct'],
    ['powerhouse', MITO, 'correct'],
    ['organelles', MITO, 'prompt'],
    ['chloroplast', MITO, 'incorrect'],
    ['', MITO, 'incorrect'],
    ['tolstoy', 'Leo <b><u>Tolstoy</u></b>', 'correct'],
    ['Leo Tolstoy', 'Leo <b><u>Tolstoy</u></b>', 'correct'],
    ['leo', 'Leo <b><u>Tolstoy</u></b>', 'incorrect'],
    ['tolstoy dostoevsky', 'Leo <b><u>Tolstoy</u></b>', 'incorrect'],
    ['french revolution', FRENCH, 'correct'],
    ['revolution', FRENCH, 'prompt'],
    ['revolution of 1789', FRENCH, 'correct'],
    ['the great gatsby', '<b><u>The Great Gatsby</u></b>', 'correct'],
    ['vitamin b', '<b><u>vitamin A</u></b>', 'incorrect'],
    ['hastings', 'Battle of <b><u>Hastings</u></b>', 'correct'],
    ['Theodore Roosevelt', 'Franklin Delano <b><u>Roosevelt</u></b> [or <b><u>FDR</u></b>; do not accept "Theodore Roosevelt"]', 'incorrect'],
    ['FDR', 'Franklin Delano <b><u>Roosevelt</u></b> [or <b><u>FDR</u></b>; do not accept "Theodore Roosevelt"]', 'correct'],
    ['Sikhism', '<b><u>Sikh</u></b>ism [or <b><u>Sikhi</u></b>]', 'correct'],
    ['helium', 'ANSWER: <b><u>helium</u></b>', 'correct'],
  ] as const)('%s → %s', (given, line, expected) => {
    expect(checkAnswer(given, line)).toBe(expected);
  });
});

describe('safeAnswerHtml', () => {
  it('keeps b/u and strips scripts and attributes', () => {
    expect(safeAnswerHtml('<b class="x"><u>A</u></b><script>alert(1)</script> & co')).toBe('<b><u>A</u></b>alert(1) &amp; co');
    expect(safeAnswerHtml('<img src=x onerror=alert(1)>')).toBe('');
  });
});
