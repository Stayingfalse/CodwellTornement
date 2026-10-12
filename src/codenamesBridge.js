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

  return { enabled, putBinding, deleteBinding, reconcile };
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

module.exports = {
  parseUrlList,
  isAuthorized,
  createBridgeClient,
  seatsMatchGrouping,
  findGameForSeats,
  validateResultPayload,
  remainingCardsFromPayload,
  describeSeats,
};
