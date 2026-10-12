# CodwellTornement — review & improvement plan

Review of `main` at `53b7e8d` (after the BGA bridge work). Status: **Phase 0 done** (scheduler rebuilt plus the bug fixes); later phases are still to do.

Scope: `src/index.js` (3,533 lines), `src/codenamesBridge.js`, `public/index.html` (2,942 lines),
tests, Docker/CI. The BoardGameArena bot was read for patterns to borrow, not reviewed.

Legend: 🔴 bug / risk · 🧹 dead code · ⚡ efficiency · 🎨 UI/UX · 🧠 BGA-bot learning · ❓ needs a decision

---

## Phase 0 — Fix bugs first (small, high value)

- [x] 🔴 **Scheduler rebuilt** (`src/scheduler.js`, `test/scheduler.test.js`), as agreed on 2026-10-12.
      **Goal:** every pair teams up against every other player, i.e. every set of three players shares a group at least once.
      **Match:** a group of 4 plays 6 games, covering all 3 team splits, each as drawn and then with both teams swapping roles.
      Games a group already played in the old format are skipped, so some matches are shorter. The same four players never meet as a group twice.
      **How:** a covering design (greedy plus simulated annealing) is packed into rounds, then the rounds are tuned and compressed.
      For 14 players that gives about 34 rounds and ~100 matches; the floor is 31 rounds and 91 matches. 8 and 10 players hit the floor.
      **Live tournament:** the switch is the web admin **Fix Matchups** button (`recalculate-rounds` → `fixMatchups()`).
      It rebuilds all future rounds at once and treats the current round as finishing as scheduled; all history counts.
      It no longer archives and reposts the current round. The old 10×players cut-off is gone.
- [x] 🔴 **A corrupt `tournament.json` gets wiped.** In `loadTournamentData` (`src/index.js:281`) any error, a JSON parse error included,
      is treated as "no previous data". The next save then overwrites the file. Fix: only treat `ENOENT` as fresh. On any other error, back up the file and stop.
- [x] 🔴 **Saves aren't atomic or serialised.** `saveTournamentData` calls `fs.writeFile` straight onto the live file and is fired from many places at once.
      A crash part-way through, or two overlapping writes, can corrupt it. Fix: write to `tournament.json.tmp`, then `rename`, behind a single save queue.
      (Phase 4 has the bigger fix.)
- [x] 🔴 **Force-end loses games that were already played.** Force-end (web `force-end`, plus the three Discord copies) drops `activeMatches`.
      Games already logged in an unfinished match stay in `scores`, but they never reach `history`.
      So scores, games-played counts, stats and the scheduler's "played" set stop agreeing.
      Fix: push the logged `phaseResults` to `history`/`roundResults` before dropping the match.
- [x] 🔴 **Force-end on the final round leaves the deadline set.** Web `force-end` and the Discord copies don't clear `roundDeadline`, so the dashboard keeps showing it.
- [x] 🔴 Force-end archives threads through `guild.channels.cache.get`, which misses threads that aren't cached. Use `fetch` (the timeout path already does).
- [x] 🔴 `sendRoundExpiry` sorts `tournament.roundResults` and `activeMatches` in place, and labels match numbers "Game N".
      For multi-game matches it lists one line per game rather than per match.

## Phase 1 — Remove dead code (≈700–900 lines out of `index.js`)

- [ ] 🧹 **The whole Discord admin panel can't be reached.** Nothing has created a `customId('admin')` button since `be41312` moved admin to the web.
      So these handlers are dead: `admin`, `admin_start`, `admin_allocate`, `admin_scores`, `admin_force_end`, `admin_adjust_score`,
      `admin_reset`, `admin_reopen_signups`, `admin_fix_matchups`, `debug_seed_players`, and the `adjust_score_modal` submit.
      None of them re-check the admin role, so they would be a hole if a button ever came back. Delete them, or re-add them properly as slash commands (Phase 3).
- [ ] 🧹 Buttons that are never created: ~~`force_end_round`, `timeout_force_end`~~ (removed; all force-ends now go through `forceEndRound()`) (the expiry embed now points to the website) and `correct_result_` (a legacy stub).
- [ ] 🧹 The `outcome_modal_*_assassin_*` branch: assassin wins skip the modal, so `parts[3] === 'assassin'` never happens.
- [ ] 🧹 The `log_` handler's `processingThreads` guard only covers showing an ephemeral prompt, so it adds nothing.
- [ ] 🧹 Unused functions: ~~`markConfigsAsPlayed`, `generateGrouping`~~ (removed with the old scheduler), `processGameResult` (a one-line wrapper), `startThreadKeepAlive` (an alias).
- [ ] 🧹 Unused or legacy state: `playedGroupings`, `currentGrouping` (only in the reset object), `currentRoundIndex` (only drives a "Match 0/N" label).
      `game1Result` has been superseded by `phaseResults`; load old files through a one-time migration and remove it.
