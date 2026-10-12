# 🕵️ Codenames Tournament Bot

A Discord bot and web dashboard for running fully-automated round-robin Codenames tournaments. Players sign up in Discord, the bot generates every matchup, creates a private thread per game, tracks scores, and publishes a live web scoreboard — all with zero manual scheduling.

---

## Table of Contents

- [Quick-Start Checklist](#quick-start-checklist)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Node.js (direct)](#nodejs-direct)
  - [Docker / Docker Compose](#docker--docker-compose)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Required Bot Permissions](#required-bot-permissions)
  - [Discord Application Setup](#discord-application-setup)
  - [HTTPS & Reverse Proxy](#https--reverse-proxy)
- [Running the Bot](#running-the-bot)
  - [Process Management (Node.js)](#process-management-nodejs)
- [Discord Usage](#discord-usage)
  - [Slash Commands](#slash-commands)
  - [Player Buttons](#player-buttons)
  - [In-Game Buttons](#in-game-buttons)
- [Tournament Format](#tournament-format)
- [Scoring](#scoring)
- [Web Dashboard](#web-dashboard)
  - [Public View](#public-view)
  - [Admin View (web)](#admin-view-web)
- [Data Persistence](#data-persistence)
- [Hosting Suggestions](#hosting-suggestions)
- [Roadmap](#roadmap)
- [Debug Mode](#debug-mode)

---

## Quick-Start Checklist

Follow these steps in order for a smooth first deployment:

1. **Create a Discord Application** at <https://discord.com/developers/applications>
   - Under **Bot**, copy the **Token** → `BOT_TOKEN`
   - Under **Bot → Privileged Gateway Intents**, toggle **Message Content Intent** ON and save
   - Under **OAuth2 → General**, copy the **Client ID** → `DISCORD_CLIENT_ID`
   - Generate a **Client Secret** → `DISCORD_CLIENT_SECRET`
2. **Add a redirect URI** in **OAuth2 → General**: `https://yourdomain.com/auth/discord/callback`  
   *(for local testing use `http://localhost:PORT/auth/discord/callback` — must match exactly, no trailing slash)*
3. **Create an Admin role** in your Discord server, then copy its ID → `ADMIN_ROLE_ID`  
   *(enable Developer Mode in Discord: User Settings → Advanced → Developer Mode, then right-click the role → Copy Role ID)*
4. **Copy your Server ID** → `GUILD_ID`  
   *(right-click your server icon → Copy Server ID)*
5. **Clone the repo and configure** it:
   ```bash
   git clone https://github.com/Stayingfalse/CodwellTornement.git
   cd CodwellTornement
   cp .env.example .env
   # Fill in all values — see Configuration below
   ```
6. **Run the bot** (Docker Compose recommended for production):
   ```bash
   docker-compose up -d
   ```
7. **Invite the bot** to your server using the invite URL printed to the console on first start
8. In Discord, run `/tournament` (as an admin) in the channel where you want the tournament message

> **Web dashboard login is optional.** The bot runs fully without `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`. Those are only needed if you want admin controls in the browser.

---

## Features

- **One slash command** — `/tournament` posts the tournament message anywhere in your server
- **Interactive sign-up** — players join (or withdraw) with a single button click; the message updates in real time with the current player list and a tournament size prediction
- **Every pair against every player** — groups of four rotate each round until every pair has teamed up against every other player
- **6-game matches** — each group plays all three ways of pairing up, each with both role configurations (fewer games when some were already played)
- **Automatic thread creation** — a dedicated Discord thread is created for each match; players submit results with buttons inside their thread
- **Result correction** — players (and admins) can undo and re-submit a wrong result at any time before the round ends
- **Score tracking** — a live scoreboard message is kept up-to-date in the tournament channel throughout the event
- **Round deadlines** — configurable deadline per round; a warning fires 2 days before expiry and an expiry notice with a Force End button fires when time runs out
- **Live match status (with the Codenames bridge)** — the dashboard shows each active match's turn, who it's waiting on and for how long, with a link to the thread. Keep-alive messages chase what's actually holding a match up.
- **Thread keep-alive messages** — the bot posts a random humorous message every 2–3 days into active match threads to prevent Discord from auto-archiving them and to nudge players to finish
- **Round summaries** — a card summarising every result is posted at the start of each new round
- **Admin controls** — in Discord (ephemeral) and on the web dashboard
- **Web dashboard** — public live scoreboard, round browser, match history, and a full admin panel accessible via Discord OAuth2 login
- **Automatic results (optional)** — with the [Codenames bridge](docs/codenames-bridge.md), players post their codenames.game room link in the match thread, the room card shows who should sit where, and every game is scored automatically. Its clue history powers clue and guess stats on the dashboard.
- **Persistent state** — all tournament data is saved to disk; the bot safely recovers across restarts

---

## Prerequisites

- **Node.js 18+** (or Docker) — verify with `node --version  # should be v18 or higher`
- A **Discord application** with a bot user — create one at <https://discord.com/developers/applications>
- The bot must be a member of your Discord server

---

## Installation

### Node.js (direct)

```bash
git clone https://github.com/Stayingfalse/CodwellTornement.git
cd CodwellTornement
npm install
cp .env.example .env
# Edit .env with your values (see Configuration below)
npm start
```

For development with auto-restart on file changes:

```bash
npm run dev
```

### Docker / Docker Compose

```bash
cp .env.example .env
# Edit .env with your values
docker-compose up -d
```

The `docker-compose.yml` maps `WEB_PORT` (default `80`) from the container to the same port on the host, so the web dashboard is reachable immediately. If you run behind a reverse proxy, change `WEB_PORT` to a non-privileged port such as `3000` and proxy to that.

Or build and run manually:

```bash
docker build -t codenames-bot .
docker run --env-file .env -v $(pwd)/data:/app/data codenames-bot
```

The `data/` directory is mounted as a volume so tournament state survives container restarts.

---

## Configuration

Copy `.env.example` to `.env` and fill in the values before starting the bot.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_TOKEN` | ✅ | — | Discord bot token from the Developer Portal |
| `GUILD_ID` | ✅ | — | Numeric ID of your Discord server |
| `ADMIN_ROLE_ID` | ✅ | — | Numeric ID of the role that grants admin access to bot controls |
| `DISCORD_CLIENT_ID` | ⬜ | — | OAuth2 application client ID — required for web dashboard login |
| `DISCORD_CLIENT_SECRET` | ⬜ | — | OAuth2 application client secret — required for web dashboard login |
| `WEB_URL` | ⬜ | auto-detected | Public base URL of the dashboard (e.g. `https://tournament.example.com`). Used for the OAuth2 redirect URI and the Website button on the Discord message. |
| `WEB_PORT` | ⬜ | `80` | Port the web server listens on |
| `ROUND_TIMEOUT_DAYS` | ⬜ | `14` | Days before a round deadline fires. Supports decimals — e.g. `0.01` ≈ 15 minutes is useful for a dry run. Minimum practical value for production is `1`. |
| `BRIDGE_TOKEN` | ⬜ | — | Shared secret with the BGA bot's Codenames watcher. Turns on automatic results; see [Codenames bridge](docs/codenames-bridge.md) |
| `BRIDGE_URLS` | ⬜ | — | Comma-separated base URLs of the BGA bot's bridge API, tried in order (internal first, public HTTPS fallback) |

### Required Bot Permissions

When you invite the bot to your server it needs the following permissions (the bot prints a ready-made invite URL to the console on startup):

| Permission | Why |
|---|---|
| View Channels | See the tournament channel |
| Send Messages | Post the tournament message, round cards and match cards |
| Send Messages in Threads | Post inside game threads |
| Embed Links | Link previews (not strictly needed for Components V2 cards) |
| Read Message History | Fetch old messages to delete between rounds |
| Manage Messages | Delete old round messages when a new round starts |
| Create Public Threads | Create a thread for each game |
| Manage Threads | Archive threads after a match completes |
| Use Application Commands | Register and handle slash commands |

### Discord Application Setup

1. Go to <https://discord.com/developers/applications> and open (or create) your application.
2. Under **Bot**, copy the token → `BOT_TOKEN`.
3. Under **Bot → Privileged Gateway Intents**, toggle **Message Content Intent** ON and save.  
   > ⚠️ Without this the bot will not receive message content and may fail silently.
4. Under **OAuth2 → General**, copy the **Client ID** → `DISCORD_CLIENT_ID` and generate a **Client Secret** → `DISCORD_CLIENT_SECRET`.
5. Add a redirect URI that matches your deployment **exactly** (no trailing slash):
   - Production: `https://yourdomain.com/auth/discord/callback`
   - Local dev: `http://localhost:3000/auth/discord/callback` (replace `3000` with your `WEB_PORT`)
6. Invite the bot using the URL printed to the console on first start, or build one manually with `scope=bot+applications.commands` and the permissions listed above.

#### Finding your Guild ID and Role ID

1. In Discord, open **User Settings → Advanced** and enable **Developer Mode**.
2. **Guild ID (GUILD_ID)**: right-click your server icon → **Copy Server ID**.
3. **Admin Role ID (ADMIN_ROLE_ID)**: open **Server Settings → Roles**, right-click the role you want to use → **Copy Role ID**.

---

### HTTPS & Reverse Proxy

Discord's OAuth2 requires HTTPS for production redirect URIs. The bot's built-in web server speaks plain HTTP, so you need a reverse proxy to terminate TLS.

> Port `80` requires root privileges on Linux. It is strongly recommended to set `WEB_PORT=3000` (or any port > 1024) and proxy to it.

**Caddy** (auto-HTTPS via Let's Encrypt — simplest option):

```
# Caddyfile
tournament.example.com {
    reverse_proxy localhost:3000
}
```

Start with `caddy run --config Caddyfile`. Caddy handles certificate renewal automatically.

**nginx** example (`/etc/nginx/sites-available/tournament`):

```nginx
server {
    listen 80;
    server_name tournament.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name tournament.example.com;

    ssl_certificate     /etc/letsencrypt/live/tournament.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tournament.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Use [Certbot](https://certbot.eff.org/) to obtain the certificate: `certbot --nginx -d tournament.example.com`.

After setting up a proxy, set `WEB_URL=https://tournament.example.com` and `WEB_PORT=3000` in your `.env`.

---

## Running the Bot

```bash
npm start
```

On startup the bot will:

1. Print a permissions invite URL to the console.
2. Load any previously saved tournament state from `data/tournament.json`.
3. Re-register the `/tournament` slash command in your guild.
4. Rebuild the tournament message from saved state.
5. Re-schedule any round deadline timers that were active before restart.
6. Automatically re-allocate the current round if it had no active threads (crash recovery).

### Process Management (Node.js)

When running without Docker you need a process manager to keep the bot alive across reboots.

**pm2** (recommended — installs as a global npm package):

```bash
npm install -g pm2
pm2 start npm --name codenames-bot -- start
pm2 save          # persist the process list
pm2 startup       # print and run the command to enable auto-start on boot
```

Useful pm2 commands: `pm2 logs codenames-bot`, `pm2 restart codenames-bot`, `pm2 stop codenames-bot`.

**systemd** (alternative for Linux servers):

Create `/etc/systemd/system/codenames-bot.service`:

```ini
[Unit]
Description=Codenames Tournament Bot
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/CodwellTornement
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
EnvironmentFile=/path/to/CodwellTornement/.env

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codenames-bot
sudo journalctl -u codenames-bot -f   # view logs
```

---

## Discord Usage

All bot messages use Discord's **Components V2** layout (cards with sections and buttons) instead of embeds. Messages posted before the switch keep working: their buttons have the same IDs, and the main tournament message is converted (or reposted) the next time it updates.

### Slash Commands

| Command | Description |
|---|---|
| `/tournament` | Admins only. Posts the tournament message in the current channel, replacing any earlier one. |

### The tournament message

One message in the tournament channel, kept up to date:

- **Before the start:** who's signed up, the expected size, and **Sign up / leave** and **Website** buttons.
- **During:** the current round and its deadline, the matches in play (each with a link to its thread), standings with points per game, and **Website** and **Leave tournament** buttons.
- **At the end:** the final standings.

### Rounds and match threads

When a round starts, each match gets a thread. The first card in the thread pings the four players, shows game 1's line-up and lists the whole match plan. A **round card** in the channel lists every match with a link to its thread. After each game, the next game's card is posted in the thread.

| Button | What it does |
|---|---|
| **🔵 Blue won** / **🔴 Red won** | Starts logging the current game's result. Only the four players or an admin can press it. |
| **Yes, Assassin Hit** / **No, Not Assassin** | Follows the win button. If it wasn't the assassin, a form asks how many cards the losing team had left (0–8). |
| **Log as game N** / **Dismiss** | Shown when codenames.game reports a result whose seats didn't match the line-up. |

Results are corrected from the website's admin view.

---

## Tournament Format

**Goal:** every pair of players teams up against every other player. The tournament ends when that is true for every pair.

Each round splits the players into groups of four (⌊N/4⌋ matches run at once; the rest sit out, rotated fairly). **A match is 6 games**: the group plays every way its four players can pair up, and each pairing twice so both teammates take both roles:

| Games | Teams | |
|---|---|---|
| 1–2 | A & B vs C & D | as drawn, then roles swapped |
| 3–4 | A & C vs B & D | as drawn, then roles swapped |
| 5–6 | A & D vs B & C | as drawn, then roles swapped |

The same four players never meet as a group twice. Games a group already played (for example under the older 2–4 game format) are skipped, so some matches are shorter than 6 games. The scheduler (`src/scheduler.js`) plans the fewest groups it can find that cover every pair-versus-player combination, then packs them into as few rounds as it can. For 14 players that is about 34 rounds (the theoretical minimum is 31).

To switch a tournament that started on the older format, press **🔄 Fix Matchups** in the web admin panel. It rebuilds every future round straight away, treating the current round as if it finishes as scheduled. Nothing already played is lost. The same button rebuilds the future rounds whenever you need it to.

After each game, the thread automatically posts the next game configuration and result buttons. Once all configured games are logged, the thread is archived and the scoreboard updated. When all threads in a round are complete, the next round is allocated automatically.

**Round deadlines** are configurable via `ROUND_TIMEOUT_DAYS` (default 14 days). A warning message is posted to all active threads 2 days before the deadline. When the deadline expires, a notice is posted in the tournament channel; admins force-end the round from the website.

---

### Automatic results

With the [Codenames bridge](docs/codenames-bridge.md) enabled, players post a codenames.game room link in the match thread and play every game of the match in that one room (**Play next game**). Each finished game is logged automatically when the room's seats match that game's line-up. Otherwise a **Log as Game N / Dismiss** card is posted for the players or an admin to confirm.

## Scoring

Points are awarded per game:

| Outcome | Winning team (per player) | Losing team (per player) |
|---|---|---|
| Standard win, ≤ 3 cards remaining | **+3** | **+1** |
| Standard win, > 3 cards remaining | **+3** | **+0** |
| Win by assassin hit | **+3** | **−1** |

The number of "cards remaining" means the opponent's unrevealed cards still on the board when the game ends.

---

## Web Dashboard

The bot starts an HTTP server alongside the Discord bot. Port defaults to `80` and is configurable via `WEB_PORT`.

### Public View

Accessible at your `WEB_URL` (no login required):

- **Status** — progress through the tournament, current round, round deadline, players
- **Current round** — every match with one row per game (teams, spymaster 🔎, result) and live room status from codenames.game
- **Standings** — points, games played and points per game; your own row and matches are highlighted when you're logged in
- **Rounds** — one line per upcoming or completed round; expand any to see its matches
- **Stats** — win rates, role splits, assassin hits and clue/guess stats, filterable by round

It refreshes itself every minute while open, works on phones, and has light and dark themes.

### Admin View (web)

Log in with **Discord** (OAuth2) using the button in the top-right corner. You must be a member of the configured server and hold the admin role. All tournament administration happens here:

| Control | Action |
|---|---|
| **Start tournament** | Builds the schedule from everyone signed up and switches the Discord message to the live view (4+ players). |
| **Allocate round** | Starts the current round if it isn't running (normally automatic). |
| **Force end round** | Next to the current round. Keeps games already logged, scores nothing for the rest, archives the threads and starts the next round. |
| **Shuffle upcoming** | Randomly reorders the rounds that haven't started. |
| **Reopen / close signups** | Lets new players join mid-tournament; rounds pause while signups are open. |
| **Fix matchups** | Rebuilds every future round for the current players (see Tournament Format). |
| **Reset…** | Deletes everything; you type RESET to confirm. |
| **Click a score** | Edit a player's points. |
| **Click a result** | Change or delete a game's result. |

Changes show up on the website and in the Discord message straight away.

---

## Data Persistence

All tournament state is written to `data/tournament.json` after every change. On startup the bot loads this file and resumes where it left off — including active matches, scores, round schedules, and deadline timers.

When running with Docker Compose the `data/` directory is mounted as a host volume (`./data:/app/data`) so data persists across container rebuilds.

---

## Hosting Suggestions

The bot needs to run continuously (round deadline timers fire in the background). Free-tier platforms that spin down after inactivity are **not** suitable.

**VPS / dedicated server** (most control, cheapest for always-on):
- [Hetzner Cloud](https://www.hetzner.com/cloud) — CX22 (~€4/mo) is more than enough
- [DigitalOcean Droplets](https://www.digitalocean.com/products/droplets) — Basic $6/mo
- [Linode / Akamai](https://www.linode.com/)

**PaaS** (easier setup, but verify persistent storage and always-on support):
- [Railway](https://railway.app/) — supports Docker, persistent volumes, custom domains
- [Fly.io](https://fly.io/) — supports Docker, persistent volumes; set `WEB_URL` to the assigned domain
- [Render](https://render.com/) — Docker support; use a paid plan to avoid spin-down

When deploying to PaaS platforms:
- Mount a persistent volume at `/app/data` so `tournament.json` survives redeploys.
- Set `WEB_URL` to your public domain so OAuth2 redirects and the Discord link button work correctly.

---

## Roadmap

The following features are planned or under consideration. Contributions are welcome — feel free to open an issue or PR.

### 🔧 Quality of Life

- **Multiple admin roles** — accept a comma-separated `ADMIN_ROLE_IDS` list so co-organisers can each hold a different role
- **Configurable scoring** — expose win/loss/assassin point values as env vars (`WIN_POINTS`, `CLOSE_LOSS_POINTS`, etc.) so communities can adopt house rules without touching code
- **Configurable round warning threshold** — make the "2 days before deadline" warning fire time configurable via `ROUND_WARNING_DAYS`

### 📊 Statistics & Exports

- **Per-player statistics page** — clicking a player's name on the web dashboard scoreboard shows their individual record: games played, win rate, spymaster vs. guesser performance split, and head-to-head results against each opponent (the full history is already stored in `tournament.history`)
- **Tournament export** — an admin-only `GET /api/export/csv` (and `/api/export/json`) endpoint that downloads the complete match history as a spreadsheet-friendly file, useful for post-tournament analysis
- **Tiebreaker rules** — configurable secondary sort for equal-points rankings: head-to-head result, fewest cards remaining against opponents, or total assassin wins

### 🗄️ Persistence & History

- **Tournament archive** — instead of wiping all state on Reset, save the completed tournament to `data/archive/<date>.json` so you can browse past tournaments on the web dashboard
- **Database backend (SQLite)** — replace the single JSON file with an embedded SQLite database for more robust concurrent writes and easier querying; the JSON format would remain as an export option

### 🔴 Live Dashboard

- **Server-Sent Events (SSE) push** — replace the manual ↻ Refresh button with a `/api/events` SSE stream so the web dashboard updates instantly whenever the bot saves new state, without polling

### 📣 Notifications

- **DM nudges for match participants** — optionally DM each player when their thread is created (round allocated) and again when the round warning fires, so players don't have to watch the Discord channel
- **Outgoing webhook on round completion** — post a summary embed to a separate `#results` channel (or any Discord webhook URL) when a round finishes, keeping the tournament channel clean

### 🏆 Tournament Formats

- **Swiss-system mode** — an opt-in alternative to full round-robin where players are paired by current standing each round; better for large player pools where N*(N-1) games would take too long
- **Single-elimination bracket** — post-signup bracket generation with a visual bracket embed, suitable for shorter knockout-style events
- **Bye handling** — automatic bye assignment when player count is odd (currently requires a minimum of 4 players at all times)

### 🌐 Web Dashboard Enhancements

- **Real-time match thread links** — hyperlink each active match directly to its Discord thread from the dashboard overview
- **Admin audit log** — a web panel entry that records which admin performed which action and when (score adjustments, force-ends, resets)

---

## Debug Mode

Set `DEBUG_MODE=true` in your `.env` to enable a **Seed Players** button in the Discord admin panel. Pressing it adds `DEBUG_PLAYER_COUNT` fake players (using synthetic IDs) so you can run through the entire tournament flow without real sign-ups.

Remove or set `DEBUG_MODE=false` before running a real tournament.
