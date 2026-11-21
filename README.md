# Trivio

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
2. The host opens **Settings** to pick free-for-all or teams, scoring, speed, and question filters. Settings can also change mid-match (⋯ menu → ⚙️ Settings on phones): a longer or shorter answer, buzz-window or bonus time applies to a clock that is already running, and chat tells everyone what changed.
3. **Start game.** Words appear as they are read. Press **Space** (or tap the big button) to buzz. Reading stops for everyone, you get 7 seconds to type, and others watch you type.
4. Scoring (NAQT-style, all configurable): 15 for a correct buzz before the `(*)`, 10 after it, −5 for a wrong answer before the question ends, 0 after. One buzz per player (or per team) per tossup.
5. In team mode, the team that converts the tossup gets a 3-part bonus. Teammates talk in **team chat**. The captain submits each part.
6. Press **N** (or **Next tossup**) to continue. **Review** shows every finished question with full text, answer line, and where each player buzzed. Spot a problem (a missing accepted answer, a typo, the wrong category)? Tap **Report** under the answer.
7. **End game** shows the summary: a podium, points, powers/tens/negs, points per tossup heard, average buzz depth, PPB, and a per-category breakdown. **Share recap** makes an image of the game to send or save.

Small things that help:
- Missed one? Under the answer, **you said “…”** explains why (didn’t match, would only have been prompted, or on the do-not-accept list) and lists what the answer line accepts.
- Each category has its own color chip, on the question, in Review and on profiles.
- **Text size** (⋯ menu, or **Aa** on a computer) makes the question text smaller or larger on that device.
- During a game the screen stays on, and leaving mid-match (or closing the tab) asks first.
- When the free server is asleep, the installed app shows **Waking up the server…** until it answers (usually 30–60 seconds).

### Party mode

For a quick free-for-all with no reader. In the lobby, the host taps **Party mode** (or picks **Party** under Format in Settings):

- **Read aloud**: every phone reads the tossup out loud with its built-in voice, in step with the words appearing on screen. Reading stops when someone buzzes and picks up again after a wrong answer. Each device can mute itself with the **Read aloud** chip on the question card, so in the same room one phone or the big-screen view can do the talking.
- **Topic vote**: after each tossup, players pick the next one's category from three choices (only categories the room's filters allow). The next tossup starts when everyone has voted, after 10 seconds, or when anyone taps **Start now** (or presses **N**). Keys **1**–**3** vote. Ties are broken at random.

Both are separate settings under **Without a reader**, so either can be used on its own. They switch off while someone holds the reader seat, and never apply to the daily challenge.

### Survival

**Survival** on the home page (under the daily challenge) is an endless solo run: tossups keep coming until you've missed 3. A wrong answer (a neg, or a wrong answer after the question ends) or a tossup that goes dead without a buzz costs a life; the three dots in the top bar are your lives. Your score is how many tossups you got right (ties go to points, then whoever got there first). Questions are mixed categories with no bonuses, a little harder the longer you last (built-in questions when QBReader can't be reached).

Like the daily challenge it's fixed and solo: same settings for everyone, nobody else can join, no skipping, pausing, reader, bots, protests or score changes. Reloading goes back into the same run, and the clock keeps going while you're away, so leaving can't save a life. A run you walk away from ends where it stands. **End run** in the ⋯ menu gives up and counts the tossups so far. At the end you see your run, your best ever and your rank, with **Play again**. The **Board** shows each player's best run, all time and this week (from Monday, Eastern time). Logged-in players get their best run on their profile.

### Reader (moderator) seat

Anyone can click **Be the reader** in the lobby. The reader:

- sees each full question and answer line in advance, with a teleprompter cursor that moves at the set speed, so they can read it out loud in person or on a voice call
- controls the pace: **Space** pauses/resumes, **→** moves on one word, clicking any word jumps the cursor there, and a speed slider adjusts the pace
- rules on answers with **A**ccept / **P**rompt / **R**eject (the auto-checker's verdict is shown as a suggestion; turn "Reader rules on answers" off to let the app rule)
- decides when to move on. Players can't skip ahead, and after a neg the reader resumes when ready
- can open **Review** to go back over previous questions before continuing
- runs the room like the host: **📚 Change questions** on the Up next card switches the source, categories, subcategories or difficulty mid-match (the current tossup finishes, the next one uses the new questions, and chat tells everyone), and in the lobby the reader can add, rename and remove teams, move players between teams, pick captains, and hand the reader seat to someone else

By default players don't see the text while the reader reads (they listen). Turn on "Show question text to players" to show it.

### Managing players

The host or reader can open **👥 Players** (top bar, or the ⋯ menu on a phone) to:

- **Mute** someone so they can't send chat messages, and unmute them later
- **Kick** someone out of the room (they can rejoin with the link)
- **Ban** someone: their seat and, if they're logged in, their account can't rejoin this room
- **Let buzz again**: give a player (or team) back their buzz on the tossup being read, for example after a misclick

Everyone sees a note in chat when one of these happens. None of them are available in the daily challenge.

### Big screen, pause and restarts

- **Big-screen view**: open `/watch/CODE` (or **📺 Big-screen view** in the lobby or ⋯ menu) on a projector or TV. It shows the question, buzzes and a large scoreboard, and never joins as a player.
- **Pause**: the host or reader can pause the whole game (❚❚ in the top bar). Every clock freezes, including answer and bonus timers.
- **Restarts**: rooms are saved to `data/rooms-<port>.json` every few seconds (set `DATA_DIR` to move it). After a restart, a running game comes back paused, players rejoin with their saved seat, and the old host keeps the host seat for 2 minutes. On free hosting with no persistent disk, a redeploy still wipes the file.

### Accounts and profiles

Anyone can still play as a guest. **Sign up** on the home screen (username + password) to get:

- a public profile at `/u/<username>` with games, wins, points per game and per tossup, powers/tens/negs, buzz accuracy and depth, best game, a per-subject breakdown with your **best subject**, and recent games
- a green check next to your name in rooms (links to your profile), and your seat back if you rejoin from another device
- your display name and room settings remembered on any device
- **badges** on your profile, earned from your games and daily challenges (first power, 10 in a row, clean sheet, daily champion, week streak and more). On your own profile, **Show all** lists the ones still to get, with progress
- **badge rewards**: badges unlock a **profile color** and **avatar frames** (ring, dashed, double ring, flame, star, halo), picked in **Edit profile**. They show on your profile, next to your name at the top of the page and in friends' lists. Tap a locked one to see which badge it needs
- **pinned stats**: in **Edit profile**, pick up to 3 stats (daily 1st places, points per game, buzz depth…) to show at the top of your profile
- **privacy**: in **Edit profile**, choose who sees your stats, badges and games: everyone, friends only, or only you. Your name and username always show so friends can find you
- **friends**: tap the small people tab on the right edge of the screen to slide out your friends, and add someone by username there (or with **Add friend** on their profile). Once they accept, you see who's online and who's in a room, with **Join** and **Watch** buttons. In a room, the tab shows in the lobby and after the game, never while questions are being read, and each online friend gets an **Invite** button: they see a small "Alex invited you to play · Join" banner wherever they are on the site. Friends only see your room after you've both said yes. Daily-challenge and survival rooms are never shown.

Results are saved when the host ends a game, or when everyone walks away from a game with at least 3 tossups heard. Solo games count toward stats but not wins. Passwords are hashed with scrypt, sessions are an HTTP-only cookie, and login/signup are rate-limited. There is no email password reset.

Accounts live in Postgres when `DATABASE_URL` is set, otherwise in `data/accounts-<port>.json` (fine for local use).

**Admins** get a creator badge, a **🛡 Admin** panel in every room (make anyone host or reader at any time, even mid-match), and on other players' profiles can reset an offensive display name, clear a bio, or delete the account.

- **Lock admin to your account (do this on a public server):** set `ADMIN_ACCOUNT_IDS` to your account id (comma-separated for several). The 🛡 Admin panel shows your id and a copy button. Once set, only those exact accounts are admins, so if the account list is ever wiped, someone re-registering your username gets nothing.
- **Unlocked fallback:** without `ADMIN_ACCOUNT_IDS`, admin goes by username: `Hao` by default, or `ADMIN_USERNAMES` (comma-separated, `""` for none). Whoever registers that username first on a server is admin, so this is only safe locally.

**Seats survive bad connections:** if the host or reader drops, their seat is held for 3 minutes and comes back automatically when they reconnect. Meanwhile the app reads on its own.

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

### Lightning round

Pick **⚡ Lightning round** as the question source in Settings for fast one-line prompts ("What element has the symbol Fe?"). There are about 200 original questions across every category, from Middle School to Medium College difficulty, and the category and difficulty filters work as usual. With no reader, each prompt appears all at once and everyone has at least 8 seconds to buzz. A right answer is 10 points, a wrong one is 0, and there are no bonuses. With a reader, they read each prompt aloud as normal.

### Answer checking

`src/server/game/answerCheck.ts` normalizes case, accents, punctuation and articles, tolerates small typos (Levenshtein, word by word, exact numbers), and reads answer lines: bold/underlined text is the required part, `[or …]`/`accept …` add alternatives, `prompt on …` triggers a prompt (up to 2, 5 seconds each), and `do not accept …` rejects.

## How the timing stays fair

The server owns the clock. It reveals each word (`tick` events) and records when it sent it. A buzz carries the number of words that client had shown. The server trusts that count only back to words sent within the last 1.2 s (plausible lag), and after the first buzz arrives it waits 120 ms for slower connections, then awards the buzz to whoever had seen the fewest words. Points (power vs. ten, neg vs. no penalty) use that word count. Clients never decide anything. Players never receive words before they're read, and players never receive answers before the tossup ends. Only the reader gets both early. Read aloud follows the same rule: a device only speaks words it has already been sent.

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
    daily/, survival/        daily challenge and survival: question picking, leaderboards (Postgres or JSON file)
  client/                    React app (Vite)
tests/                       Vitest unit tests (answer checking, scoring, room flow)
```

`Room` talks to the network only through the small `RoomIO` interface, so the tests drive it with fake timers and no sockets. Rooms live behind `RoomStore`. To scale beyond one process, implement it over Redis (persist `room.s`, converting its Sets to arrays) and use the Socket.IO Redis adapter with sticky sessions.

## Deploy for free

**Render**: push this folder to GitHub, then in Render choose *New → Blueprint* and select the repo. `render.yaml` sets it up (build `npm ci && npm run build`, start `npm run serve`). Free instances sleep when idle, so the first visit after a while takes ~30 s.

**Accounts need a database** on Render's free plan, because its disk is wiped on every deploy and restart. A free [Neon](https://neon.tech) Postgres works: create a project, copy its connection string (`postgresql://…`), and in Render open the service → *Environment* → add `DATABASE_URL` with that value. The server creates its tables on startup; `/healthz` shows `"accounts":"postgres"` when it's connected. Without `DATABASE_URL` the live site still runs, but accounts are lost on each restart.

**Fly.io**: install `flyctl`, then from this folder:

```bash
fly launch --no-deploy
```

```bash
fly deploy
```

The included `Dockerfile` listens on port 8080. Keep a single machine (`fly scale count 1`), since rooms live in memory.

Both platforms support WebSockets out of the box.
