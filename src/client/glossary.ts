// Plain-English meanings of quiz bowl and Trivio words. Shown by the small ⓘ buttons (Info.tsx) and on /help.

export interface Term { title: string; text: string }

export const GLOSSARY = {
  tossup: { title: 'Tossup', text: 'A question read one word at a time. Anyone can buzz in as soon as they know the answer. It starts with hard clues and gets easier toward the end.' },
  pyramidal: { title: 'Pyramidal', text: 'Questions go from hardest clue to easiest, so whoever knows the most can buzz earliest. The last sentence usually gives it away.' },
  buzz: { title: 'Buzzing', text: 'Tap Buzz (or press Space) to stop the question and answer. If two people buzz close together, whoever had heard fewer words gets it.' },
  power: { title: 'Power', text: 'A correct buzz before the (*) mark in the question. It’s worth extra, usually 15 points instead of 10.' },
  ten: { title: 'Ten (correct answer)', text: 'A correct buzz after the (*) mark, or when the question has no mark. Usually 10 points.' },
  neg: { title: 'Neg', text: 'A wrong buzz before the question finishes. It costs points (usually −5), and the question keeps going for everyone else. A wrong answer after the question ends costs nothing.' },
  bonus: { title: 'Bonus', text: 'Three questions for the team (or player) who got the tossup right, worth 10 each. Nobody else can buzz, and teammates can talk it over.' },
  prompt: { title: 'Prompt', text: 'Your answer was close but not specific enough. You get a few seconds to say more, for example a full name.' },
  buzzWindow: { title: 'Buzz window', text: 'How many seconds players can still buzz after the last word is read.' },
  answerTime: { title: 'Time to answer', text: 'How long you have to type your answer after buzzing. If time runs out, whatever you typed is checked.' },
  wpm: { title: 'Reading speed', text: 'How fast the question appears, in words per minute. 200 is a comfortable speed; tournament readers are often faster.' },
  reader: { title: 'Reader', text: 'An optional person who reads the questions out loud and runs the game: they see each question early, set the pace and rule on answers. With no reader, the app shows the words on screen.' },
  host: { title: 'Host', text: 'The person who made the room. They pick the settings, start the game, and can pause, skip or end it.' },
  captain: { title: 'Captain', text: 'In teams mode, the player who types the team’s bonus answers.' },
  protest: { title: 'Protest', text: 'If you think your answer was marked wrong (or someone else’s right) by mistake, you can protest. The host or reader looks at it and decides.' },
  bounty: { title: 'Bounty tossup', text: 'Now and then a tossup is marked as a bounty before it’s read: a correct answer is worth double. Negs stay the same.' },
  ffa: { title: 'Free-for-all', text: 'Everyone plays for themselves and gets their own score.' },
  teams: { title: 'Teams', text: 'Players join teams of up to 4. A buzz locks out the whole team, and the team that gets a tossup right plays the bonus together.' },
  party: { title: 'Party mode', text: 'Free-for-all where, between tossups, everyone votes on the next topic.' },
  daily: { title: 'Daily challenge', text: 'The same 10 tossups for everyone, once a day (it resets at midnight US Eastern). Play once, then see how you rank. Guests can play too, but only signed-in players are ranked.' },
  survival: { title: 'Survival', text: 'Solo tossups that keep coming and slowly get harder, until you miss three. Try to beat your best run.' },
  lightning: { title: 'Lightning round', text: 'Short, quick questions instead of full-length tossups.' },
  ppg: { title: 'Points per game', text: 'Your average score per game.' },
  ppth: { title: 'Points per tossup heard', text: 'Points divided by tossups you were there for. It compares players fairly even when games are different lengths.' },
  depth: { title: 'Buzz depth', text: 'How far into the question you buzz on correct answers, on average. Lower means earlier, which means you knew it from harder clues.' },
  conversion: { title: 'Conversion', text: 'The share of tossups you heard that you got right.' },
  pn: { title: 'P / 10 / N', text: 'Powers, tens (correct after the power mark) and negs.' },
} satisfies Record<string, Term>;

export type TermId = keyof typeof GLOSSARY;