- [ ] 🧹 Unused vars `autoAllocated` and `autoAllocated2`. A stray `0` after `console.log('Commands registered');`. `buildSignupDescription` logs the player list on every call.
- [ ] 🧹 The **`MessageContent` privileged intent** is requested, but there is no `messageCreate` handler. Drop it, along with `GuildMessages` if nothing needs it.
- [ ] 🧹 `.github/copilot-instructions.md` is VS Code scaffold boilerplate. Replace it with real repo notes, or delete it.
- [ ] 🧹 The README documents the Discord admin panel, a "Correct Result" button and "private threads" (threads are public). Update it after the deletions.

## Phase 2 — De-duplicate and restructure (do this before new features)

`index.js` handles Discord, scheduling, scoring, persistence, HTTP, OAuth and the bridge all in one file. Each piece below is written 2–4 times:

- [ ] ⚡ **Scoreboard text** (rank, points, games): written 4 times (`/tournament`, `admin_start`, two branches of `updateScoreboard`). → `renderScoreboardLines()`.
- [ ] ⚡ **Apply or reverse score**: written 4 times (`recordGameResult`, `rollbackSingleGameScore`, `override-result`, `delete-result`). → `applyGameScore(grouping, result, sign)`.
      Put the points rule (`3 / +1 if ≤3 left / −1 assassin`) in one `pointsFor()`.
- [x] ⚡ **Force-end**: 4 copies (3 Discord, 1 web). → `forceEndRound(guild)` (it picks up the Phase 0 fixes).
- [ ] ⚡ **Reset**: 2 copies, including a hand-written default-state object. → `freshTournament()`, used by the initial state, reset and load.
- [ ] ⚡ **Start tournament**: 2 copies. **Reopen signups**: 2 copies. **Signup embed and row**: 3 copies.
- [ ] ⚡ The player list `[g.blue.spymaster, g.blue.guesser, g.red.spymaster, g.red.guesser]` appears more than 20 times. → `playersOf(grouping)`.
- [ ] ⚡ The `isAdmin` + "is a player" check is pasted into each handler. → `canActOnMatch(interaction, match)`.
- [ ] 🧠 Split into modules, following the BGA bot's layout (`client` / `monitor` / `commands` / `views` / `cards` / `store`):
      `src/state.js` (load/save/migrate), `src/scheduler.js` (pure, testable), `src/scoring.js`, `src/discord/{interactions,cards,threads}.js`,
      `src/web/{server,auth,admin}.js`, plus the existing `codenamesBridge.js`. Do it as a plain move first, with no behaviour change.
- [ ] 🧠 Replace the `if/else if` chain on `customId` with a handler map (`{ prefix → handler }`).

## Phase 3 — Discord UI/UX

- [ ] 🎨 Admin in Discord: either commit to "web only" (and drop the dead code), or add a `/tournament admin <action>` slash command
      with `setDefaultMemberPermissions` and a server-side role check. Recommendation: web only, plus `/tournament status`.
- [ ] 🎨 Show the round's deadline and live status (from `bridgeStatus`) on the scoreboard embed, not only on the website.
- [ ] 🎨 The `admin_start` setup message shows "Match 0/N". Remove the label, or show "0/N matches completed" as `updateScoreboard` does.
- [x] 🎨 The round summary embed has one field per game, so a round with more than 25 games (e.g. 7 matches × 4) breaks the 25-field limit. The send then fails and the summary is lost: `roundResults` is cleared in the `catch`. Group the fields by match, or split across embeds.
- [ ] 🎨 Ping the four players when their thread is created (a thread mention plus `allowedMentions`), so nobody misses a round. The README already lists this as a roadmap item.
- [ ] 🎨 Remaining-cards modal: the input accepts 1 character but the label says "0-8". Fine, but say "of the losing team" to make it clear.
- [ ] 🧠 Optional: move cards to **Components V2** (`ContainerBuilder` / `SectionBuilder` / `TextDisplayBuilder`, discord.js ≥14.19; 14.26 is installed), like the BGA bot's cards.
      You get a cleaner match card, with the line-up, the live room state and the result buttons in one message.
- [ ] ⚡ `allocateRound` deletes up to 100 channel messages one at a time. Use `channel.bulkDelete(filter, true)`. It also deletes any message in the channel, including human chat. Consider tracking bot message IDs and deleting only those.

## Phase 4 — Persistence, security and ops (BGA-bot learnings)

