# Trivio

Formerly BuzzBowl (the GitHub repo keeps that name).

Real-time multiplayer quiz bowl practice: tossups read word by word, buzzing, powers/negs, bonuses, a reader seat, protests, bots, accounts, and a daily challenge. Installable as a phone app. User-facing docs: `README.md`.

## Stack
TypeScript throughout, Node 20+. Server: Express + Socket.IO, run with `tsx`. Client: React 18 + Vite (root `src/client`, builds to `dist/client`, static files in `src/client/public`). Tests: Vitest. Storage: Postgres (`pg`) when `DATABASE_URL` is set, otherwise JSON files in `data/`.

## Commands
- `npm run dev`: server on :3000 + Vite on :5173 with hot reload
- `npm start`: build the client, then serve on :3000
- `npm test`, `npm run typecheck`
- `npm run build` after client changes when serving `dist/` (`npm run serve`)

## Layout (`src/`)
- `shared/types.ts`: all client/server JSON types, `Settings` + `DEFAULT_SETTINGS`, `CATEGORIES`, bot skills, daily-challenge types. `shared/accounts.ts`: account types.
- `server/index.ts`: networking only (sockets and HTTP → `Room` / `Daily` / `Accounts`)
- `server/rooms/room.ts`: the game state machine (~1400 lines): timers, buzz arbitration, bonuses, reader and its look-ahead queue, protests, daily-challenge mode. Most game behavior changes go here.
- `server/rooms/bots.ts`: host-added computer players (skill levels in `PROFILES`), ticked from `index.ts`
- `server/rooms/store.ts`: `RoomStore` interface, in-memory implementation
- `server/game/`: pure logic: `text.ts` (normalizing, typo tolerance), `answerLine.ts` (parsing answer lines), `answerCheck.ts`, `scoring.ts`
- `server/questions/`: QBReader / built-in catalog (`catalog/`, original questions) / sample / upload providers
- `server/accounts/`: sign-up, sessions, profiles, game history, admin (`ADMIN_ACCOUNT_IDS`)
- `server/daily/`: daily challenge: one 10-tossup set per day (US Eastern), stored once, leaderboard
- `client/components/`: `Stage.tsx` (main play view), `RoomView`, `Lobby`, `SettingsPanel`, `Scoreboard`, `Review`, `Rulings`, `Summary`, `Chat`, `ReaderQueue` (reader's Up next), `Daily`, `Account`/`Profile`, `AdminPanel`, `Spectate` (big-screen view at `/watch/CODE`, server viewer id `SPECTATOR`), `ScoreGraph`, `Feedback` (result/buzz flashes and sounds)
- `client/speech.ts`: read-aloud (text-to-speech) for rooms with no reader; speaks only words already revealed. Topic voting lives in `Room` (`openVote` / `castVote` / `closeVote`) and `Stage.tsx` (`VotePanel`).
- `client/install.ts` + `public/manifest.webmanifest` + `public/sw.js`: install as an app. The service worker must never intercept `/socket.io`, `/api` or `/healthz`.
- `tests/`: one file per area. `room.test.ts` drives `Room` through the `RoomIO` interface with fake timers.

## Rules to keep
- The server owns all timing and every ruling. Clients never decide anything. Players never receive words before they're read, or answers before the tossup ends. Only the reader gets both early, plus a site admin who turned on Peek (answers only, in `snapshot`'s admin extras).
- Daily-challenge rooms must stay fair: fixed settings, solo, and nothing that changes a score (adjust, override, protests, reader seat, bots, pause) is allowed.
- `Room` touches the network only through `RoomIO`, which keeps it testable without sockets.
- Rooms are in memory and saved to `data/rooms-<port>.json` (`Room.toJSON` / `Room.restore`), so deploys use a single instance. A restored game comes back paused.
- Timers go through `setTimer` so the whole-game pause (`pauseGame`) can freeze and resume them. Don't call `setTimeout` directly in `Room`.
- Moderation (`kick`/ban, `mute`, `allowRebuzz`) is for the host, the reader, or a site admin in any room, never in the daily challenge, and nobody but an admin can act on an admin.
- Admin-only troll tools (`setPeek`, `freeze`, `adminRename`, `announce`) are secret by design: peeking and freezing never appear in anyone else's state or chat. The owner chose to let Peek work in the daily challenge too. Their admin panel is not documented in `README.md`.
- Feedback effects stay minimal and quiet (thin edge glow, small chips, soft sounds). The owner asked for smooth and minimalistic, nothing flashy.
- Phone layout matters most: most players are on phones. Check changes at 375px wide.

## Deployment
- Live at https://playtrivio.onrender.com (Render free plan, service `playtrivio`, Oregon, created by hand, not from a Blueprint). `trivio.onrender.com` and `buzzbowl.onrender.com` belong to other people on Render. Auto-deploy on `main` is on.
- `render.yaml` matches the live service's settings but no Blueprint is connected to it. Connecting one would create a second service.
- GitHub `justtkeno/BuzzBowl`. Render auto-deploys `main`, so changes go in on a feature branch and a pull request merged into `main`.
- Render env vars (set in the Render dashboard, never in code): `DATABASE_URL` (Neon Postgres, also holds daily-challenge tables) and `ADMIN_ACCOUNT_IDS`. `/healthz` reports `"accounts":"postgres"` when the database is connected.
- The free plan sleeps after ~15 minutes idle; the first visit takes 30–60 s to wake it.
- Without `DATABASE_URL` (local or cloud sessions), accounts and the daily challenge use JSON files in `data/`, never the live database. QBReader may be unreachable from sandboxes; the built-in catalog works offline.

## Don't read
`dist/`, `node_modules/`, `data/` and `package-lock.json` are generated.
