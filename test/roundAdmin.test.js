const test = require('node:test');
const assert = require('node:assert/strict');
const { DAY_MS, newDeadline, rosterChanged, rosterChangeAction } = require('../src/roundAdmin');

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);

test('a delay is added to the current deadline', () => {
  const current = NOW + 2 * DAY_MS;
  for (const days of [1, 3, 7, 14]) {
    assert.deepEqual(newDeadline({ current, now: NOW, delayDays: days }), { deadline: current + days * DAY_MS });
  }
});

test('a delay after the deadline has passed counts from now', () => {
  assert.deepEqual(newDeadline({ current: NOW - 5 * DAY_MS, now: NOW, delayDays: 1 }), { deadline: NOW + DAY_MS });
});

test('only the offered delays are accepted', () => {
  for (const days of [0, 2, -1, 30, 'x']) {
    assert.ok(newDeadline({ current: NOW, now: NOW, delayDays: days }).error, `delay ${days}`);
  }
});

test('a specific date is accepted as ms or a date string', () => {
  const target = NOW + 10 * DAY_MS;
  assert.deepEqual(newDeadline({ current: NOW, now: NOW, deadline: target }), { deadline: target });
  assert.deepEqual(newDeadline({ current: NOW, now: NOW, deadline: String(target) }), { deadline: target });
  assert.deepEqual(newDeadline({ current: NOW, now: NOW, deadline: new Date(target).toISOString() }), { deadline: target });
});

test('a date in the past, too far ahead or unreadable is refused', () => {
  assert.ok(newDeadline({ current: NOW, now: NOW, deadline: NOW - 1000 }).error);
  assert.ok(newDeadline({ current: NOW, now: NOW, deadline: NOW + 10 * 1000 }).error);
  assert.ok(newDeadline({ current: NOW, now: NOW, deadline: NOW + 400 * DAY_MS }).error);
  assert.ok(newDeadline({ current: NOW, now: NOW, deadline: 'next tuesday' }).error);
  assert.ok(newDeadline({ current: NOW, now: NOW }).error);
});

test('roster changes are spotted in either direction', () => {
  assert.equal(rosterChanged(['a', 'b', 'c'], ['c', 'b', 'a']), false);
  assert.equal(rosterChanged(['a', 'b', 'c'], ['a', 'b']), true);
  assert.equal(rosterChanged(['a', 'b'], ['a', 'b', 'c']), true);
  assert.equal(rosterChanged(['a', 'b', 'c'], ['a', 'b', 'd']), true);
  assert.equal(rosterChanged(null, ['a']), true);
});

test('what happens to the current round after a roster change', () => {
  const base = { roundRunning: true, rosterChanged: true, loggedGames: 0, paused: false };
  assert.equal(rosterChangeAction(base), 'restart');
  assert.equal(rosterChangeAction({ ...base, loggedGames: 3 }), 'ask');
  assert.equal(rosterChangeAction({ ...base, paused: true }), 'wait');
  assert.equal(rosterChangeAction({ ...base, paused: true, loggedGames: 2 }), 'wait');
  assert.equal(rosterChangeAction({ ...base, rosterChanged: false, loggedGames: 3 }), 'future');
  assert.equal(rosterChangeAction({ ...base, roundRunning: false }), 'future');
});