- [ ] 🧠 **SQLite** (`better-sqlite3`) in place of whole-file JSON rewrites, the way the BGA bot does it (schema file, migrations, `history` as rows).
      If that's too big a step, atomic JSON plus a schema version and a `migrate()` step (Phase 0) covers most of the risk.
- [ ] 🧠 **Persist dashboard sessions.** They live in memory now, so every restart logs admins out. The BGA bot stores them in the DB.
- [ ] 🧠 **CSRF token** on admin POSTs. The BGA bot uses an HMAC of the session. Today the check only works when `WEB_URL` is set *and* the browser sends `Origin`.
- [ ] 🧠 **Security headers** on HTML responses (`X-Frame-Options: DENY`, `Content-Security-Policy`, `Referrer-Policy`), as `dashboard.py` sets them.
- [ ] 🔴 **Request body limit.** `readBody` reads without a limit. Cap it at 64 KB, as the BGA bridge API does (`client_max_size`).
- [ ] ⚡ `/api` is public, and each call sends **everything**: all of `history`, including the clue-by-clue `detail` and board for every bridged game, `rounds`, and raw `activeMatches`.
      `activeMatches` carries `bridgeEvents` and `pendingBridgeResults`. Cache the serialised payload until the next save, add `ETag` and gzip,
      move `detail` to a separate `/api/history` (or `/api/stats`), and stop sending internal bridge fields.
- [ ] 🧠 Add a `GET /healthz` endpoint and a Docker `HEALTHCHECK`.
- [ ] 🧠 **Dockerfile:** `node:18-alpine` is end-of-life. Move to `node:22-alpine` (or 24). Use `npm ci --omit=dev`, run as a non-root user and add `.dockerignore`. The BGA image does all of these.
- [ ] 🧠 **CI:** add `.github/workflows/ci.yml` (Node matrix, `npm ci`, `npm test`, plus a linter such as ESLint flat config). Codwell has tests but nothing runs them.
- [ ] 🧠 `LOG_LEVEL` plus a small logger with consistent `[area]` prefixes (much of this exists already). Stop logging the player list on every embed build.
- [ ] 🧠 Discord rate limits: discord.js queues REST calls, but bursts (allocating 6 threads, keep-alives to every thread) are sequential and unbounded.
      A small per-channel spacing helper is enough here. The BGA bot's `DiscordRateLimiter` is the full version.
- [ ] `.env.example` is missing `ROUND_TIMEOUT_DAYS`. A `ROUND_WARNING_DAYS` would replace the hard-coded 2 days.

## Phase 5 — Web dashboard UX

- [ ] 🎨 **Auto-refresh.** The page only updates on a manual click, even though the bridge now provides live room status every 2 minutes.
      Poll `/api` every 30–60 s while the tab is visible (`visibilitychange`), with ETag/304 from Phase 4.
- [ ] 🎨 **Light mode.** The dashboard is dark only. The BGA dashboard follows `prefers-color-scheme`. Move the colours to CSS variables (mostly done) and add a light set.
- [ ] 🎨 Admin panel: move "Force End" into the panel with a confirm (it is only an icon button on the current round now). Show the round deadline and a "nudge now" action.
- [ ] 🎨 Use a proper dialog for confirms, not stacked `confirm()` calls (reset uses three).
- [ ] 🎨 Highlight "your matches" for the logged-in player (the session already knows `userId`), and link to their open thread.
- [ ] ⚡ Split `public/index.html` (~1,000 lines of CSS and ~1,500 of JS inline) into `style.css`, `app.js` and `stats.js` as static files with cache headers, as the BGA bot does.
      Serve Chart.js from the same place, or keep the CDN with SRI (`integrity=`).
- [ ] 🎨 Mobile: check the round browser and stats tables at phone width.

## Phase 6 — Tests

- [ ] Scheduler: round count, pair and role coverage, sit-out fairness, recalculation after a leave or join (this pins down the Phase 0 fix).
- [ ] Scoring: apply/reverse round-trip, plus override and delete-result keeping `scores` equal to Σ`history`.
- [ ] State load: legacy files (`game1Result`, bare-grouping rounds) migrate cleanly. A corrupt file is not overwritten.
- [ ] An invariant check (`scores == recompute(history)`) exposed as an admin "Audit" button. The `rebuildScoresFromHistory()` it needs is useful on its own.

---

### Suggested order

1. Phase 0, minus the scheduler change until you've decided what the rule is.
2. Phase 1 (deletions are low risk and make everything else smaller).
3. Phase 2 split plus Phase 6 tests (together, so the refactor is covered).
4. Phases 4, 5 and 3, in whatever order you care about most.
