import type { Bonus, Tossup } from './types';

// A small original practice packet so the app works offline and in tests.
// Format matches what uploads accept: question text with a (*) power mark,
// answer lines with <b><u>required</u></b> parts and [accept / prompt / do not accept] clauses.

const t = (id: string, category: string, subcategory: string, question: string, answer: string): Tossup =>
  ({ id: `sample-t${id}`, category, subcategory, question, answer, difficulty: 3, setName: 'Sample Packet', year: 2026 });

export const SAMPLE_TOSSUPS: Tossup[] = [
  t('1', 'Science', 'Biology',
    'The number of these structures in a cell can increase through fission, and a protein called Drp1 helps them divide. Their inner membrane is rich in cardiolipin, and the endosymbiotic theory holds that they descend from alphaproteobacteria. They have their own circular genome, which is usually inherited only from the mother. Folds called cristae line the inside of, for 10 points, (*) what organelle, the site of the Krebs cycle and oxidative phosphorylation, often called the "powerhouse of the cell"?',
    '<b><u>mitochondria</u></b> [or <b><u>mitochondrion</u></b>; prompt on <u>organelle</u>s; do not accept "chloroplast"]'),
  t('2', 'Literature', 'European Literature',
    'This author described a peasant mowing scene in which a landowner loses himself in the rhythm of the scythe, and he wrote about a man who realizes on his deathbed that his proper life was a lie in The Death of Ivan Ilyich. In one novel, Konstantin Levin\'s happy marriage contrasts with an affair that ends at a railway station. For 10 points, name this author of (*) Anna Karenina and War and Peace.',
    'Leo <b><u>Tolstoy</u></b> [or Lev Nikolayevich <b><u>Tolstoy</u></b>]'),
  t('3', 'History', 'European History',
    'During this event, the Brunswick Manifesto threatened Parisians if harm came to the royal family, and the Law of Suspects expanded arrests. The Thermidorian Reaction ended its most radical phase after the fall of Robespierre. It began after the Estates-General became a National Assembly, which swore the (*) Tennis Court Oath. For 10 points, name this revolution that began with the storming of the Bastille in 1789.',
    '<b><u>French</u></b> Revolution [accept <b><u>Revolution of 1789</u></b>; prompt on <u>revolution</u>]'),
  t('4', 'Fine Arts', 'Visual Fine Arts',
    'This artist painted a cypress tree that reaches like a dark flame into the sky over a village with a church steeple. He painted his bedroom in Arles in several versions, and he cut off part of his own ear after an argument with Paul Gauguin. For 10 points, name this Dutch post-impressionist who painted (*) Sunflowers and The Starry Night.',
    'Vincent <b><u>van Gogh</u></b> [or Vincent Willem <b><u>van Gogh</u></b>; accept <b><u>Gogh</u></b>]'),
  t('5', 'Science', 'Chemistry',
    'This element\'s name comes from the Greek word for "sun," since it was found in the solar spectrum before it was isolated on Earth. Its isotope with mass number 3 is rare and used in dilution refrigerators, and below about 2.17 kelvin its most common isotope becomes a superfluid. For 10 points, name this (*) noble gas with atomic number 2 that makes balloons float.',
    '<b><u>helium</u></b> [or <b><u>He</u></b>]'),
  t('6', 'Mythology', 'Mythology',
    'This figure was bound to a rock where an eagle ate his liver every day, until Heracles freed him. He tricked Zeus into choosing the bones and fat of a sacrificed ox instead of the meat at Mecone. His brother Epimetheus accepted Pandora as a bride. For 10 points, name this (*) Titan who stole fire from the gods and gave it to humans.',
    '<b><u>Prometheus</u></b>'),
  t('7', 'Geography', 'Geography',
    'This river\'s basin includes the Casiquiare canal, which links it to the Orinoco. A tidal bore called the pororoca travels up its mouth, near the island of Marajó. Its tributaries include the Madeira and the Rio Negro, which meets it near Manaus in the "Meeting of Waters." For 10 points, name this (*) South American river that carries more water than any other on Earth.',
    '<b><u>Amazon</u></b> River [or Rio <b><u>Amazonas</u></b>; accept <b><u>Solimões</u></b> before "Rio Negro"]'),
  t('8', 'Social Science', 'Social Science',
    'This economist argued that a pin factory shows how dividing labor raises productivity, and he wrote The Theory of Moral Sentiments about sympathy. He used the phrase "invisible hand" to describe how self-interest can benefit society. For 10 points, name this Scottish author of (*) The Wealth of Nations.',
    'Adam <b><u>Smith</u></b>'),
  t('9', 'Science', 'Physics',
    'This quantity is conserved because physical laws do not change over time, according to Noether\'s theorem. Its SI unit is named for a man who studied the mechanical equivalent of heat. The work-energy theorem relates the work done on an object to the change in its kinetic form. For 10 points, name this (*) quantity measured in joules, which in Einstein\'s famous equation equals mass times the speed of light squared.',
    '<b><u>energy</u></b> [accept <b><u>mechanical energy</u></b> or <b><u>kinetic energy</u></b> before "kinetic"; prompt on <u>work</u>]'),
  t('10', 'Religion', 'Religion',
    'This religion\'s scripture, the Guru Granth Sahib, is treated as a living teacher. Its baptized members wear the five Ks, including a steel bracelet called the kara and uncut hair called kesh. Its holiest site is the Harmandir Sahib, or (*) Golden Temple, in Amritsar. For 10 points, name this religion founded by Guru Nanak in the Punjab.',
    '<b><u>Sikh</u></b>ism [or <b><u>Sikhi</u></b>; accept <b><u>Sikh</u></b>s]'),
  t('11', 'Literature', 'American Literature',
    'In this novel, an oculist\'s billboard with giant blue eyes looms over a gray "valley of ashes." Its narrator rents a house in West Egg and is the cousin of Daisy Buchanan. Its title character watches a green light across the bay and is killed by George Wilson. For 10 points, name this (*) F. Scott Fitzgerald novel about Jay Gatsby.',
    '<b><u>The Great Gatsby</u></b>'),
  t('12', 'History', 'American History',
    'This leader\'s administration created the Securities and Exchange Commission and the Tennessee Valley Authority. He tried to add justices to the Supreme Court in a "court-packing" plan. He gave fireside chats on the radio and said "the only thing we have to fear is fear itself" at his first (*) inauguration. For 10 points, name this four-term president who led the New Deal.',
    'Franklin Delano <b><u>Roosevelt</u></b> [or <b><u>FDR</u></b>; do not accept "Theodore Roosevelt"]'),
];

