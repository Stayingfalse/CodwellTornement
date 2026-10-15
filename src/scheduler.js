// Tournament scheduler (see docs/review-plan.md).
//
// Goal: every pair of players has teamed up against every other player.
// Each round splits the players into groups of four. A group plays every way
// its four players can split into two teams (AB v CD, AC v BD, AD v BC), and
// every split is played twice so that each teammate pair takes both roles:
//
//   AB v CD:  A spy + B op  v  C spy + D op,  then  B spy + A op  v  D spy + C op
//
// That is 6 games, minus any of them the group has already played (history
// from earlier formats counts), so a match can be shorter than 6 games.
//
// A split is "complete" once both members of each team have been spymaster in
// it. A complete AB v CD split means A&B have teamed against C and against D.
// Those (pair, opponent) facts are what the tournament must cover. Rounds are
// built until every fact among the active players is covered. A group whose
// facts are all covered already is never scheduled, so the same four players
// never meet as a group again once their match is done.
//
// Everything here is pure (no Discord, no I/O) so it can be tested directly.

const ROLE_SPLITS = [
  [[0, 1], [2, 3]],
  [[0, 2], [1, 3]],
  [[0, 3], [1, 2]],
];

const sortIds = ids => ids.slice().sort();
const pairKey = (a, b) => (a < b ? `${a}+${b}` : `${b}+${a}`);
const splitKey = (pairA, pairB) => [pairKey(...pairA), pairKey(...pairB)].sort().join('|');
const groupKey = ids => sortIds(ids).join(',');
const factKey = (pair, opponent) => `${pairKey(...pair)}>${opponent}`;

function playersOf(grouping) {
  return [grouping.blue.spymaster, grouping.blue.guesser, grouping.red.spymaster, grouping.red.guesser];
}

function isValidGrouping(grouping) {
  return !!(grouping && grouping.blue && grouping.red &&
    grouping.blue.spymaster && grouping.blue.guesser && grouping.red.spymaster && grouping.red.guesser &&
    new Set(playersOf(grouping)).size === 4);
}

// What has been played: per split, who has been spymaster in it.
function createPlayedState() {
  return { spied: new Map(), facts: new Set() };
}

function splitTeams(grouping) {
  return [[grouping.blue.spymaster, grouping.blue.guesser], [grouping.red.spymaster, grouping.red.guesser]];
}

// Record one played (or already scheduled) game.
function recordGame(state, grouping) {
  if (!isValidGrouping(grouping)) return;
  const [teamA, teamB] = splitTeams(grouping);
  const key = splitKey(teamA, teamB);
  if (!state.spied.has(key)) state.spied.set(key, new Set());
  const spied = state.spied.get(key);
  spied.add(teamA[0]);
  spied.add(teamB[0]);
  if (teamA.every(id => spied.has(id)) && teamB.every(id => spied.has(id))) {
    for (const opp of teamB) state.facts.add(factKey(teamA, opp));
    for (const opp of teamA) state.facts.add(factKey(teamB, opp));
  }
}

function buildPlayedState(groupings) {
  const state = createPlayedState();
  for (const g of groupings) recordGame(state, g);
  return state;
}

// The games a split still needs so both members of each team have been spymaster.
function owedGamesForSplit(state, teamA, teamB) {
  const spied = state.spied.get(splitKey(teamA, teamB)) || new Set();
  const owedA = teamA.filter(id => !spied.has(id));
  const owedB = teamB.filter(id => !spied.has(id));
  const count = Math.max(owedA.length, owedB.length);
  const games = [];
  let prevA = null;
  let prevB = null;
  for (let i = 0; i < count; i++) {
    // A team whose members have both been spymaster still plays; swap its roles from the previous game.
    const spyA = owedA[i] ?? (prevA ? teamA.find(id => id !== prevA) : teamA[0]);
    const spyB = owedB[i] ?? (prevB ? teamB.find(id => id !== prevB) : teamB[0]);
    prevA = spyA;
    prevB = spyB;
    const guessA = teamA.find(id => id !== spyA);
    const guessB = teamB.find(id => id !== spyB);
    games.push({ blue: { spymaster: spyA, guesser: guessA }, red: { spymaster: spyB, guesser: guessB } });
  }
  return games;
}

