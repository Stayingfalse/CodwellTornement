const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const cards = require('../src/cards');

const ids = n => Array.from({ length: n }, (_, i) => String(100000000000000000n + BigInt(i)));
const g = (a, b, c, d) => ({ blue: { spymaster: a, guesser: b }, red: { spymaster: c, guesser: d } });
const SIX = (() => { const [a, b, c, d] = ids(4); return [g(a, b, c, d), g(b, a, d, c), g(a, c, b, d), g(c, a, d, b), g(a, d, b, c), g(d, a, c, b)]; })();

// Serialise through discord.js (which validates every component) and check
// Discord's per-message limits: 40 components, 4000 characters of text.
function render(p) {
  assert.equal(p.flags, MessageFlags.IsComponentsV2);
  assert.ok(p.allowedMentions && Array.isArray(p.allowedMentions.parse) && p.allowedMentions.parse.length === 0, 'mentions must be opt-in');
  const json = p.components.map(c => c.toJSON());
  let count = 0;
  let chars = 0;
  const ids = [];
  const walk = node => {
    count++;
    if (typeof node.content === 'string') chars += node.content.length;
    if (node.custom_id) ids.push(node.custom_id);
    for (const child of node.components || []) walk(child);
    if (node.accessory) walk(node.accessory);
  };
  json.forEach(walk);
  assert.ok(count <= 40, `${count} components`);
  assert.ok(chars <= 4000, `${chars} characters`);
  return { json, ids, text: JSON.stringify(json) };
}

const live = (players, active) => ({
  phase: 'live', round: 3, totalRounds: 34, matchesInRound: active, matchesDone: 0, deadlineMs: Date.now() + 864e5,
  signupsOpen: false,
  standings: players.map((p, i) => ({ id: p, rank: i + 1, points: 40 - i, games: 8, ppg: (40 - i) / 8 })),
  activeMatches: Array.from({ length: active }, (_, i) => ({ matchNumber: i + 1, game: 2, gamesPlanned: 6, players: players.slice(i * 4, i * 4 + 4), threadUrl: `https://discord.com/channels/1/${i}` })),
});

test('sign-up card keeps the signup button id', () => {
  const players = ids(14);
  const r = render(cards.tournamentCard({ phase: 'signup', players, prediction: { matches: 91, games: 546, minRounds: 31, matchesPerRound: 3 } }, { webUrl: 'https://x.test' }));
  assert.deepEqual(r.ids, ['signup']);
  assert.match(r.text, /Signed up \(14\)/);
});

test('live card fits Discord limits with a large tournament', () => {
  for (const n of [4, 14, 40, 80]) {
    const players = ids(n);
    const r = render(cards.tournamentCard(live(players, Math.floor(n / 4)), { webUrl: 'https://x.test' }));
    assert.deepEqual(r.ids, ['leave_tournament']);
  }
});

test('complete card', () => {
  const players = ids(14);
  const r = render(cards.tournamentCard({ phase: 'complete', standings: players.map((p, i) => ({ id: p, rank: i + 1, points: 50 - i, games: i ? 10 : 0, ppg: i ? (50 - i) / 10 : 0 })) }, { webUrl: 'https://x.test' }));
  assert.match(r.text, /Tournament complete/);
});

test('game cards keep the legacy result button ids and only game 1 pings', () => {
  const first = cards.gameCard({ round: 3, matchNumber: 1, gameIndex: 1, games: SIX, bridgeEnabled: true, intro: true });
  const r1 = render(first);
  assert.deepEqual(r1.ids, ['log_blue_win', 'log_red_win']);
  assert.equal(first.allowedMentions.users.length, 4);
  assert.match(r1.text, /Match plan/);
  const fifth = cards.gameCard({ round: 3, matchNumber: 1, gameIndex: 5, games: SIX, bridgeEnabled: false });
  assert.deepEqual(render(fifth).ids, ['log_blue_win_g5', 'log_red_win_g5']);
  assert.equal(fifth.allowedMentions.users.length, 0);
});

test('round, summary and expiry cards', () => {
  const players = ids(16);
  render(cards.roundCard({ round: 4, deadlineMs: Date.now() + 864e5, matches: [0, 1, 2, 3].map(i => ({ matchNumber: i + 1, players: players.slice(i * 4, i * 4 + 4), gamesPlanned: 6, threadUrl: 'https://discord.com/channels/1/2' })) }));
  const byMatch = Array.from({ length: 10 }, (_, i) => ({ matchNumber: i + 1, games: SIX.map((grouping, j) => ({ gameIndex: j + 1, winner: j % 2 ? 'red' : 'blue', assassin: j === 3, remainingCards: 2, winPoints: 3, losePoints: 1, grouping })) }));
  render(cards.roundSummaryCard({ round: 3, byMatch }));
  render(cards.roundSummaryCard({ round: 3, byMatch: [] }));
  render(cards.roundExpiryCard({ round: 3, deadlineMs: Date.now(), totalMatches: 4, completed: [{ matchNumber: 1, played: 6, blueWins: 4 }], active: [{ matchNumber: 2, game: 3, gamesPlanned: 6, players: players.slice(0, 4) }], webUrl: 'https://x.test' }));
});

test('bridge confirmation keeps its button ids', () => {
  const r = render(cards.bridgeConfirmCard({ pendingId: 'ab12cd34', gamePhase: 2, winner: 'red', assassin: false, remainingCards: 3, roomUrl: 'https://codenames.game/room/x', expected: SIX[1], seatsText: '🔵 Spymaster: <@1>' }));
  assert.deepEqual(r.ids, ['cnb_ok_ab12cd34', 'cnb_no_ab12cd34']);
  render(cards.noticeCard('Confirmed by <@1>.'));
});
