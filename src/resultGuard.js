// Guards against logging the same game twice by hand: the commonest slip is
// pressing "Blue won" on the next game's card right after the previous game was
// logged (often automatically, by the codenames.game bridge). No real game ends
// within minutes of the last one, so a manual result that soon is refused or
// has to be confirmed. Pure functions; see test/resultGuard.test.js.

const DEFAULT_BLOCK_MINUTES = 3;
const DEFAULT_WARN_MINUTES = 15;

function minutesSetting(raw, fallback) {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// { blockMs, warnMs } from RESULT_BLOCK_MINUTES / RESULT_WARN_MINUTES.
function guardSettings(env = process.env) {
  const block = minutesSetting(env.RESULT_BLOCK_MINUTES, DEFAULT_BLOCK_MINUTES);
  const warn = Math.max(block, minutesSetting(env.RESULT_WARN_MINUTES, DEFAULT_WARN_MINUTES));
  return { blockMs: block * 60_000, warnMs: warn * 60_000 };
}

// What to do with a manual result for `gamePhase`, given the match's logged
// results: { action: 'allow' } or { action: 'block' | 'warn', previous, sinceMs }
// where `previous` is the game logged just before (number, result).
function checkManualResult({ phaseResults, gamePhase, now = Date.now(), settings = guardSettings() }) {
  const game = gamePhase - 1;
  const result = game >= 1 ? (phaseResults || {})[game] : null;
  const loggedAt = result ? Date.parse(result.submittedAt) : NaN;
  if (!Number.isFinite(loggedAt)) return { action: 'allow' };
  const sinceMs = Math.max(0, now - loggedAt);
  const previous = { game, result };
  if (sinceMs < settings.blockMs) return { action: 'block', previous, sinceMs };
  if (sinceMs < settings.warnMs) return { action: 'warn', previous, sinceMs };
  return { action: 'allow' };
}

function describeSince(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
}

function describeSource(result) {
  const source = result && result.source;
  if (source === 'codenames-bridge') return 'automatically from codenames.game';
  if (source === 'codenames-bridge-confirmed') return 'from codenames.game';
  return result && result.submittedBy && /^\d+$/.test(result.submittedBy) ? `by <@${result.submittedBy}>` : 'by hand';
}

// The message shown for a blocked or warned result.
function guardMessage(check, gamePhase) {
  const { game, result } = check.previous;
  const winner = result.winner === 'blue' ? '🔵 Blue' : '🔴 Red';
  const logged = `**Game ${game}** (${winner} won) was logged ${describeSince(check.sinceMs)}, ${describeSource(result)}.`;
  if (check.action === 'block') {
    return `⛔ ${logged}\nThese buttons are for **Game ${gamePhase}**, which can't have finished yet. If Game ${game}'s result is wrong, ask an admin to fix it on the website.`;
  }
  return `⚠️ ${logged}\nThese buttons are for **Game ${gamePhase}**. Has Game ${gamePhase} really been played and finished?`;
}

module.exports = { checkManualResult, guardSettings, guardMessage, DEFAULT_BLOCK_MINUTES, DEFAULT_WARN_MINUTES };