// All the games a group of four still owes, split by split (0-6 games).
function owedGamesForGroup(state, ids) {
  const games = [];
  for (const [a, b] of ROLE_SPLITS) {
    const teamA = [ids[a[0]], ids[a[1]]];
    const teamB = [ids[b[0]], ids[b[1]]];
    games.push(...owedGamesForSplit(state, teamA, teamB));
  }
  return games;
}

function groupFacts(ids) {
  const facts = [];
  for (const [a, b] of ROLE_SPLITS) {
    const teamA = [ids[a[0]], ids[a[1]]];
    const teamB = [ids[b[0]], ids[b[1]]];
    for (const opp of teamB) facts.push(factKey(teamA, opp));
    for (const opp of teamA) facts.push(factKey(teamB, opp));
  }
  return facts;
}

// How many still-missing facts a group would cover (0-12).
function groupGain(state, ids) {
  let gain = 0;
  for (const f of groupFacts(ids)) if (!state.facts.has(f)) gain++;
  return gain;
}

function allFacts(players) {
  const facts = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      for (const opp of players) {
        if (opp !== players[i] && opp !== players[j]) facts.push(factKey([players[i], players[j]], opp));
      }
    }
  }
  return facts;
}

function missingFactCount(state, players) {
  return allFacts(players).filter(f => !state.facts.has(f)).length;
}

// Seeded PRNG (mulberry32) so tests are repeatable.
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Choosing the groups ─────────────────────────────────────────────────────
// Step 1 finds as few groups as possible that cover every missing fact (a
// covering design, found by greedy + simulated annealing). Step 2 packs those
// groups into rounds of disjoint groups. Planning the whole set first avoids
// the half-useful groups a round-by-round greedy is left with at the end.

const DEFAULT_TIME_BUDGET_MS = 4000;
const LOAD_WEIGHT = 0.05;

// Facts as integers: pairIndex * n + opponent (indices into the player list).
function indexFacts(n) {
  const pairIndex = new Int32Array(n * n).fill(-1);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairIndex[i * n + j] = pairIndex[j * n + i] = pairs.length;
      pairs.push([i, j]);
    }
  }
  return { n, pairs, factCount: pairs.length * n, factId: (i, j, opp) => pairIndex[i * n + j] * n + opp };
}

// The 12 facts of a group.
function blockFactIds(ix, b) {
  const out = [];
  for (let x = 0; x < 4; x++) {
    for (let y = x + 1; y < 4; y++) {
      for (let z = 0; z < 4; z++) if (z !== x && z !== y) out.push(ix.factId(b[x], b[y], b[z]));
    }
  }
  return out;
}

// The 9 facts of a group that involve whoever stands at `pos`, if that were `p`.
function memberFactIds(ix, b, pos, p) {
  const o = b.filter((_, i) => i !== pos);
  return [
    ix.factId(p, o[0], o[1]), ix.factId(p, o[0], o[2]),
    ix.factId(p, o[1], o[0]), ix.factId(p, o[1], o[2]),
    ix.factId(p, o[2], o[0]), ix.factId(p, o[2], o[1]),
    ix.factId(o[0], o[1], p), ix.factId(o[0], o[2], p), ix.factId(o[1], o[2], p),
  ];
}

