const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/scheduler');

const players = n => Array.from({ length: n }, (_, i) => String(100 + i));
const game = (bs, bg, rs, rg) => ({ blue: { spymaster: bs, guesser: bg }, red: { spymaster: rs, guesser: rg } });
const allGames = rounds => rounds.flat().flatMap(m => m.games);
const quick = { seed: 7, timeBudgetMs: 1500 };

function assertValidSchedule(ids, rounds, history = []) {
  const groups = new Set();
  for (const round of rounds) {
    const seen = new Set();
    for (const match of round) {
      assert.equal(match.players.length, 4);
      for (const p of match.players) {
        assert.ok(!seen.has(p), `player ${p} is in two matches in one round`);
        seen.add(p);
      }
      const key = s.groupKey(match.players);
      assert.ok(!groups.has(key), `group ${key} is scheduled twice`);
      groups.add(key);
      assert.ok(match.games.length >= 1 && match.games.length <= 6);
      for (const g of match.games) assert.deepEqual(s.playersOf(g).slice().sort(), match.players);
    }
  }
  const state = s.buildPlayedState([...history, ...allGames(rounds)]);
  assert.equal(s.missingFactCount(state, ids), 0, 'some pair never teamed up against some player');
}

test('a group plays all three splits, each with both role configurations', () => {
  const games = s.owedGamesForGroup(s.buildPlayedState([]), ['1', '2', '3', '4']);
  assert.equal(games.length, 6);
  const splits = new Map();
  for (const g of games) {
    const key = s.splitKey([g.blue.spymaster, g.blue.guesser], [g.red.spymaster, g.red.guesser]);
    if (!splits.has(key)) splits.set(key, new Set());
    splits.get(key).add(g.blue.spymaster).add(g.red.spymaster);
  }
  assert.equal(splits.size, 3);
  for (const spied of splits.values()) assert.equal(spied.size, 4, 'every player spies once per split');
  // Everyone is spymaster 3 times and operative 3 times.
  for (const p of ['1', '2', '3', '4']) {
    assert.equal(games.filter(g => g.blue.spymaster === p || g.red.spymaster === p).length, 3);
  }
});

test('games already played are not scheduled again', () => {
  // Old format: A&B v C&D as drawn, then both teams swapped. That split is done.
  const history = [game('1', '2', '3', '4'), game('2', '1', '4', '3')];
  const owed = s.owedGamesForGroup(s.buildPlayedState(history), ['1', '2', '3', '4']);
  assert.equal(owed.length, 4);
  // Old "only blue swapped" game: one more game finishes that split.
  const partial = s.owedGamesForGroup(s.buildPlayedState([game('1', '2', '3', '4'), game('2', '1', '3', '4')]), ['1', '2', '3', '4']);
  assert.equal(partial.length, 5);
  const finishing = partial[0];
  assert.equal(finishing.red.spymaster, '4');
});

test('four players: one 6-game match covers everything', () => {
  const rounds = s.generateSchedule(players(4), quick);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0][0].games.length, 6);
  assertValidSchedule(players(4), rounds);
});

for (const n of [5, 8, 10, 14]) {
  test(`${n} players: valid schedule near the theoretical minimum`, () => {
    const ids = players(n);
    const rounds = s.generateSchedule(ids, quick);
    assertValidSchedule(ids, rounds);
    const { minRounds } = s.predictSchedule(n);
    assert.ok(rounds.length <= Math.ceil(minRounds * 1.3) + 1, `${rounds.length} rounds vs minimum ${minRounds}`);
  });
}

test('sit-outs are spread evenly', () => {
  const ids = players(14);
  const rounds = s.generateSchedule(ids, quick);
  const sat = new Map(ids.map(p => [p, 0]));
  for (const round of rounds) {
    const playing = new Set(round.flatMap(m => m.players));
    for (const p of ids) if (!playing.has(p)) sat.set(p, sat.get(p) + 1);
  }
  const counts = [...sat.values()];
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 4, `sit-outs ${Math.min(...counts)}-${Math.max(...counts)}`);
});

test('a running tournament: history counts and the rest is filled in', () => {
  const ids = players(8);
  const first = s.generateSchedule(ids, quick);
  const history = allGames(first.slice(0, 3)).concat(
    // plus a half-played match from an older format
    [game('100', '101', '104', '105')],
  );
  const rest = s.generateSchedule(ids, { ...quick, playedGroupings: history });
  assertValidSchedule(ids, rest, history);
  const replayed = new Set(first.slice(0, 3).flat().map(m => s.groupKey(m.players)));
  for (const m of rest.flat()) assert.ok(!replayed.has(s.groupKey(m.players)), 'a finished group was scheduled again');
});

test('a player who left is ignored and a new player is fitted in', () => {
  const ids = players(8);
  const history = allGames(s.generateSchedule(ids, quick).slice(0, 2));
  const now = ids.filter(p => p !== '103').concat('999');
  const rounds = s.generateSchedule(now, { ...quick, playedGroupings: history });
  assertValidSchedule(now, rounds, history);
  assert.ok(rounds.flat().every(m => !m.players.includes('103')));
});

test('nothing left to schedule returns no rounds', () => {
  const ids = players(4);
  const history = allGames(s.generateSchedule(ids, quick));
  assert.deepEqual(s.generateSchedule(ids, { ...quick, playedGroupings: history }), []);
  assert.deepEqual(s.generateSchedule(players(3), quick), []);
});

test('prediction', () => {
  assert.equal(s.predictSchedule(3), null);
  assert.deepEqual(s.predictSchedule(14), { matches: 91, games: 546, minRounds: 31, matchesPerRound: 3 });
});
