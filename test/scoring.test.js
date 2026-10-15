const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/scoring');

const g = (a, b, c, d) => ({ blue: { spymaster: a, guesser: b }, red: { spymaster: c, guesser: d } });
const game = (grouping, winner, extra = {}) => ({ grouping, winner, assassin: false, remainingCards: 2, ...extra });

test('points per game: winners +3; losers +1 (≤3 left), 0, or −1 (assassin)', () => {
  assert.deepEqual(s.pointsFor({ assassin: false, remainingCards: 3 }), { winPoints: 3, losePoints: 1 });
  assert.deepEqual(s.pointsFor({ assassin: false, remainingCards: 4 }), { winPoints: 3, losePoints: 0 });
  assert.deepEqual(s.pointsFor({ assassin: true, remainingCards: 0 }), { winPoints: 3, losePoints: -1 });
});

test('totals come from the games, plus adjustments', () => {
  const totals = s.computePlayerTotals({
    history: [game(g('a', 'b', 'c', 'd'), 'blue'), game(g('a', 'c', 'b', 'd'), 'red', { assassin: true })],
    activeGames: [game(g('a', 'd', 'b', 'c'), 'blue', { remainingCards: 6 })],
    adjustments: [{ userId: 'd', delta: 2 }, { userId: 'x', delta: 'junk' }],
  });
  // Game 2: blue (a spy, c guesser) lose because c picked the assassin.
  assert.deepEqual(totals.get('a'), { points: 3 - 1 + 3, games: 3, wins: 2, assassinsHit: 0, adjustment: 0 });
  assert.equal(totals.get('c').assassinsHit, 1);
  assert.equal(totals.get('b').points, 3 + 3 + 0);
  assert.equal(totals.get('d').points, 1 + 3 + 3 + 2);
  assert.equal(totals.get('d').adjustment, 2);
  assert.ok(!totals.has('x'));
});

test('stored winPoints/losePoints are used when present (old results)', () => {
  const totals = s.computePlayerTotals({ history: [{ ...game(g('a', 'b', 'c', 'd'), 'blue'), winPoints: 5, losePoints: 2 }] });
  assert.equal(totals.get('a').points, 5);
  assert.equal(totals.get('c').points, 2);
});

test('ranking: points per game first, then points, wins, fewest assassins; no-game players last', () => {
  const totals = new Map([
    ['busy', { points: 30, games: 15, wins: 9, assassinsHit: 0 }],   // 2.00
    ['sharp', { points: 22, games: 10, wins: 6, assassinsHit: 0 }],  // 2.20
    ['tieA', { points: 20, games: 10, wins: 6, assassinsHit: 1 }],   // 2.00, fewer points than busy
    ['tieB', { points: 20, games: 10, wins: 6, assassinsHit: 1 }],
    ['new', { points: 0, games: 0, wins: 0, assassinsHit: 0 }],
  ]);
  const rows = s.rankStandings(['new', 'tieB', 'busy', 'tieA', 'sharp'], totals);
  assert.deepEqual(rows.map(r => r.id), ['sharp', 'busy', 'tieA', 'tieB', 'new']);
  assert.deepEqual(rows.map(r => r.rank), [1, 2, 3, 3, 5]);
  assert.equal(rows[0].ppg, 2.2);
});

test('leaving and re-joining cannot change anyone\'s points', () => {
  const history = [game(g('a', 'b', 'c', 'd'), 'blue'), game(g('b', 'a', 'd', 'c'), 'red')];
  const before = s.computePlayerTotals({ history });
  // "d" leaves mid-match and the match finishes: their points just keep coming from the games.
  const after = s.computePlayerTotals({ history: [...history, game(g('a', 'c', 'b', 'd'), 'red')] });
  assert.equal(after.get('d').points, before.get('d').points + 3);
  // Standings only list current players; d's record is still there for the "left" list.
  assert.deepEqual(s.rankStandings(['a', 'b', 'c'], after).map(r => r.id).sort(), ['a', 'b', 'c']);
});

test('migration keeps everyone\'s current total', () => {
  const history = [game(g('a', 'b', 'c', 'd'), 'blue')];
  const totals = s.computePlayerTotals({ history });
  const stored = new Map([['a', 5], ['b', 3], ['c', 1], ['d', 0], ['gone', 9]]);
  const adj = s.migrationAdjustments(stored, totals, ['a', 'b', 'c', 'd'], 'now');
  assert.deepEqual(adj.map(x => [x.userId, x.delta]), [['a', 2], ['d', -1]]);
  const migrated = s.computePlayerTotals({ history, adjustments: adj });
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(migrated.get(id).points, stored.get(id));
});