// Try to cover every missing fact with `blocks.length` groups (mutates `blocks`).
function annealCover(ix, missing, blocks, rng, deadline, iterations) {
  const cnt = new Int32Array(ix.factCount);
  const load = new Int32Array(ix.n);
  for (const b of blocks) for (const p of b) load[p]++;
  let uncovered = 0;
  for (let f = 0; f < ix.factCount; f++) {
    if (missing[f]) uncovered++;
    else cnt[f] = 1 << 20; // covered already (or not needed): never counts as lost
  }
  for (const b of blocks) for (const f of blockFactIds(ix, b)) { if (cnt[f] === 0) uncovered--; cnt[f]++; }
  let temp = 0.6;
  const cool = Math.pow(0.02 / temp, 1 / iterations);
  for (let it = 0; it < iterations && uncovered > 0; it++) {
    if ((it & 4095) === 0 && Date.now() > deadline) break;
    const b = blocks[Math.floor(rng() * blocks.length)];
    const pos = Math.floor(rng() * 4);
    let p;
    do { p = Math.floor(rng() * ix.n); } while (b.includes(p));
    const lost = memberFactIds(ix, b, pos, b[pos]);
    const gained = memberFactIds(ix, b, pos, p);
    let delta = 0;
    for (const f of lost) if (cnt[f] === 1) delta++;
    for (const f of gained) if (cnt[f] === 0) delta--;
    // Keep matches per player even, so the groups pack into few rounds.
    delta += LOAD_WEIGHT * (2 * (load[p] - load[b[pos]]) + 2);
    if (delta <= 0 || rng() < Math.exp(-delta / temp)) {
      load[b[pos]]--;
      load[p]++;
      for (const f of lost) { cnt[f]--; if (cnt[f] === 0) uncovered++; }
      for (const f of gained) { if (cnt[f] === 0) uncovered--; cnt[f]++; }
      b[pos] = p;
    }
    temp *= cool;
  }
  return uncovered === 0;
}

// Greedy cover: keep adding the sampled group that covers the most missing facts.
function greedyCover(ix, missing, rng) {
  const left = Uint8Array.from(missing);
  let remaining = left.reduce((a, v) => a + v, 0);
  const everyone = Array.from({ length: ix.n }, (_, i) => i);
  const blocks = [];
  while (remaining > 0) {
    // Always consider a group built around one missing fact, so progress is guaranteed.
    const f = left.indexOf(1);
    const [i, j] = ix.pairs[Math.floor(f / ix.n)];
    const opp = f % ix.n;
    let best = [i, j, opp, everyone.find(x => x !== i && x !== j && x !== opp)];
    let bestGain = 0;
    for (const f2 of blockFactIds(ix, best)) if (left[f2]) bestGain++;
    for (let t = 0; t < 400; t++) {
      const b = shuffle(everyone.slice(), rng).slice(0, 4);
      let gain = 0;
      for (const f2 of blockFactIds(ix, b)) if (left[f2]) gain++;
      if (gain > bestGain) { bestGain = gain; best = b; }
    }
    for (const f2 of blockFactIds(ix, best)) if (left[f2]) { left[f2] = 0; remaining--; }
    blocks.push(best);
  }
  return blocks;
}

function findCover(ix, missing, rng, deadline) {
  let best = greedyCover(ix, missing, rng);
  // Drop one group at a time while annealing can still cover everything.
  let failures = 0;
  while (best.length > 1 && failures < 3 && Date.now() < deadline) {
    const trial = best.map(b => b.slice());
    trial.splice(Math.floor(rng() * trial.length), 1);
    if (annealCover(ix, missing, trial, rng, deadline, 300000)) { best = trial; failures = 0; } else failures++;
  }
  return best;
}

// Pack groups into rounds of disjoint groups. Each round is a bounded search
// for `groupCount` disjoint groups, trying groups with the busiest players
// first (they set the minimum number of rounds); ties favour players who have
// sat out more.
const PACK_NODE_LIMIT = 20000;

function packRounds(blocks, n, groupCount, sitOuts, rng) {
  const remaining = blocks.map(b => b.slice());
  const rounds = [];
  while (remaining.length > 0) {
    const load = new Array(n).fill(0);
    for (const b of remaining) for (const p of b) load[p]++;
    const order = remaining
      .map((b, i) => ({ i, w: b.reduce((a, p) => a + load[p] * 10 + sitOuts[p], 0) + rng() * 8 }))
      .sort((a, b) => b.w - a.w)
      .map(o => o.i);
    let best = [];
    let nodes = 0;
    const used = new Uint8Array(n);
    const pick = [];
    const search = start => {
      if (pick.length > best.length) best = pick.slice();
      if (best.length === groupCount || ++nodes > PACK_NODE_LIMIT) return;
      for (let k = start; k < order.length; k++) {
        const b = remaining[order[k]];
        if (b.some(p => used[p])) continue;
        b.forEach(p => { used[p] = 1; });
        pick.push(order[k]);
        search(k + 1);
        pick.pop();
        b.forEach(p => { used[p] = 0; });
        if (best.length === groupCount || nodes > PACK_NODE_LIMIT) return;
      }
    };
    search(0);
    const playing = new Set(best.flatMap(i => remaining[i]));
    for (let p = 0; p < n; p++) if (!playing.has(p)) sitOuts[p]++;
    rounds.push(best.map(i => remaining[i]));
    best.sort((a, b) => b - a).forEach(i => remaining.splice(i, 1));
  }
  return rounds;
}

