// Pure rules for changing the round in progress (see src/index.js):
// what happens to it when the players change, and moving its deadline.

const DAY_MS = 24 * 60 * 60 * 1000;
const DELAY_OPTIONS_DAYS = [1, 3, 7, 14];
const MIN_LEAD_MS = 60 * 1000; // a new deadline must be at least a minute away
const MAX_AHEAD_MS = 365 * DAY_MS;

// The round's deadline after an admin moves it. Either `delayDays` (one of
// DELAY_OPTIONS_DAYS, added to the current deadline, or to now if that has
// passed) or `deadline` (a timestamp in ms, or a date string).
// Returns { deadline } or { error }.
function newDeadline({ current, now = Date.now(), delayDays, deadline }) {
  let target;
  if (delayDays !== undefined && delayDays !== null && delayDays !== '') {
    const days = Number(delayDays);
    if (!DELAY_OPTIONS_DAYS.includes(days)) return { error: `The delay must be ${DELAY_OPTIONS_DAYS.join(', ')} days.` };
    target = Math.max(current || now, now) + days * DAY_MS;
  } else if (deadline !== undefined && deadline !== null && deadline !== '') {
    target = typeof deadline === 'number' ? deadline : (/^\d+$/.test(String(deadline)) ? Number(deadline) : Date.parse(deadline));
    if (!Number.isFinite(target)) return { error: 'Pick a valid date and time.' };
  } else {
    return { error: 'Provide a new deadline or a delay in days.' };
  }
  if (target < now + MIN_LEAD_MS) return { error: 'The new deadline must be in the future.' };
  if (target > now + MAX_AHEAD_MS) return { error: 'The new deadline must be within a year.' };
  return { deadline: Math.round(target) };
}

// Did the players change since the round was planned? An unknown roster
// (older saves) counts as changed.
function rosterChanged(roster, players) {
  if (!Array.isArray(roster)) return true;
  const a = new Set(roster);
  const b = new Set(players);
  if (a.size !== b.size) return true;
  for (const id of a) if (!b.has(id)) return true;
  return false;
}

// What to do with the round in progress once someone joins or leaves:
//   'future'  — no round running, or its players are unchanged: only the rounds after it are replanned
//   'wait'    — rounds are paused (signups open or a leave request pending): replan the
//               future now, decide about this round once the pause ends
//   'restart' — nothing logged this round yet: replan it for the current players and start it again
//   'ask'     — games are logged this round: replan the future and ask an admin what to do with it
function rosterChangeAction({ roundRunning, rosterChanged: changed, loggedGames, paused }) {
  if (!roundRunning || !changed) return 'future';
  if (paused) return 'wait';
  return loggedGames > 0 ? 'ask' : 'restart';
}

module.exports = { DAY_MS, DELAY_OPTIONS_DAYS, newDeadline, rosterChanged, rosterChangeAction };
