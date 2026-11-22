import { describe, expect, it } from 'vitest';
import { checkAnswer, checkAnswerDetailed } from '../src/server/game/answerCheck';
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
    expect(line.prompt[0]).toMatchObject({ full: 'organelles', required: ['organelle'] });
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

describe('forgiving near misses', () => {
  const VG = 'Vincent <b><u>van Gogh</u></b> [or Vincent Willem <b><u>van Gogh</u></b>; accept <b><u>Gogh</u></b>]';
  const HE = '<b><u>helium</u></b> [or <b><u>He</u></b>]';
  it.each([
    ['hleium', HE, 'correct'], // swapped letters
    ['heluim', HE, 'correct'],
    ['vangogh', VG, 'correct'], // missing space
    ['van goh', VG, 'correct'],
    ['missisippi', '<b><u>Mississippi</u></b> River', 'correct'], // doubled letters
    ['colloseum', '<b><u>Colosseum</u></b>', 'correct'],
    ['tolstoi', 'Leo <b><u>Tolstoy</u></b>', 'correct'],
    ['vitamin b', '<b><u>vitamin A</u></b>', 'incorrect'],
    ['vitaminb', '<b><u>vitamin A</u></b>', 'incorrect'],
    ['cat', '<b><u>car</u></b>', 'incorrect'],
    ['iron', '<b><u>neon</u></b>', 'incorrect'],
    ['revolution of 1798', '<b><u>Revolution of 1789</u></b>', 'incorrect'],
  ] as const)('%s → %s', (given, line, expected) => {
    expect(checkAnswer(given, line)).toBe(expected);
  });

  it('says what a misspelled answer was accepted as, and stays quiet for exact ones', () => {
    expect(checkAnswerDetailed('mitocondria', MITO)).toEqual({ verdict: 'correct', correctedTo: 'mitochondria' });
    expect(checkAnswerDetailed('Mitochondria', MITO)).toEqual({ verdict: 'correct' });
    expect(checkAnswerDetailed('tolstoy', 'Leo <b><u>Tolstoy</u></b>')).toEqual({ verdict: 'correct' });
    expect(checkAnswerDetailed('vangogh', 'Vincent <b><u>van Gogh</u></b>')).toEqual({ verdict: 'correct', correctedTo: 'Vincent van Gogh' });
    expect(checkAnswerDetailed('organelles', MITO)).toEqual({ verdict: 'prompt' });
  });
});

describe('correction labels', () => {
  it('names short answers in full and long ones by their underlined part', () => {
    expect(checkAnswerDetailed('sikhsim', '<b><u>Sikh</u></b>ism [or <b><u>Sikhi</u></b>]').correctedTo).toBe('Sikhism');
    expect(checkAnswerDetailed('hastngs', 'Battle of <b><u>Hastings</u></b>').correctedTo).toBe('Battle of Hastings');
    expect(checkAnswerDetailed('cuban misile crisis', 'Cuban <b><u>Missile</u></b> <b><u>Crisis</u></b> of October 1962').correctedTo).toBe('Missile Crisis');
  });
});

describe('underlined parts and abbreviations', () => {
  // How QBReader packets write it: bold around the whole answer, the required parts underlined.
  const DC = '<b><u>Washington</u>, <u>District of Columbia</u></b> [accept either underlined part]';
  it.each([
    ['Washington dc', 'correct'],
    ['Washington D.C.', 'correct'],
    ['washington', 'correct'], // "either underlined part"
    ['District of Columbia', 'correct'],
    ['DC', 'correct'],
    ['d.c.', 'correct'],
    ['washington district of columbia', 'correct'],
    ['columbia', 'incorrect'],
    ['seattle washington', 'incorrect'],
    ['washington state', 'incorrect'],
  ])('"%s" for Washington, D.C. is %s', (given, verdict) => {
    expect(checkAnswer(given, DC)).toBe(verdict);
  });

  it('treats "either underlined part" as an instruction, not an answer', () => {
    const line = parseAnswerLine(DC);
    expect(line.accept.map((a) => a.display)).toEqual(['Washington, District of Columbia', 'Washington', 'District of Columbia']);
  });

  it('uses the underline, not the bold around it, as the required part', () => {
    expect(parseAnswerLine('<b>Battle of <u>Hastings</u></b>').accept[0].required).toEqual(['hastings']);
    expect(checkAnswer('hastings', '<b>Battle of <u>Hastings</u></b>')).toBe('correct');
    // Bold alone still marks the required part.
    expect(parseAnswerLine('<b>Kierkegaard</b>, Soren').accept[0].required).toEqual(['kierkegaard']);
  });

  it('without the instruction, several underlined parts still all count', () => {
    expect(checkAnswer('cuban missile crisis', 'Cuban <b><u>Missile</u></b> <b><u>Crisis</u></b> of October 1962')).toBe('correct');
    expect(checkAnswer('cuban missile', 'Cuban <b><u>Missile</u></b> <b><u>Crisis</u></b> of October 1962')).toBe('incorrect');
  });

  it.each([
    ['FDR', 'Franklin Delano <b><u>Roosevelt</u></b>', 'correct'], // three words: initials always work
    ['fdr', 'Franklin Delano <b><u>Roosevelt</u></b>', 'correct'],
    ['USSR', '<b><u>Union of Soviet Socialist Republics</u></b>', 'correct'],
    ['US', '<b><u>United States</u></b>', 'correct'], // two words: only typed as an abbreviation
    ['U.S.', '<b><u>United States</u></b>', 'correct'],
    ['us', '<b><u>United States</u></b>', 'incorrect'],
    ['lt', 'Leo <b><u>Tolstoy</u></b>', 'incorrect'],
    ['ww', '<b><u>World War</u></b> II', 'incorrect'],
  ])('initials: "%s" for %s is %s', (given, line, verdict) => {
    expect(checkAnswer(given, line)).toBe(verdict);
  });

  it('an abbreviation is not shown as a corrected typo', () => {
    expect(checkAnswerDetailed('Washington DC', DC)).toEqual({ verdict: 'correct' });
  });
});
