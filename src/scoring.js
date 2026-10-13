// Scores and standings, worked out from what was played rather than kept as
// a running total, so leaving, re-joining, overrides and deletes can't make
// them drift. Pure functions; see test/scoring.test.js.
//
//   points  = Σ points from every logged game (history + games logged in
//             matches still in progress) + Σ manual adjustments
//   ranking = points per game (highest first), then total points, then
//             wins, then fewest assassin hits as guesser, then name.

const WIN_POINTS = 3;

// Points for one game: winners +3; losers +1 with 3 or fewer cards left,
// 0 otherwise, −1 if they hit the assassin.
function pointsFor({ assassin, remainingCards }) {
  return { winPoints: WIN_POINTS, losePoints: assassin ? -1 : ((parseInt(remainingCards, 10) || 0) <= 3 ? 1 : 0) };
}

function teams(grouping) {
  return {
    blue: [grouping.blue.spymaster, grouping.blue.guesser],
    red: [grouping.red.spymaster, grouping.red.guesser],
  };
}

// Every logged game as { grouping, winner, assassin, winPoints, losePoints }.
// `activeGames` are games logged in matches still in progress.
function computePlayerTotals({ history = [], activeGames = [], adjustments = [] }) {
  const totals = new Map();
  const get = id => {
    if (!totals.has(id)) totals.set(id, { points: 0, games: 0, wins: 0, assassinsHit: 0, adjustment: 0 });
    return totals.get(id);
  };
  for (const game of [...history, ...activeGames]) {
    if (!game || !game.grouping || (game.winner !== 'blue' && game.winner !== 'red')) continue;
    const { winPoints, losePoints } = Number.isFinite(game.winPoints) && Number.isFinite(game.losePoints)
      ? game : pointsFor(game);
    const t = teams(game.grouping);
    const loser = game.winner === 'blue' ? 'red' : 'blue';
    for (const id of t[game.winner]) { const p = get(id); p.points += winPoints; p.games++; p.wins++; }
    for (const id of t[loser]) { const p = get(id); p.points += losePoints; p.games++; }
    // The losing guesser picked the assassin.
    if (game.assassin) get(game.grouping[loser].guesser).assassinsHit++;
  }
  for (const a of adjustments) {
    const delta = Number(a && a.delta);
    if (!a || !a.userId || !Number.isFinite(delta)) continue;
    const p = get(a.userId);
    p.points += delta;
    p.adjustment += delta;
  }
  return totals;
}

const ppg = t => (t.games > 0 ? t.points / t.games : 0);

// Ranked standings for `playerIds` (players without games get zeros and sort last).
// Returns [{ id, rank, points, games, ppg, wins, assassinsHit }]; equal records share a rank.
function rankStandings(playerIds, totals, nameOf = id => id) {
  const rows = playerIds.map(id => {
    const t = totals.get(id) || { points: 0, games: 0, wins: 0, assassinsHit: 0 };
    return { id, points: t.points, games: t.games, ppg: ppg(t), wins: t.wins, assassinsHit: t.assassinsHit };
  });
  const cmp = (a, b) =>
    (b.games > 0) - (a.games > 0) ||
    b.ppg - a.ppg ||
    b.points - a.points ||
    b.wins - a.wins ||
    a.assassinsHit - b.assassinsHit;
  rows.sort((a, b) => cmp(a, b) || String(nameOf(a.id)).localeCompare(String(nameOf(b.id))));
  rows.forEach((row, i) => {
    row.rank = i > 0 && cmp(rows[i - 1], row) === 0 ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

// One-off migration from the old running totals: record whatever the stored
// total has that the games don't explain as an adjustment, so nobody's points
// change when scores start being derived.
function migrationAdjustments(storedScores, totals, playerIds, at = new Date().toISOString()) {
  const out = [];
  for (const id of playerIds) {
    if (!storedScores.has(id)) continue;
    const derived = (totals.get(id) || { points: 0 }).points;
    const delta = storedScores.get(id) - derived;
    if (delta !== 0) out.push({ userId: id, delta, reason: 'Carried over from the old running total', at, by: 'migration' });
  }
  return out;
}

module.exports = { WIN_POINTS, pointsFor, computePlayerTotals, rankStandings, migrationAdjustments };
