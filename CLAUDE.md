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
- `shared/types.ts`: all client/server JSON types, `Settings` + `DEFAULT_SETTINGS`, `CATEGORIES`, bot skills, daily-challenge types. `shared/accounts.ts`: account types. `shared/reports.ts`: question-report reasons and admin list types.
- `server/index.ts`: networking only (sockets and HTTP → `Room` / `Daily` / `Accounts`)
- `server/rooms/room.ts`: the game state machine (~1400 lines): timers, buzz arbitration, bonuses, reader and its look-ahead queue, protests, daily-challenge mode. Most game behavior changes go here.
- `server/rooms/bots.ts`: host-added computer players (skill levels in `PROFILES`), ticked from `index.ts`
- `server/rooms/store.ts`: `RoomStore` interface, in-memory implementation
- `server/game/`: pure logic: `text.ts` (normalizing, typo tolerance), `answerLine.ts` (parsing answer lines), `answerCheck.ts`, `scoring.ts`
- `server/questions/`: QBReader / built-in catalog (`catalog/`, original questions) / sample / upload providers
- `server/accounts/`: sign-up, sessions, profiles, game history, friends (presence comes from `index.ts`), admin (`ADMIN_ACCOUNT_IDS`), optional email with password reset and optional confirming (`mailer.ts`, one-time links in the store's `tokens`). Emails are private: never put them in a profile, room state or log.
- `shared/profile.ts`: profile visibility, pinnable stats (`PIN_STATS`) and badges (`BADGES`, worked out from saved games + daily results by `badgesFor`, nothing stored); badge rewards: profile colors (`PROFILE_COLORS`, light + dark values) and avatar frames (`AVATAR_FRAMES`), each unlocked by one badge. `PATCH /api/me` checks the badge (`Accounts.earnedBadges`), `lookFor` falls back to the defaults; drawn by `Avatar`/`tint` in `client/components/Account.tsx`
- `shared/topics.ts`: standalone topics (`TOPICS`). Deep ones map to QBReader slices (category + subcategory or `alternateSubcategories`; QBReader also returns untagged questions for an alternate filter, so `QBReaderProvider` re-checks with `inTopic`). Fun ones use built-in questions tagged by topic id (`catalog/topics.ts`, `TOPIC_TAGS` in `catalog/index.ts` and `lightning.ts`). `TopicMix` (providers.ts) picks one picked topic or the category filter per question and falls back to built-in questions.
- `server/daily/`: daily challenge: one 10-tossup set per day (US Eastern), stored once, leaderboard
- `server/reports/`: question reports. Players report a finished tossup by its review number (`question:report`); `Room.reportTarget` looks the question up from the room's own review, so only finished tossups can be reported. `reports.ts` validates, dedupes (same reporter + question) and rate-limits; `store.ts` is file (`data/reports-<port>.json`) or Postgres (`question_reports`). Admins list and close them with `site:reports` / `site:resolveReport` in `SiteAdmin.tsx`.
- `server/survival/`: survival: endless solo tossups until 3 misses. `questions.ts` (QBReader with rising difficulty, built-in catalog fallback), `store.ts` (every run; boards rank each player's best, all time and this week from Monday Eastern), `survival.ts` (status, profile, recording). The run itself (`s.survival`, lives, marks, `onSurvivalDone`) lives in `room.ts`
- `client/components/AppSettings.tsx`: `SettingsMenu`, the gear's menu on every screen (`AccountBar` on home and profiles, `RoomView`, `Spectate`): **Account settings** (`AccountSettings.tsx`: username with a 7-day cooldown via `POST /api/me/username`, which `Accounts.onRename` carries to daily/survival rows and live room seats; email + confirmation; password via `POST /api/password/change`; log out) and **Game settings** (this device: sound, vibration, text size, theme). The host's per-room rules are `SettingsPanel`, labelled **Room settings**.
- `client/components/`: `Stage.tsx` (main play view), `RoomView`, `Lobby`, `SettingsPanel`, `Scoreboard`, `Review`, `Rulings`, `Summary`, `Chat`, `ReaderQueue` (reader's Up next), `Report` (Report link + form, in `Review` and on the tossup-end card), `SiteAdmin` (site admin panel), `Daily`, `Survival` (home card, boards, lives, results), `Account`/`Profile`, `Friends` (right-edge tab + slide-out panel on home, profiles and rooms between games; profile button), `AdminPanel`, `Spectate` (big-screen view at `/watch/CODE`, server viewer id `SPECTATOR`), `ScoreGraph`, `Feedback` (result/buzz flashes and sounds)
- `client/recap.ts`: draws the shareable game-recap image (canvas). `components/WakeScreen.tsx`: "waking up the server" screen until the first socket connect (the service worker opens the cached shell after 3 s on a slow navigation). `components/CategoryChip.tsx`: per-category hues. Tossups carry `answerKey` (accept/prompt/reject + this viewer's misses) only after they end, for "why was I wrong".
- `client/components/AppSettings.tsx`: this device's settings (sound on/off, volume `qb:volume`, buzz sound, vibration `qb:vibrate`, text size, theme), from the room's gear / ⋯ → Settings and Home. The host's room rules are `SettingsPanel` ("Game settings").
- `server/stats/` + `shared/stats.ts`: owner stats. `Room.recordResults` hands an anonymous `GameSummary` to `RoomIO.gameSummary`; `daily:status` (asked on every home visit) counts the device once a day as a salted hash. `site:stats` serves `StatsView` to `AdminStats.tsx` in the site admin panel. File or Postgres (`stats_games`, `stats_visits`).
- `client/components/Tutorial.tsx`: How to play (4 cards + a practice tossup that runs only on the device and scores nothing, so it may pause for hints; real games stay server-timed). Opened from Home (first-visit line, `qb:tourSeen`, and a How to play link) and the room ⋯ menu.
- Topic voting (party mode) lives in `Room` (`openVote` / `castVote` / `closeVote`; the winner runs for `voteRunLength()` tossups as `s.voteRun`, no vote until it ends) and `Stage.tsx` (`VotePanel`).
- `client/install.ts` + `public/manifest.webmanifest` + `public/sw.js`: install as an app. The service worker must never intercept `/socket.io`, `/api` or `/healthz`.
- `tests/`: one file per area. `room.test.ts` drives `Room` through the `RoomIO` interface with fake timers.

## Rules to keep
- The server owns all timing and every ruling. Clients never decide anything. Players never receive words before they're read, or answers before the tossup ends. Only the reader gets both early, plus a site admin who turned on Peek (answers only, in `snapshot`'s admin extras).
- Daily-challenge and survival rooms must stay fair: fixed settings and questions (no packet upload), solo, and nothing that changes a score (adjust, override, protests, reader seat, bots, pause) is allowed. Survival also can't skip a tossup, and its timers keep running while the player is away, so a reload can't dodge a miss (it rejoins the same run). A survival run ends at 0 lives, on End run, or when its idle room is cleaned up, and is recorded once. The client's `roles(s).fixed` is true in both. Friends' presence hides both kinds of room, and site announcements skip players in the middle of one. While one is running, only a site admin can watch it (`room:watch`), and protests can't be filed in either.
- `Room` touches the network only through `RoomIO`, which keeps it testable without sockets.
- Rooms are in memory and saved to `data/rooms-<port>.json` (`Room.toJSON` / `Room.restore`), so deploys use a single instance. A restored game comes back paused.
- Only one answer scores on a tossup: the earliest correct one. When a protest or override reverses a ruling, `settleTossup` cancels later correct answers on that tossup (`voidedBy`, 0 points) and gives them back if it's reversed again; it also moves the bonus to the right team.
- Timers go through `setTimer` so the whole-game pause (`pauseGame`) can freeze and resume them. Don't call `setTimeout` directly in `Room`.
- Moderation (`kick`/ban, `mute`, `allowRebuzz`) is for the host, the reader, or a site admin in any room, never in the daily challenge, and nobody but an admin can act on an admin.
- Admin panel (`SiteAdmin.tsx`, the 🛡 button by an admin's name on home and profiles, and a room's Admin button): one tabbed panel. **This room** (inside a room only; `RoomAdmin` in `AdminPanel.tsx`: seats, renames), **Stats** (`AdminStats` + account counts), **Rooms** (watch/join/message/close), **Players** (`AdminPlayers.tsx`: who's online via `site:online`, whisper/shake anyone via `site:whisper` / `site:shake`, account search `site:users` with reset name/bio, badges, log out everywhere `site:logoutUser`, delete; emails show only as set/confirmed, never the address), **Troll** (`RoomTroll` in a room, plus announce/shake every screen), **Reports**, **Feedback**, **Server** (`site:server`: version, uptime, storage, mail kind; `site:testEmail` sends to the admin's own address; admin lock). Site-wide trolls skip anyone mid-daily or mid-survival. Admin only, server-checked.
- Admin-only troll tools (`setPeek`, `freeze`, `setSlowed` (buzzes count `SLOW_WORDS` late), `whisper`, `shake`, `forceBuzz`, `adminRename`, `announce`) are secret by design: peeking, freezing and slowing never appear in anyone else's state or chat. The owner chose to let Peek work in the daily challenge too; slow, whisper, shake and force-buzz refuse daily and survival rooms (`noTrollHere`). Their admin panel is not documented in `README.md`.
- Feedback effects stay minimal and quiet (thin edge glow, small chips, soft sounds). The owner asked for smooth and minimalistic, nothing flashy.
- Phone layout matters most: most players are on phones. Check changes at 375px wide.

## Deployment
- Live at https://playtrivio.onrender.com (Render free plan, service `playtrivio`, Oregon, created by hand, not from a Blueprint). `trivio.onrender.com` and `buzzbowl.onrender.com` belong to other people on Render. Auto-deploy on `main` is on.
- `render.yaml` matches the live service's settings but no Blueprint is connected to it. Connecting one would create a second service.
- GitHub `justtkeno/BuzzBowl`. Render auto-deploys `main`, so changes go in on a feature branch and a pull request merged into `main`.
- Render env vars (set in the Render dashboard, never in code): `DATABASE_URL` (Neon Postgres, also holds daily-challenge tables), `ADMIN_ACCOUNT_IDS`, and `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET` + `GMAIL_REFRESH_TOKEN` + `MAIL_FROM` for account emails, sent through the Gmail API over HTTPS (`server/accounts/mailer.ts`). Render's free plan blocks SMTP ports, so `SMTP_URL` only works on other hosts; without either, production can't send resets. Reset links use `PUBLIC_URL`, else Render's `RENDER_EXTERNAL_URL`, never the request's Host header. `/healthz` reports `"accounts":"postgres"` when the database is connected.
- The free plan sleeps after ~15 minutes idle; the first visit takes 30–60 s to wake it.
- Without `DATABASE_URL` (local or cloud sessions), accounts and the daily challenge use JSON files in `data/`, never the live database. QBReader may be unreachable from sandboxes; the built-in catalog works offline.

## Don't read
`dist/`, `node_modules/`, `data/` and `package-lock.json` are generated.
