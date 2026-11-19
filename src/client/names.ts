const ADJECTIVES = ['Swift', 'Sharp', 'Clever', 'Bold', 'Quick', 'Bright', 'Keen', 'Lucky', 'Calm', 'Brave', 'Witty', 'Nimble', 'Sly', 'Eager', 'Jolly', 'Mighty'];
const ANIMALS = ['Otter', 'Tiger', 'Falcon', 'Fox', 'Panda', 'Heron', 'Lynx', 'Badger', 'Owl', 'Koala', 'Raven', 'Gecko', 'Bison', 'Marten', 'Puffin', 'Wombat'];

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** A friendly placeholder name like "Swift Otter". */
export const randomName = () => `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
