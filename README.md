# BuzzBowl

Real-time multiplayer quiz bowl practice that plays like a tournament match: pyramidal tossups read word by word, server-judged buzzer races, powers and negs, team bonuses, protests, and a reader (moderator) seat for reading questions aloud.

## Run it

Requires Node 20+.

```bash
npm install
npm start
```

Open http://localhost:3000. `npm start` builds the client and starts the server. To share on your network, give friends `http://<your-ip>:3000`.

For development with hot reload:

```bash
npm run dev
```

Open http://localhost:5173 (Vite proxies the socket to the server on :3000).

Other scripts: `npm test` (unit tests), `npm run typecheck`, `npm run build` + `npm run serve` (production).

## How to play

1. **Create room** → share the 4-letter code or invite link. **Solo practice** starts a private room immediately.
2. The host opens **Settings** to pick free-for-all or teams, scoring, speed, and question filters.
3. **Start game.** Words appear as they are read. Press **Space** (or tap the big button) to buzz. Reading stops for everyone, you get 7 seconds to type, and others watch you type.
4. Scoring (NAQT-style, all configurable): 15 for a correct buzz before the `(*)`, 10 after it, −5 for a wrong answer before the question ends, 0 after. One buzz per player (or per team) per tossup.
5. In team mode, the team that converts the tossup gets a 3-part bonus. Teammates talk in **team chat**. The captain submits each part.
6. Press **N** (or **Next tossup**) to continue. **Review** shows every finished question with full text, answer line, and where each player buzzed.
7. **End game** shows the summary: points, powers/tens/negs, points per tossup heard, average buzz depth, PPB, and a per-category breakdown.

### Reader (moderator) seat

Anyone can click **Be the reader** in the lobby. The reader:

- sees each full question and answer line in advance, with a teleprompter cursor that moves at the set speed, so they can read it out loud in person or on a voice call
- controls the pace: **Space** pauses/resumes, **→** moves on one word, clicking any word jumps the cursor there, and a speed slider adjusts the pace
- rules on answers with **A**ccept / **P**rompt / **R**eject (the auto-checker's verdict is shown as a suggestion; turn "Reader rules on answers" off to let the app rule)
- decides when to move on. Players can't skip ahead, and after a neg the reader resumes when ready
- can open **Review** to go back over previous questions before continuing

By default players don't see the text while the reader reads (they listen). Turn on "Show question text to players" to show it.

### Protests and corrections

Every ruling appears in the **Rulings** tab. Any player can protest one, and the host or reader upholds (which reverses the ruling and rescores) or denies it. The host or reader can also mark any ruling right/wrong directly or adjust a player's score by ±5. Reversing a ruling on the tossup that just ended also awards (or removes) that tossup's bonus.

## Questions

- **QBReader** (default): random questions from https://www.qbreader.org/api-docs with category, subcategory, difficulty (1 = middle school … 10 = open) and year filters. Category names live in `src/shared/types.ts` (`CATEGORIES`). Edit them there if QBReader renames one.
- **Sample packet**: 12 original tossups and 6 bonuses built in, so the app works offline.
- **Upload**: a JSON file like `examples/sample-packet.json`:

  ```json
  {
    "tossups": [{ "question": "… (*) …", "answer": "<b><u>Required part</u></b> [accept X; prompt on Y; do not accept Z]", "category": "Science", "subcategory": "Biology" }],
    "bonuses": [{ "leadin": "…", "parts": ["…", "…", "…"], "answers": ["…", "…", "…"], "category": "History" }]
  }
  ```

  QBReader-shaped objects (`question_sanitized`, `answer_sanitized`, `set.name` …) are accepted too, as is a bare array of tossups.

No question repeats within a room's session.

### Answer checking

`src/server/game/answerCheck.ts` normalizes case, accents, punctuation and articles, tolerates small typos (Levenshtein, word by word, exact numbers), and reads answer lines: bold/underlined text is the required part, `[or …]`/`accept …` add alternatives, `prompt on …` triggers a prompt (up to 2, 5 seconds each), and `do not accept …` rejects.

## How the timing stays fair

The server owns the clock. It reveals each word (`tick` events) and records when it sent it. A buzz carries the number of words that client had shown. The server trusts that count only back to words sent within the last 1.2 s (plausible lag), and after the first buzz arrives it waits 120 ms for slower connections, then awards the buzz to whoever had seen the fewest words. Points (power vs. ten, neg vs. no penalty) use that word count. Clients never decide anything. Players never receive words before they're read, and players never receive answers before the tossup ends. Only the reader gets both early.

## Project layout

```
src/
  shared/types.ts            JSON types shared by client and server
  server/
    index.ts                 Express + Socket.IO wiring (networking only)
    game/                    pure game logic: text normalization, answer lines, answer checking, scoring
    questions/               QBReader / local / uploaded question providers, sample packet
    rooms/room.ts            room state machine (timers, buzz arbitration, bonuses, reader, protests)
    rooms/store.ts           RoomStore interface + in-memory implementation
  client/                    React app (Vite)
tests/                       Vitest unit tests (answer checking, scoring, room flow)
```

`Room` talks to the network only through the small `RoomIO` interface, so the tests drive it with fake timers and no sockets. Rooms live behind `RoomStore`. To scale beyond one process, implement it over Redis (persist `room.s`, converting its Sets to arrays) and use the Socket.IO Redis adapter with sticky sessions.

## Deploy for free

**Render**: push this folder to GitHub, then in Render choose *New → Blueprint* and select the repo. `render.yaml` sets it up (build `npm ci && npm run build`, start `npm run serve`). Free instances sleep when idle, so the first visit after a while takes ~30 s.

**Fly.io**: install `flyctl`, then from this folder:

```bash
fly launch --no-deploy
```

```bash
fly deploy
```

The included `Dockerfile` listens on port 8080. Keep a single machine (`fly scale count 1`), since rooms live in memory.

Both platforms support WebSockets out of the box.