const b = (id: string, category: string, subcategory: string, leadin: string, parts: string[], answers: string[]): Bonus =>
  ({ id: `sample-b${id}`, category, subcategory, leadin, parts, answers, difficulty: 3, setName: 'Sample Packet', year: 2026 });

export const SAMPLE_BONUSES: Bonus[] = [
  b('1', 'Science', 'Chemistry', 'Answer the following about the periodic table, for 10 points each.',
    ['This Russian chemist published a periodic table in 1869 that left gaps for undiscovered elements.',
      'Group 17 of the periodic table contains these reactive nonmetals, including fluorine and chlorine.',
      'This element, number 79, has the chemical symbol Au.'],
    ['Dmitri <b><u>Mendeleev</u></b>', '<b><u>halogen</u></b>s', '<b><u>gold</u></b>']),
  b('2', 'Literature', 'British Literature', 'Name these works by William Shakespeare, for 10 points each.',
    ['In this play, a prince of Denmark speaks the soliloquy beginning "To be, or not to be."',
      'In this play, three witches prophesy that a Scottish general will become king.',
      'In this comedy, Puck puts a love potion on the wrong Athenian in an enchanted forest.'],
    ['<b><u>Hamlet</u></b>', '<b><u>Macbeth</u></b>', '<b><u>A Midsummer Night\'s Dream</u></b>']),
  b('3', 'History', 'Ancient History', 'Answer the following about ancient Rome, for 10 points each.',
    ['This general crossed the Rubicon in 49 BCE and was assassinated on the Ides of March.',
      'Caesar\'s adopted heir Octavian took this title, meaning "revered one," as the first emperor.',
      'This Carthaginian general crossed the Alps with elephants during the Second Punic War.'],
    ['Julius <b><u>Caesar</u></b> [or Gaius Julius <b><u>Caesar</u></b>]', '<b><u>Augustus</u></b>', '<b><u>Hannibal</u></b> Barca']),
  b('4', 'Fine Arts', 'Auditory Fine Arts', 'Name these composers, for 10 points each.',
    ['This composer continued writing music after going deaf, including his Ninth Symphony with its "Ode to Joy."',
      'This Austrian prodigy wrote The Magic Flute and a Requiem left unfinished at his death in 1791.',
      'This Baroque composer wrote the Brandenburg Concertos and The Well-Tempered Clavier.'],
    ['Ludwig van <b><u>Beethoven</u></b>', 'Wolfgang Amadeus <b><u>Mozart</u></b>', 'Johann Sebastian <b><u>Bach</u></b>']),
  b('5', 'Geography', 'Geography', 'Name these African countries, for 10 points each.',
    ['This country\'s capital, Addis Ababa, hosts the African Union, and it was never colonized except for a brief Italian occupation.',
      'This most populous African country has Abuja as its capital and Lagos as its largest city.',
      'This island nation off Africa\'s southeast coast is home to lemurs.'],
    ['<b><u>Ethiopia</u></b>', '<b><u>Nigeria</u></b>', '<b><u>Madagascar</u></b>']),
  b('6', 'Science', 'Biology', 'Answer the following about genetics, for 10 points each.',
    ['This Augustinian friar studied inheritance by crossing pea plants.',
      'Rosalind Franklin\'s X-ray images helped reveal that DNA has this shape.',
      'In DNA, adenine pairs with this base.'],
    ['Gregor <b><u>Mendel</u></b>', 'double <b><u>helix</u></b> [prompt on <u>spiral</u>]', '<b><u>thymine</u></b> [or <b><u>T</u></b>]']),
];
