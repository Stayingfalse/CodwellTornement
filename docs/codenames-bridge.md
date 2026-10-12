# Codenames bridge (automatic results)

When the bridge is on, the tournament scores games straight from
[codenames.game](https://codenames.game), using the Codenames watcher in the
[BGA Discord bot](https://github.com/Stayingfalse/BoardGameArena_Discord_Turn_Bot).
The full API contract is in that repo's
[`docs/tournament-bridge.md`](https://github.com/Stayingfalse/BoardGameArena_Discord_Turn_Bot/blob/main/docs/tournament-bridge.md).

## What players see

1. A round starts and each match gets its thread as usual. The thread tells
   the players to post their codenames.game room link there.
2. Someone creates a room and posts the link in the thread. The BGA bot reacts
   🕵️ and posts a live room card with the four players listed. Seats are
   matched to players automatically by the name used last time, their Discord
   name or their tournament name. Anyone it can't match presses
   **🙋 I'm playing** once.
3. The room card shows the **line-up for the current game**: each seat with ✅,
   "sitting as …" or "hasn't pressed I'm playing". While the room is in the
   lobby the players get one ping saying where to sit. Use **Play next game**
   in the same room for every game of the match; the card and ping move on to
   the next game's line-up once its result is logged.
4. When a game ends, the result is checked against the line-up for the
   match's current game:
   - **Seats match:** it is logged automatically, the thread shows the result,
     and the next game's line-up is posted.
   - **Seats don't match, or someone hasn't claimed their seat:** the thread
     gets a **"result detected — please confirm"** card. A player in the
     match, or an admin, presses **Log as Game N** or **Dismiss**.
   - **The game's line-up was already logged by hand:** it is ignored.

## Stats

Games played through the bridge keep their full clue history (every clue
with its giver, every guess with who made it and which card it hit) in
`history[].detail`. The web dashboard's **📊 Stats** tab uses it for:

- **Sharpest Guesser**: highest share of picks that were the team's own
  cards (10+ guesses).
- **Clue Machine**: most own-team cards found per clue (5+ clues).
- **Best Clue**: the single clue that found the most cards.
- **Cards per clue** and overall **guess accuracy** summary cards.
- A **guess outcomes** chart (own team, other team, neutral, assassin) and a
  **cards found per clue** chart for spymasters.
- A **Clues & Guesses** table: clues, average clue number, hits per clue,
  clue accuracy, guesses, guess accuracy and bad picks per player.

Manually logged games still count for the win-rate stats; they just have no
clue detail. If a seat wasn't linked to a Discord user, its clues and guesses
count for whoever the line-up put in that seat.

The **Blue Wins / Red Wins** buttons still work as a manual fallback, and the
web admin can override or delete any result, whether it was logged
automatically or by hand. Auto-logged results are stored with
`source: "codenames-bridge"`.

## Setup

Both bots need the same `BRIDGE_TOKEN`, and the BGA bot must be able to see
the match threads (it needs **View Channel**, **Send Messages in Threads** and
**Read Message History** in the tournament channel).

| Variable | Description |
|---|---|
| `BRIDGE_TOKEN` | Shared secret with the BGA bot. Leave empty to turn the bridge off. |
| `BRIDGE_URLS` | Comma-separated base URLs of the BGA bot's bridge API, tried in order: internal first, public HTTPS fallback. Example: `http://bga-bot:8081,https://bga.example.com` |

The BGA bot sends results to `POST /api/bridge/codenames/result` on this bot's
web server. Give it both addresses in its `BRIDGE_CALLBACK_URLS`, e.g.
`http://codenames-bot:3000/api/bridge/codenames/result,https://tournament.example.com/api/bridge/codenames/result`.

### Docker: same host, separate containers

```bash
docker network create codenames-bridge
docker compose -f docker-compose.yml -f docker-compose.bridge.yml up -d
```

Do the same in the BGA bot's repo. The containers then reach each other as
`codenames-bot` and `bga-bot`.

## How it stays in sync

- After every save, the bot binds each active match thread on the BGA bot and
  unbinds threads whose match has ended. A binding names the four players,
  their tournament names and the current game's line-up, along with the last
  result processed from the thread. Unbinding also stops the BGA bot
  watching that thread's room.
- Bindings the BGA bot couldn't accept (for example while it restarts) are
  retried every 5 minutes. What it last accepted is stored in
  `data/tournament.json` as `codenamesBindings`.
- The BGA bot keeps each result until this bot answers with a 2xx, and resends
  after an outage. Each game has an `event_id`, so a result is never scored
  twice.
