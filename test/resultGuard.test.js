const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../src/resultGuard');

const settings = guard.guardSettings({});
const LOGGED = Date.parse('2026-11-01T20:00:00Z');
const results = { 1: { winner: 'blue', submittedAt: '2026-11-01T20:00:00Z', source: 'codenames-bridge' } };
const at = minutes => LOGGED + minutes * 60_000;

test('a manual result straight after the previous game is blocked', () => {
  const check = guard.checkManualResult({ phaseResults: results, gamePhase: 2, now: at(1), settings });
  assert.equal(check.action, 'block');
  assert.equal(check.previous.game, 1);
  const message = guard.guardMessage(check, 2);
  assert.match(message, /Game 1\*\* \(🔵 Blue won\) was logged 1 minute ago, automatically from codenames\.game/);
  assert.match(message, /Game 2\*\*, which can't have finished yet/);
});

test('a manual result soon after the previous game needs confirming', () => {
  const check = guard.checkManualResult({ phaseResults: results, gamePhase: 2, now: at(10), settings });
  assert.equal(check.action, 'warn');
  assert.match(guard.guardMessage(check, 2), /Has Game 2 really been played and finished\?/);
});

test('later results, the first game, and games without a time are allowed', () => {
  assert.equal(guard.checkManualResult({ phaseResults: results, gamePhase: 2, now: at(15), settings }).action, 'allow');
  assert.equal(guard.checkManualResult({ phaseResults: {}, gamePhase: 1, now: at(0), settings }).action, 'allow');
  assert.equal(guard.checkManualResult({ phaseResults: { 1: { winner: 'red' } }, gamePhase: 2, now: at(0), settings }).action, 'allow');
});

test('the windows come from the environment', () => {
  assert.deepEqual(guard.guardSettings({}), { blockMs: 3 * 60_000, warnMs: 15 * 60_000 });
  assert.deepEqual(guard.guardSettings({ RESULT_BLOCK_MINUTES: '0', RESULT_WARN_MINUTES: '5' }), { blockMs: 0, warnMs: 5 * 60_000 });
  // The warning window never ends before the block does; nonsense falls back to the defaults.
  assert.deepEqual(guard.guardSettings({ RESULT_BLOCK_MINUTES: '10', RESULT_WARN_MINUTES: '2' }), { blockMs: 10 * 60_000, warnMs: 10 * 60_000 });
  assert.deepEqual(guard.guardSettings({ RESULT_BLOCK_MINUTES: 'x', RESULT_WARN_MINUTES: '-1' }), { blockMs: 3 * 60_000, warnMs: 15 * 60_000 });
});

test('a game logged by a player names them', () => {
  const byHand = { 1: { winner: 'red', submittedAt: '2026-11-01T20:00:00Z', submittedBy: '111', source: 'manual' } };
  const check = guard.checkManualResult({ phaseResults: byHand, gamePhase: 2, now: at(0.5), settings });
  assert.match(guard.guardMessage(check, 2), /\(🔴 Red won\) was logged less than a minute ago, by <@111>/);
});