// Step 3: tune the rounds themselves. Each round is a full arrangement of the
// players (groups, then sitters); a move swaps two players between groups or
// with a sitter. After packing, try dropping whole rounds while annealing can
// still cover every missing fact. Sit-outs are kept even with a small penalty.
const SIT_WEIGHT = 0.02;

function annealRounds(ix, missing, rounds, groupCount, sitBase, rng, deadline, iterations) {
  const n = ix.n;
  const cnt = new Int32Array(ix.factCount);
  let uncovered = 0;
  for (let f = 0; f < ix.factCount; f++) {
    if (missing[f]) uncovered++;
    else cnt[f] = 1 << 20;
  }
  const sit = Int32Array.from(sitBase);
  const groupSize = groupCount * 4;
  const addGroup = (order, g, sign) => {
    for (const f of blockFactIds(ix, order.slice(g * 4, g * 4 + 4))) {
      if (sign > 0) { if (cnt[f] === 0) uncovered--; cnt[f]++; } else { cnt[f]--; if (cnt[f] === 0) uncovered++; }
    }
  };
  for (const order of rounds) {
    for (let g = 0; g < groupCount; g++) addGroup(order, g, 1);
    for (let i = groupSize; i < n; i++) sit[order[i]]++;
  }
  let temp = 0.5;
  const cool = Math.pow(0.02 / temp, 1 / iterations);
  for (let it = 0; it < iterations && uncovered > 0; it++) {
    if ((it & 2047) === 0 && Date.now() > deadline) break;
    const order = rounds[Math.floor(rng() * rounds.length)];
    const i = Math.floor(rng() * n);
    const j = Math.floor(rng() * n);
    const gi = i < groupSize ? Math.floor(i / 4) : -1;
    const gj = j < groupSize ? Math.floor(j / 4) : -1;
    if (gi === gj) continue;
    const before = uncovered;
    let sitDelta = 0;
    if (gi < 0) sitDelta += 2 * (sit[order[j]] - sit[order[i]]) + 2; // order[j] sits, order[i] plays
    if (gj < 0) sitDelta += 2 * (sit[order[i]] - sit[order[j]]) + 2;
    if (gi >= 0) addGroup(order, gi, -1);
    if (gj >= 0) addGroup(order, gj, -1);
    [order[i], order[j]] = [order[j], order[i]];
    if (gi >= 0) addGroup(order, gi, 1);
    if (gj >= 0) addGroup(order, gj, 1);
    const delta = (uncovered - before) + SIT_WEIGHT * sitDelta;
    if (delta <= 0 || rng() < Math.exp(-delta / temp)) {
      if (gi < 0) { sit[order[i]]++; sit[order[j]]--; }
      if (gj < 0) { sit[order[j]]++; sit[order[i]]--; }
    } else {
      if (gi >= 0) addGroup(order, gi, -1);
      if (gj >= 0) addGroup(order, gj, -1);
      [order[i], order[j]] = [order[j], order[i]];
      if (gi >= 0) addGroup(order, gi, 1);
      if (gj >= 0) addGroup(order, gj, 1);
    }
    temp *= cool;
  }
  return uncovered === 0;
}

// Packed rounds (lists of groups) -> full arrangements; spare players fill empty groups.
function toArrangements(packed, n, rng) {
  return packed.map(round => {
    const used = new Set(round.flat());
    const rest = shuffle(Array.from({ length: n }, (_, i) => i).filter(p => !used.has(p)), rng);
    return [...round.flat(), ...rest];
  });
}

function compressRounds(ix, missing, arrangements, groupCount, sitBase, rng, deadline) {
  let best = arrangements;
  let failures = 0;
  while (best.length > 1 && failures < 3 && Date.now() < deadline) {
    const trial = best.map(o => o.slice());
    trial.splice(Math.floor(rng() * trial.length), 1);
    if (annealRounds(ix, missing, trial, groupCount, sitBase, rng, deadline, 400000)) { best = trial; failures = 0; } else failures++;
  }
  return best;
}

