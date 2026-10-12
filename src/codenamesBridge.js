// Bridge to the BGA bot's Codenames watcher (see docs/codenames-bridge.md).
//
// Each active match thread is "bound" on the BGA bot: when players post their
// codenames.game room link in the thread, the BGA bot watches the room and
// POSTs every finished game back to /api/bridge/codenames/result here.
//
// This module holds the parts that don't touch Discord: the HTTP client for
// the BGA bot (base URLs tried in order — internal Docker URL first, public
// HTTPS fallback), binding reconciliation, token checks and seat matching.

const crypto = require('crypto');

const BINDINGS_PATH = '/api/bridge/codenames/bindings/';
const REQUEST_TIMEOUT_MS = 10_000;

function parseUrlList(raw) {
  return String(raw || '')
    .split(',')
    .map(u => u.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

// Constant-time check of an `Authorization: Bearer <token>` header.
function isAuthorized(header, token) {
  if (!token || typeof header !== 'string') return false;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const supplied = crypto.createHash('sha256').update(match[1].trim()).digest();
  const expected = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(supplied, expected);
}

function createBridgeClient({ token, baseUrls, fetchImpl = globalThis.fetch, log = console } = {}) {
  const enabled = Boolean(token) && baseUrls.length > 0;

  // Try each base URL in order; network errors and 5xx move on to the next one.
  async function request(method, path, body) {
    const errors = [];
    for (const base of baseUrls) {
      try {
        const res = await fetchImpl(base + path, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status >= 500) {
          errors.push(`${base}: HTTP ${res.status}`);
          continue;
        }
        let data = null;
        try { data = await res.json(); } catch { /* empty body */ }
        return { ok: res.status >= 200 && res.status < 300, status: res.status, data, base };
      } catch (err) {
        errors.push(`${base}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
      }
    }
    return { ok: false, status: 0, data: null, error: errors.join('; ') || 'no BGA bot URLs configured' };
  }

  function putBinding(channelId, binding) {
    return request('PUT', BINDINGS_PATH + encodeURIComponent(channelId), binding);
  }

  function deleteBinding(channelId) {
    return request('DELETE', BINDINGS_PATH + encodeURIComponent(channelId));
  }

  function getBinding(channelId) {
    return request('GET', BINDINGS_PATH + encodeURIComponent(channelId));
  }

  // Make the BGA bot's bindings match `desired` (Map threadId -> binding body).
  // `synced` (threadId -> signature of what the BGA bot last accepted) is
  // updated in place; returns true when it changed and should be persisted.
  async function reconcile(desired, synced) {
    if (!enabled) return false;
    let changed = false;
    for (const [threadId, binding] of desired) {
      const signature = JSON.stringify(binding);
      if (synced[threadId] === signature) continue;
      const res = await putBinding(threadId, binding);
      if (res.ok) {
        synced[threadId] = signature;
        changed = true;
      } else {
        log.warn(`[bridge] Could not bind thread ${threadId}: ${res.error || `HTTP ${res.status} ${JSON.stringify(res.data)}`}`);
      }
    }
    for (const threadId of Object.keys(synced)) {
      if (desired.has(threadId)) continue;
      const res = await deleteBinding(threadId);
      if (res.ok || res.status === 404) {
        delete synced[threadId];
        changed = true;
      } else {
        log.warn(`[bridge] Could not unbind thread ${threadId}: ${res.error || `HTTP ${res.status}`}`);
      }
    }
    return changed;
  }

  return { enabled, putBinding, deleteBinding, getBinding, reconcile };
}

// Discord user IDs seated in one team/role of a result payload.
function seatedUsers(seats, team, role) {
  return ((seats && seats[team] && seats[team][role]) || []).map(s => s && s.discord_user_id);
}

// Did the room's seats exactly match this grouping (one spymaster and one
// guesser per team, every seat linked to the expected Discord user)?
function seatsMatchGrouping(seats, grouping) {
  if (!grouping) return false;
  for (const team of ['blue', 'red']) {
    const spymasters = seatedUsers(seats, team, 'spymasters');
    const operatives = seatedUsers(seats, team, 'operatives');
    if (spymasters.length !== 1 || spymasters[0] !== grouping[team].spymaster) return false;
    if (operatives.length !== 1 || operatives[0] !== grouping[team].guesser) return false;
  }
  return true;
}

// The match's game number (1-based) whose expected seating the room matched, or null.
function findGameForSeats(seats, gamesPlanned, groupingForGame) {
  for (let game = 1; game <= gamesPlanned; game++) {
    if (seatsMatchGrouping(seats, groupingForGame(game))) return game;
  }
  return null;
}

// Validate a result callback body; returns an error message or null.
function validateResultPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  if (body.event !== 'codenames.game_finished') return 'unsupported event';
  if (typeof body.event_id !== 'string' || !body.event_id) return 'event_id is required';
  if (typeof body.channel_id !== 'string' || !/^\d+$/.test(body.channel_id)) return 'channel_id is required';
  if (body.winner !== 'blue' && body.winner !== 'red') return 'winner must be blue or red';
  if (!body.seats || typeof body.seats !== 'object') return 'seats is required';
  return null;
}

// Cards the losing team still had on the board, clamped to the 0-8 the manual flow accepts.
function remainingCardsFromPayload(body) {
  if (body.assassin) return 0;
  const n = Number(body.loser_remaining);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(8, Math.round(n)));
}

function describeSeats(seats) {
  const label = (team, role) => {
    const list = (seats && seats[team] && seats[team][role]) || [];
    if (list.length === 0) return '—';
    return list.map(s => (s.discord_user_id ? `<@${s.discord_user_id}>` : `${s.name || 'unknown'} (not linked)`)).join(', ');
  };
  return (
    `🔵 Spymaster: ${label('blue', 'spymasters')} · Guesser: ${label('blue', 'operatives')}\n` +
    `🔴 Spymaster: ${label('red', 'spymasters')} · Guesser: ${label('red', 'operatives')}`
  );
}

// What the BGA bot is told about one active match: who plays, what they're
// called, and the seats for the game being played now. `lastEventId` is the
// last result the tournament processed from the thread; the BGA bot only
// trusts the line-up once it matches the last result it reported.
function buildBinding({ guildId, externalRef, grouping, currentGrouping, game, lastEventId, playerNames, deadlineMs }) {
  const ids = [grouping.blue.spymaster, grouping.blue.guesser, grouping.red.spymaster, grouping.red.guesser];
  const players = ids.filter(id => /^\d+$/.test(id));
  const names = {};
  for (const id of players) {
    const name = playerNames && playerNames[id];
    if (typeof name === 'string' && name.trim()) names[id] = name.trim().slice(0, 100);
  }
  let lineup = null;
  const seats = currentGrouping && [currentGrouping.blue.spymaster, currentGrouping.blue.guesser, currentGrouping.red.spymaster, currentGrouping.red.guesser];
  if (seats && seats.every(id => /^\d+$/.test(id))) {
    lineup = {
      game,
      last_event_id: lastEventId || null,
      blue: { spymaster: currentGrouping.blue.spymaster, operative: currentGrouping.blue.guesser },
      red: { spymaster: currentGrouping.red.spymaster, operative: currentGrouping.red.guesser },
    };
  }
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Math.floor(deadlineMs / 1000) : null;
  return { guild_id: guildId, external_ref: externalRef, players, player_names: names, lineup, deadline };
}

const COLORS = new Set(['red', 'blue', 'neutral', 'black']);
const TEAMS = new Set(['red', 'blue']);
const str = (v, max = 60) => (typeof v === 'string' ? v.slice(0, max) : null);
const idOrNull = v => (typeof v === 'string' && /^\d+$/.test(v) ? v : null);

// The parts of a finished-game payload worth keeping for stats: every clue
// with who gave it, and every guess with who made it and the card it hit.
function gameDetailFromPayload(body) {
  const turns = (Array.isArray(body.turns) ? body.turns : []).slice(0, 60).map(t => ({
    team: TEAMS.has(t && t.team) ? t.team : null,
    word: str(t && t.word) || '',
    number: str(t && t.number, 8) || '',
    giver: idOrNull(t && t.giver && t.giver.discord_user_id),
    giverName: str(t && t.giver && t.giver.name),
    guesses: (Array.isArray(t && t.guesses) ? t.guesses : []).slice(0, 25).map(g => ({
      word: str(g && g.word) || '',
      color: COLORS.has(g && g.color) ? g.color : null,
      by: idOrNull(g && g.discord_user_id),
      byName: str(g && g.name),
    })),
  }));
  const board = (Array.isArray(body.board) ? body.board : []).slice(0, 25).map(c => [
    str(c && c.word) || '', COLORS.has(c && c.color) ? c.color : null, Boolean(c && c.revealed),
  ]);
  return {
    roomUrl: str(body.room_url, 200),
    startingTeam: TEAMS.has(body.starting_team) ? body.starting_team : null,
    turns,
    board,
  };
}

// ── Live status ─────────────────────────────────────────────────────────────

const PHASE_RANK = { in_progress: 3, lobby: 2, finished: 1 };

// Boil the BGA bot's binding description down to what the dashboard and the
// nudges need. A thread can watch several rooms; the most active one wins.
function summariseStatus(description, checkedAt = new Date().toISOString()) {
  const rooms = (description && Array.isArray(description.rooms)) ? description.rooms : [];
  if (rooms.length === 0) return { state: 'no_room', roomCount: 0, checkedAt };
  const room = rooms.slice().sort((a, b) => (PHASE_RANK[b.phase] || 0) - (PHASE_RANK[a.phase] || 0))[0];
  return {
    state: PHASE_RANK[room.phase] ? room.phase : 'lobby',
    roomCount: rooms.length,
    roomGame: room.game_number ?? null,
    activeTeam: TEAMS.has(room.active_team) ? room.active_team : null,
    activeRole: room.active_role === 'spymasters' || room.active_role === 'operatives' ? room.active_role : null,
    waitingOn: (room.waiting_on || []).map(w => ({ name: str(w && w.name), id: idOrNull(w && w.discord_user_id) })),
    turnStartedAt: typeof room.turn_started_at === 'string' ? room.turn_started_at : null,
    clue: room.clue && typeof room.clue.word === 'string' ? { word: str(room.clue.word), number: str(String(room.clue.number), 8) } : null,
    remaining: room.remaining && typeof room.remaining === 'object'
      ? { red: Number(room.remaining.red) || 0, blue: Number(room.remaining.blue) || 0 } : null,
    connected: Boolean(room.connected),
    checkedAt,
  };
}

// What the periodic nudge should do for one match thread:
//   { action: 'send', content, users } — a status-aware nudge,
//   { action: 'skip' } — the BGA bot's own turn reminders cover it,
//   { action: 'fallback' } — no live status, use the classic keep-alive message.
function planNudge({ status, players, game, deadlineMs, pendingConfirmations = 0 }) {
  if (!status || status.state === 'unreachable' || status.state === 'unbound') return { action: 'fallback' };
  const users = (players || []).filter(id => /^\d+$/.test(id));
  const mentions = users.map(id => `<@${id}>`).join(' ');
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > Date.now()
    ? ` The round ends <t:${Math.floor(deadlineMs / 1000)}:R>.` : '';
  if (pendingConfirmations > 0) {
    return {
      action: 'send', users,
      content: `✋ ${mentions} a detected result is waiting for confirmation above. Press **Log as Game ${game}** or **Dismiss**.${deadline}`,
    };
  }
  if (status.state === 'no_room') {
    return {
      action: 'send', users,
      content: `📎 ${mentions} nobody has posted a codenames.game room for this match yet. Create one at https://codenames.game and post the link here to start Game ${game}.${deadline}`,
    };
  }
  if (status.state === 'lobby' || status.state === 'finished') {
    return {
      action: 'send', users,
      content: `🕵️ ${mentions} the room is ready but Game ${game} hasn't started yet. Take your seats (see the room card) and start the game.${deadline}`,
    };
  }
  return { action: 'skip' };
}

module.exports = {
  summariseStatus,
  planNudge,
  buildBinding,
  gameDetailFromPayload,
  parseUrlList,
  isAuthorized,
  createBridgeClient,
  seatsMatchGrouping,
  findGameForSeats,
  validateResultPayload,
  remainingCardsFromPayload,
  describeSeats,
};