// Build every remaining round. `playedGroupings` = every game already played or
// already scheduled (history + matches in progress). `sitOutCounts` = rounds
// each player has sat out so far, so sit-outs stay fair across a recalculation.
function generateSchedule(players, { playedGroupings = [], sitOutCounts = null, seed = Date.now(), timeBudgetMs = DEFAULT_TIME_BUDGET_MS } = {}) {
  const rng = makeRng(seed);
  const active = sortIds(Array.from(new Set(players)));
  if (active.length < 4) return [];
  const state = buildPlayedState(playedGroupings);
  const ix = indexFacts(active.length);
  const missing = new Uint8Array(ix.factCount);
  let missingCount = 0;
  for (const [i, j] of ix.pairs) {
    for (let o = 0; o < active.length; o++) {
      if (o === i || o === j) continue;
      if (!state.facts.has(factKey([active[i], active[j]], active[o]))) { missing[ix.factId(i, j, o)] = 1; missingCount++; }
    }
  }
  if (missingCount === 0) return [];

  const started = Date.now();
  const groupCount = Math.floor(active.length / 4);
  const sitBase = active.map(p => (sitOutCounts && sitOutCounts.get(p)) || 0);
  const blocks = findCover(ix, missing, rng, started + timeBudgetMs * 0.4);
  const packed = packRounds(blocks, active.length, groupCount, sitBase.slice(), rng);
  const arrangements = compressRounds(ix, missing, toArrangements(packed, active.length, rng), groupCount, sitBase, rng, started + timeBudgetMs);

  // Turn arrangements into matches. A group that would add nothing new (all
  // its facts covered earlier in the schedule) is dropped: those four sit out.
  const rounds = [];
  for (const order of arrangements) {
    const round = [];
    for (let g = 0; g < groupCount; g++) {
      const ids = order.slice(g * 4, g * 4 + 4).map(i => active[i]);
      if (groupGain(state, ids) === 0) continue;
      const games = owedGamesForGroup(state, shuffle(ids, rng));
      for (const game of games) recordGame(state, game);
      round.push({ players: sortIds(ids), games, grouping: games[0], gamesPlanned: games.length });
    }
    if (round.length > 0) rounds.push(round);
  }
  return rounds;
}

// generateSchedule on a worker thread, so the bot keeps answering Discord
// while it runs. Falls back to running here if a worker can't be started.
function generateScheduleAsync(players, options = {}) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(require('path').join(__dirname, 'scheduleWorker.js'), { workerData: { players, options } });
    } catch (error) {
      console.warn('[scheduler] Worker unavailable, planning on the main thread:', error.message);
      try { resolve(generateSchedule(players, options)); } catch (e) { reject(e); }
      return;
    }
    let settled = false;
    worker.once('message', msg => {
      settled = true;
      if (msg.ok) resolve(msg.rounds); else reject(new Error(msg.error));
    });
    worker.once('error', error => { if (!settled) { settled = true; reject(error); } });
    worker.once('exit', code => { if (!settled) { settled = true; reject(new Error(`scheduler worker exited with code ${code}`)); } });
  });
}

// Size of a fresh schedule at best, for the sign-up embed: every set of three
// players must share a group, a group holds 4 such sets, and a round holds
// floor(n/4) groups. Real schedules come out somewhat longer.
function predictSchedule(playerCount) {
  if (playerCount < 4) return null;
  const triples = playerCount * (playerCount - 1) * (playerCount - 2) / 6;
  const matches = Math.ceil(triples / 4);
  const perRound = Math.floor(playerCount / 4);
  return { matches, games: matches * 6, minRounds: Math.ceil(matches / perRound), matchesPerRound: perRound };
}

module.exports = {
  generateSchedule,
  generateScheduleAsync,
  predictSchedule,
  buildPlayedState,
  recordGame,
  owedGamesForGroup,
  groupGain,
  missingFactCount,
  allFacts,
  playersOf,
  isValidGrouping,
  splitKey,
  groupKey,
  makeRng,
};
