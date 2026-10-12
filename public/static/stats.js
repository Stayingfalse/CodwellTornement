// Stats tab: computed in the browser from the tournament history (/api).
// Relies on app.js for D (data), esc() and displayName().

// ── Stats: filter state ───────────────────────────────────────────────────
let statsFilterRounds = new Set(['all']);
let statsTableSort = { col: 'totalWinRate', asc: false };
let lastStats = null;

function filterRound(round) {
  if (round === 'all') {
    statsFilterRounds = new Set(['all']);
  } else {
    statsFilterRounds.delete('all');
    if (statsFilterRounds.has(round)) {
      statsFilterRounds.delete(round);
      if (statsFilterRounds.size === 0) statsFilterRounds.add('all');
    } else {
      statsFilterRounds.add(round);
    }
  }
  renderStats();
}

function getFilteredHistory() {
  if (!D || !D.history) return [];
  if (statsFilterRounds.has('all')) return D.history;
  return D.history.filter(h => statsFilterRounds.has(h.roundNumber));
}

// ── Stats: build round filter chips ───────────────────────────────────────
function buildRoundFilterChips() {
  const container = document.getElementById('filter-rounds');
  const rounds = D && D.history
    ? [...new Set(D.history.map(h => h.roundNumber))].sort((a, b) => a - b)
    : [];

  const allActive = statsFilterRounds.has('all');
  let html = `<button class="filter-chip ${allActive ? 'active' : ''}" onclick="filterRound('all')">All</button>`;
  for (const r of rounds) {
    const active = statsFilterRounds.has(r);
    html += `<button class="filter-chip ${active ? 'active' : ''}" onclick="filterRound(${r})">R${r}</button>`;
  }
  container.innerHTML = html;
}

// ── Stats: computation ────────────────────────────────────────────────────
function computeStats(history) {
  const pd = {};  // playerId -> per-player stats object
  const cardsDist = {};  // remainingCards count -> frequency
  let totalGames = 0, totalAssassinHits = 0;

  function ep(id) {
    if (!pd[id]) pd[id] = { spyGames: 0, spyWins: 0, guessGames: 0, guessWins: 0, assassinAsGuesser: 0, teammateAssassinAsSpy: 0 };
    return pd[id];
  }

  for (const game of history) {
    const { grouping, winner, assassin, remainingCards } = game;
    totalGames++;
    if (assassin) totalAssassinHits++;

    // Cards distribution (non-assassin only)
    if (!assassin && remainingCards != null) {
      cardsDist[remainingCards] = (cardsDist[remainingCards] || 0) + 1;
    }

    // Blue spymaster
    const bSpy = ep(grouping.blue.spymaster);
    bSpy.spyGames++;
    if (winner === 'blue') bSpy.spyWins++;
    if (assassin && winner === 'red') bSpy.teammateAssassinAsSpy++;

    // Blue guesser
    const bGue = ep(grouping.blue.guesser);
    bGue.guessGames++;
    if (winner === 'blue') bGue.guessWins++;
    if (assassin && winner === 'red') bGue.assassinAsGuesser++;

    // Red spymaster
    const rSpy = ep(grouping.red.spymaster);
    rSpy.spyGames++;
    if (winner === 'red') rSpy.spyWins++;
    if (assassin && winner === 'blue') rSpy.teammateAssassinAsSpy++;

    // Red guesser
    const rGue = ep(grouping.red.guesser);
    rGue.guessGames++;
    if (winner === 'red') rGue.guessWins++;
    if (assassin && winner === 'blue') rGue.assassinAsGuesser++;
  }

  // Average cards remaining (non-assassin games)
  let totalCards = 0, cardCount = 0;
  for (const [n, freq] of Object.entries(cardsDist)) {
    totalCards += parseInt(n) * freq;
    cardCount += freq;
  }
  const avgCards = cardCount > 0 ? totalCards / cardCount : null;

  // Best guesser / spymaster (min 3 games in their role)
  const TROPHY_MIN = 3;
  let bestGuesser = null, bestSpymaster = null;
  for (const [id, p] of Object.entries(pd)) {
    if (p.guessGames >= TROPHY_MIN) {
      const r = p.guessWins / p.guessGames;
      if (!bestGuesser || r > bestGuesser.rate || (r === bestGuesser.rate && p.guessGames > bestGuesser.games)) {
        bestGuesser = { id, rate: r, games: p.guessGames };
      }
    }
    if (p.spyGames >= TROPHY_MIN) {
      const r = p.spyWins / p.spyGames;
      if (!bestSpymaster || r > bestSpymaster.rate || (r === bestSpymaster.rate && p.spyGames > bestSpymaster.games)) {
        bestSpymaster = { id, rate: r, games: p.spyGames };
      }
    }
  }

  return { pd, cardsDist, avgCards, totalGames, totalAssassinHits, bestGuesser, bestSpymaster };
}

// ── Stats: clue-by-clue detail (games played through codenames.game) ───────
// Each detailed game stores every clue with who gave it and every guess with
// who made it and the card it hit. Seats nobody linked to Discord fall back
// to whoever the line-up had in that seat.
function computeDetailStats(history) {
  const dd = {};  // playerId -> clue/guess counters
  let detailedGames = 0, bestClue = null;
  let totalClues = 0, totalClueHits = 0, totalGuesses = 0, totalCorrect = 0;

  function ed(id) {
    if (!dd[id]) dd[id] = { clues: 0, clueNumberSum: 0, clueNumberCount: 0, clueHits: 0, clueGuesses: 0,
                           guesses: 0, correct: 0, opponent: 0, neutral: 0, assassin: 0 };
    return dd[id];
  }

  for (const game of history) {
    const detail = game.detail;
    if (!detail || !Array.isArray(detail.turns) || detail.turns.length === 0) continue;
    detailedGames++;
    for (const turn of detail.turns) {
      const team = turn.team;
      if (team !== 'blue' && team !== 'red') continue;
      const seats = game.grouping && game.grouping[team];
      const giver = turn.giver || (seats && seats.spymaster);
      const hits = (turn.guesses || []).filter(g => g.color === team).length;
      if (giver) {
        const s = ed(giver);
        s.clues++;
        const n = parseInt(turn.number, 10);
        if (Number.isFinite(n) && n > 0) { s.clueNumberSum += n; s.clueNumberCount++; }
        s.clueHits += hits;
        s.clueGuesses += (turn.guesses || []).length;
      }
      totalClues++;
      totalClueHits += hits;
      if (!bestClue || hits > bestClue.hits) {
        bestClue = { hits, word: turn.word, number: turn.number, giver, round: game.roundNumber, match: game.matchNumber };
      }
      for (const guess of turn.guesses || []) {
        const by = guess.by || (seats && seats.guesser);
        totalGuesses++;
        if (guess.color === team) totalCorrect++;
        if (!by) continue;
        const g = ed(by);
        g.guesses++;
        if (guess.color === team) g.correct++;
        else if (guess.color === 'black') g.assassin++;
        else if (guess.color === 'neutral') g.neutral++;
        else if (guess.color) g.opponent++;
      }
    }
  }

  const rows = Object.entries(dd).map(([id, d]) => ({
    id, name: displayName(id), ...d,
    avgClueSize: d.clueNumberCount > 0 ? d.clueNumberSum / d.clueNumberCount : null,
    hitsPerClue: d.clues > 0 ? d.clueHits / d.clues : null,
    clueAccuracy: d.clueGuesses > 0 ? d.clueHits / d.clueGuesses : null,
    guessAccuracy: d.guesses > 0 ? d.correct / d.guesses : null,
  }));

  const ACC_MIN_GUESSES = 10, CLUE_MIN = 5;
  const pick = (list, key) => list.reduce((best, r) => (!best || r[key] > best[key] ? r : best), null);
  const sharpest = pick(rows.filter(r => r.guesses >= ACC_MIN_GUESSES), 'guessAccuracy');
  const clueMachine = pick(rows.filter(r => r.clues >= CLUE_MIN), 'hitsPerClue');

  return {
    rows, detailedGames, totalGames: history.length,
    totalClues, totalClueHits, totalGuesses, totalCorrect,
    sharpest, clueMachine, bestClue: bestClue && bestClue.hits > 0 ? bestClue : null,
    ACC_MIN_GUESSES, CLUE_MIN,
  };
}

let lastDetailStats = null;
const detailTableSort = { col: 'guessAccuracy', asc: false };

function pct(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }
function dec(v) { return v == null ? '—' : v.toFixed(2); }

function renderDetailTrophies(ds) {
  const set = (id, icon, label, body) => {
    document.getElementById(id).innerHTML =
      `<div class="trophy-icon">${icon}</div><div class="trophy-label">${label}</div>` + body;
  };
  set('trophy-accuracy', '🔍', 'Sharpest Guesser', ds.sharpest
    ? `<div class="trophy-name">${esc(ds.sharpest.name)}</div>` +
      `<div class="trophy-rate">${pct(ds.sharpest.guessAccuracy)} of picks correct &middot; ${ds.sharpest.guesses} guesses</div>`
    : `<div class="trophy-empty">Need ${ds.ACC_MIN_GUESSES}+ tracked guesses</div>`);
  set('trophy-clues', '💡', 'Clue Machine', ds.clueMachine
    ? `<div class="trophy-name">${esc(ds.clueMachine.name)}</div>` +
      `<div class="trophy-rate">${dec(ds.clueMachine.hitsPerClue)} cards found per clue &middot; ${ds.clueMachine.clues} clues</div>`
    : `<div class="trophy-empty">Need ${ds.CLUE_MIN}+ tracked clues</div>`);
  const bc = ds.bestClue;
  set('trophy-best-clue', '🏅', 'Best Clue', bc
    ? `<div class="trophy-name">“${esc(bc.word)}” · ${esc(String(bc.number))}</div>` +
      `<div class="trophy-rate">${bc.hits} card${bc.hits !== 1 ? 's' : ''} found` +
      (bc.giver ? ` &middot; by ${esc(displayName(bc.giver))}` : '') + `</div>` +
      `<div class="trophy-sub">Round ${bc.round}, match ${bc.match}</div>`
    : '<div class="trophy-empty">No tracked clues yet</div>');
}

function renderDetailCards(ds) {
  if (ds.detailedGames === 0) return '';
  const avgHits = ds.totalClues > 0 ? (ds.totalClueHits / ds.totalClues).toFixed(2) : '—';
  const acc = ds.totalGuesses > 0 ? ((ds.totalCorrect / ds.totalGuesses) * 100).toFixed(1) + '%' : '—';
  return `
    <div class="stat-card">
      <div class="stat-card-label">Cards per Clue</div>
      <div class="stat-card-value">${avgHits}</div>
      <div class="stat-card-sub">${ds.totalClues} clue${ds.totalClues !== 1 ? 's' : ''} tracked</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Guess Accuracy</div>
      <div class="stat-card-value">${acc}</div>
      <div class="stat-card-sub">${ds.totalCorrect} of ${ds.totalGuesses} picks were the team's own cards</div>
    </div>`;
}

function renderDetailCharts(ds) {
  if (typeof Chart === 'undefined') return;
  const guessers = ds.rows.filter(r => r.guesses > 0).sort((a, b) => (b.guessAccuracy ?? 0) - (a.guessAccuracy ?? 0));
  setWrapHeight('wrap-guess-outcomes', guessers.length);
  document.getElementById('guess-outcomes-note').textContent =
    ds.detailedGames ? `(${ds.detailedGames} tracked game${ds.detailedGames !== 1 ? 's' : ''})` : '';
  const stack = (label, key, color) => ({
    label, data: guessers.map(r => r[key]),
    backgroundColor: color.bg, borderColor: color.bd, borderWidth: 1, borderRadius: 2,
  });
  mkChart('chart-guess-outcomes', {
    type: 'bar',
    data: {
      labels: guessers.map(r => r.name),
      datasets: [
        stack('Own team', 'correct', CHART_COLORS.green),
        stack('Other team', 'opponent', CHART_COLORS.purple),
        stack('Neutral', 'neutral', CHART_COLORS.amber),
        stack('Assassin', 'assassin', CHART_COLORS.red),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: {
        legend: { display: true, labels: LEGEND_LABELS },
        tooltip: { ...TOOLTIP_STYLE },
      },
      scales: {
        x: { ...AXIS_STYLE, stacked: true, ticks: { ...AXIS_STYLE.ticks, stepSize: 1 } },
        y: { ...AXIS_STYLE, stacked: true },
      },
    },
  });

  const spies = ds.rows.filter(r => r.clues > 0).sort((a, b) => (b.hitsPerClue ?? 0) - (a.hitsPerClue ?? 0));
  setWrapHeight('wrap-clue-hits', spies.length);
  mkChart('chart-clue-hits', {
    type: 'bar',
    data: {
      labels: spies.map(r => r.name),
      datasets: [
        {
          label: 'Cards found per clue', data: spies.map(r => +(r.hitsPerClue ?? 0).toFixed(2)),
          backgroundColor: CHART_COLORS.blue.bg, borderColor: CHART_COLORS.blue.bd, borderWidth: 1, borderRadius: 3,
        },
        {
          label: 'Average clue number', data: spies.map(r => +(r.avgClueSize ?? 0).toFixed(2)),
          backgroundColor: CHART_COLORS.purple.bg, borderColor: CHART_COLORS.purple.bd, borderWidth: 1, borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: {
        legend: { display: true, labels: LEGEND_LABELS },
        tooltip: { ...TOOLTIP_STYLE },
      },
      scales: { x: { ...AXIS_STYLE, min: 0 }, y: { ...AXIS_STYLE } },
    },
  });
}

function renderDetailTable(ds) {
  const { col, asc } = detailTableSort;
  const rows = ds.rows.slice().sort((a, b) => {
    const av = col === 'name' ? a.name.toLowerCase() : (a[col] ?? -1);
    const bv = col === 'name' ? b.name.toLowerCase() : (b[col] ?? -1);
    if (av < bv) return asc ? -1 : 1;
    if (av > bv) return asc ? 1 : -1;
    return 0;
  });
  document.getElementById('detail-coverage').textContent = ds.detailedGames
    ? `from ${ds.detailedGames} of ${ds.totalGames} games (the ones played through codenames.game)`
    : '';
  const tbody = document.getElementById('detail-table-body');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:1.5rem;color:var(--text-faint)">' +
      'Clue and guess stats appear for games played through the codenames.game bridge.</td></tr>';
  } else {
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="hl">${esc(r.name)}</td>
        <td class="num">${r.clues}</td>
        <td class="num">${dec(r.avgClueSize)}</td>
        <td class="num">${dec(r.hitsPerClue)}</td>
        <td class="num">${pct(r.clueAccuracy)}</td>
        <td class="num">${r.guesses}</td>
        <td class="num">${pct(r.guessAccuracy)}
          <span style="font-size:0.67rem;color:var(--text-faint)">(${r.correct}/${r.guesses})</span></td>
        <td class="num">${r.opponent}</td>
        <td class="num">${r.neutral}</td>
        <td class="num">${r.assassin}</td>
      </tr>`).join('');
  }
  document.querySelectorAll('#detail-table .sort-arrow').forEach(el => {
    const c = el.dataset.col;
    el.classList.toggle('on', c === col);
    el.textContent = (c === col) ? (asc ? '▲' : '▾') : '▾';
  });
}

function sortDetail(col) {
  if (detailTableSort.col === col) {
    detailTableSort.asc = !detailTableSort.asc;
  } else {
    detailTableSort.col = col;
    detailTableSort.asc = col === 'name';
  }
  if (lastDetailStats) renderDetailTable(lastDetailStats);
}

// ── Stats: chart management ───────────────────────────────────────────────
const _ch = {};

function mkChart(id, cfg) {
  if (_ch[id]) { _ch[id].destroy(); delete _ch[id]; }
  const canvas = document.getElementById(id);
  if (!canvas || typeof Chart === 'undefined') return;
  _ch[id] = new Chart(canvas, cfg);
}

const CHART_COLORS = {
  blue:   { bg: 'rgba(59,130,246,0.55)',   bd: 'rgba(59,130,246,0.8)' },
  purple: { bg: 'rgba(167,139,250,0.55)',  bd: 'rgba(167,139,250,0.8)' },
  green:  { bg: 'rgba(34,197,94,0.5)',     bd: 'rgba(34,197,94,0.75)' },
  red:    { bg: 'rgba(239,68,68,0.55)',    bd: 'rgba(239,68,68,0.8)' },
  amber:  { bg: 'rgba(245,158,11,0.5)',    bd: 'rgba(245,158,11,0.75)' },
};

// Chart styling follows the page theme (CSS variables), re-read on every render.
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let AXIS_STYLE = {};
let TOOLTIP_STYLE = {};
let LEGEND_LABELS = {};
function refreshChartTheme() {
  AXIS_STYLE = { grid: { color: cssVar('--chart-grid') }, ticks: { color: cssVar('--text-faint'), font: { size: 11 } } };
  TOOLTIP_STYLE = { backgroundColor: cssVar('--surface-raised'), borderColor: cssVar('--border'), borderWidth: 1, titleColor: cssVar('--text'), bodyColor: cssVar('--text-dim'), padding: 8 };
  LEGEND_LABELS = { color: cssVar('--text-dim'), font: { size: 11 }, boxWidth: 10, padding: 10 };
}

// ── Stats: render all ─────────────────────────────────────────────────────
function renderStats() {
  refreshChartTheme();
  if (!D || !D.started) {
    showStatsEmpty('Tournament has not started yet.');
    return;
  }

  buildRoundFilterChips();
  const history = getFilteredHistory();

  if (history.length === 0) {
    showStatsEmpty('No games in the selected rounds.');
    return;
  }

  const stats = computeStats(history);
  lastStats = stats;
  const detailStats = computeDetailStats(history);
  lastDetailStats = detailStats;

  renderTrophies(stats);
  renderDetailTrophies(detailStats);
  renderStatCards(stats);
  document.getElementById('stat-cards').insertAdjacentHTML('beforeend', renderDetailCards(detailStats));
  renderStatCharts(stats);
  renderDetailCharts(detailStats);
  renderStatsTable(stats);
  renderDetailTable(detailStats);
}

function showStatsEmpty(msg) {
  lastStats = null;
  lastDetailStats = null;
  buildRoundFilterChips();
  renderDetailTrophies(computeDetailStats([]));
  renderDetailTable(computeDetailStats([]));
  ['chart-winrate','chart-spy-vs-guesser','chart-cards','chart-assassin','chart-guess-outcomes','chart-clue-hits'].forEach(id => {
    if (_ch[id]) { _ch[id].destroy(); delete _ch[id]; }
  });
  document.getElementById('stat-cards').innerHTML = '';
  document.getElementById('trophy-guesser').innerHTML   = '<div class="trophy-icon">🎯</div><div class="trophy-label">Best Guesser</div><div class="trophy-empty">No data</div>';
  document.getElementById('trophy-spymaster').innerHTML = '<div class="trophy-icon">🕵️</div><div class="trophy-label">Best Spymaster</div><div class="trophy-empty">No data</div>';
  document.getElementById('stats-table-body').innerHTML = `<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:var(--text-faint)">${esc(msg)}</td></tr>`;
}

// ── Stats: trophies ───────────────────────────────────────────────────────
function renderTrophies({ bestGuesser, bestSpymaster }) {
  const tg = document.getElementById('trophy-guesser');
  if (bestGuesser) {
    tg.innerHTML =
      '<div class="trophy-icon">🎯</div>' +
      '<div class="trophy-label">Best Guesser</div>' +
      `<div class="trophy-name">${esc(displayName(bestGuesser.id))}</div>` +
      `<div class="trophy-rate">${(bestGuesser.rate * 100).toFixed(1)}% win rate &middot; ${bestGuesser.games} games</div>`;
  } else {
    tg.innerHTML = '<div class="trophy-icon">🎯</div><div class="trophy-label">Best Guesser</div><div class="trophy-empty">Need 3+ guesser games</div>';
  }

  const ts = document.getElementById('trophy-spymaster');
  if (bestSpymaster) {
    ts.innerHTML =
      '<div class="trophy-icon">🕵️</div>' +
      '<div class="trophy-label">Best Spymaster</div>' +
      `<div class="trophy-name">${esc(displayName(bestSpymaster.id))}</div>` +
      `<div class="trophy-rate">${(bestSpymaster.rate * 100).toFixed(1)}% win rate &middot; ${bestSpymaster.games} games</div>`;
  } else {
    ts.innerHTML = '<div class="trophy-icon">🕵️</div><div class="trophy-label">Best Spymaster</div><div class="trophy-empty">Need 3+ spymaster games</div>';
  }
}

// ── Stats: overview cards ─────────────────────────────────────────────────
function renderStatCards({ totalGames, totalAssassinHits, avgCards, pd }) {
  const activePlayers = Object.keys(pd).length;
  const assassinRate = totalGames > 0 ? ((totalAssassinHits / totalGames) * 100).toFixed(1) : '0';
  const avgCardsStr = avgCards != null ? avgCards.toFixed(2) : '—';

  let totalSpyWins = 0, totalSpyGames = 0, totalGuessWins = 0, totalGuessGames = 0;
  for (const p of Object.values(pd)) {
    totalSpyWins   += p.spyWins;   totalSpyGames   += p.spyGames;
    totalGuessWins += p.guessWins; totalGuessGames += p.guessGames;
  }
  const spyWinPct   = totalSpyGames   > 0 ? ((totalSpyWins   / totalSpyGames)   * 100).toFixed(1) : '—';
  const guessWinPct = totalGuessGames > 0 ? ((totalGuessWins / totalGuessGames) * 100).toFixed(1) : '—';

  document.getElementById('stat-cards').innerHTML = `
    <div class="stat-card">
      <div class="stat-card-label">Games Played</div>
      <div class="stat-card-value">${totalGames}</div>
      <div class="stat-card-sub">${activePlayers} active player${activePlayers !== 1 ? 's' : ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Avg Cards Remaining</div>
      <div class="stat-card-value">${avgCardsStr}</div>
      <div class="stat-card-sub">at game end (non-assassin)</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Assassin Hit Rate</div>
      <div class="stat-card-value">${assassinRate}%</div>
      <div class="stat-card-sub">${totalAssassinHits} of ${totalGames} game${totalGames !== 1 ? 's' : ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Spy Win Rate</div>
      <div class="stat-card-value">${spyWinPct}%</div>
      <div class="stat-card-sub">Guesser Win Rate: ${guessWinPct}%</div>
    </div>
  `;
}

// ── Stats: charts ─────────────────────────────────────────────────────────
function playerRows(pd) {
  return Object.entries(pd).map(([id, p]) => {
    const totalG = p.spyGames + p.guessGames;
    const totalW = p.spyWins  + p.guessWins;
    return {
      id, name: displayName(id),
      totalGames: totalG, totalWins: totalW,
      totalWinRate:  totalG > 0 ? totalW / totalG : 0,
      spyGames:  p.spyGames,   spyWins:  p.spyWins,
      spyWinRate:   p.spyGames   > 0 ? p.spyWins   / p.spyGames   : 0,
      guessGames: p.guessGames, guessWins: p.guessWins,
      guessWinRate: p.guessGames > 0 ? p.guessWins / p.guessGames : 0,
      assassinAsGuesser: p.assassinAsGuesser,
      teammateAssassinAsSpy: p.teammateAssassinAsSpy,
    };
  }).sort((a, b) => b.totalWinRate - a.totalWinRate);
}

function setWrapHeight(wrapId, playerCount) {
  const wrap = document.getElementById(wrapId);
  if (wrap) wrap.style.height = Math.max(200, playerCount * 26) + 'px';
}

function renderStatCharts({ pd, cardsDist }) {
  if (typeof Chart === 'undefined') {
    ['chart-winrate','chart-spy-vs-guesser','chart-cards','chart-assassin'].forEach(id => {
      const c = document.getElementById(id);
      if (c) c.parentElement.innerHTML = '<div style="padding:1rem;color:var(--text-faint);font-size:0.8rem">Chart.js failed to load. Check network.</div>';
    });
    return;
  }

  const rows = playerRows(pd);
  const names = rows.map(r => r.name);

  setWrapHeight('wrap-winrate', rows.length);
  setWrapHeight('wrap-spy-vs-guesser', rows.length);
  setWrapHeight('wrap-assassin', rows.length);

  // 1. Overall win rate — horizontal bar, sorted desc
  mkChart('chart-winrate', {
    type: 'bar',
    data: {
      labels: names,
      datasets: [{
        label: 'Win Rate %',
        data: rows.map(r => +(r.totalWinRate * 100).toFixed(1)),
        backgroundColor: rows.map(r => `rgba(59,130,246,${(0.3 + r.totalWinRate * 0.6).toFixed(2)})`),
        borderColor: 'rgba(59,130,246,0.75)',
        borderWidth: 1, borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: { ...TOOLTIP_STYLE, callbacks: { label: ctx => ' ' + ctx.parsed.x + '%' } },
      },
      scales: {
        x: { ...AXIS_STYLE, min: 0, max: 100, ticks: { ...AXIS_STYLE.ticks, callback: v => v + '%' } },
        y: { ...AXIS_STYLE },
      },
    },
  });

  // 2. Spy vs Guesser win rate — grouped horizontal bar
  mkChart('chart-spy-vs-guesser', {
    type: 'bar',
    data: {
      labels: names,
      datasets: [
        {
          label: 'Spy Win %',
          data: rows.map(r => +(r.spyWinRate * 100).toFixed(1)),
          backgroundColor: CHART_COLORS.purple.bg, borderColor: CHART_COLORS.purple.bd,
          borderWidth: 1, borderRadius: 3,
        },
        {
          label: 'Guesser Win %',
          data: rows.map(r => +(r.guessWinRate * 100).toFixed(1)),
          backgroundColor: CHART_COLORS.green.bg, borderColor: CHART_COLORS.green.bd,
          borderWidth: 1, borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: {
        legend: { display: true, labels: LEGEND_LABELS },
        tooltip: { ...TOOLTIP_STYLE, callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.x + '%' } },
      },
      scales: {
        x: { ...AXIS_STYLE, min: 0, max: 100, ticks: { ...AXIS_STYLE.ticks, callback: v => v + '%' } },
        y: { ...AXIS_STYLE },
      },
    },
  });

  // 3. Cards remaining distribution — vertical bar
  const maxCard = 8;
  const cardLabels = Array.from({ length: maxCard + 1 }, (_, i) => String(i));
  const cardData   = cardLabels.map((_, i) => cardsDist[i] || 0);
  mkChart('chart-cards', {
    type: 'bar',
    data: {
      labels: cardLabels.map((l, i) => i === 1 ? '1 card' : l + ' cards'),
      datasets: [{
        label: 'Games',
        data: cardData,
        backgroundColor: cardData.map((_, i) => `hsla(${195 + i * 13},65%,${46 + i * 2}%,0.6)`),
        borderColor:      cardData.map((_, i) => `hsla(${195 + i * 13},65%,${58 + i * 2}%,0.85)`),
        borderWidth: 1, borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...TOOLTIP_STYLE, callbacks: { label: ctx => ' ' + ctx.parsed.y + ' game' + (ctx.parsed.y !== 1 ? 's' : '') } },
      },
      scales: {
        x: { ...AXIS_STYLE },
        y: { ...AXIS_STYLE, ticks: { ...AXIS_STYLE.ticks, stepSize: 1 } },
      },
    },
  });

  // 4. Assassin hits — grouped horizontal bar
  mkChart('chart-assassin', {
    type: 'bar',
    data: {
      labels: names,
      datasets: [
        {
          label: 'Assassin hits (as Guesser)',
          data: rows.map(r => r.assassinAsGuesser),
          backgroundColor: CHART_COLORS.red.bg, borderColor: CHART_COLORS.red.bd,
          borderWidth: 1, borderRadius: 3,
        },
        {
          label: 'Teammate assassin (as Spy)',
          data: rows.map(r => r.teammateAssassinAsSpy),
          backgroundColor: CHART_COLORS.amber.bg, borderColor: CHART_COLORS.amber.bd,
          borderWidth: 1, borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: {
        legend: { display: true, labels: LEGEND_LABELS },
        tooltip: { ...TOOLTIP_STYLE },
      },
      scales: {
        x: { ...AXIS_STYLE, ticks: { ...AXIS_STYLE.ticks, stepSize: 1 } },
        y: { ...AXIS_STYLE },
      },
    },
  });
}

// ── Stats: table ──────────────────────────────────────────────────────────
function renderStatsTable({ pd }) {
  const minGames = parseInt(document.getElementById('filter-min-games')?.value || '1', 10);
  const { col, asc } = statsTableSort;

  let rows = playerRows(pd).filter(r => r.totalGames >= minGames);

  rows.sort((a, b) => {
    const av = col === 'name' ? a.name.toLowerCase() : (a[col] ?? 0);
    const bv = col === 'name' ? b.name.toLowerCase() : (b[col] ?? 0);
    if (av < bv) return asc ? -1 :  1;
    if (av > bv) return asc ?  1 : -1;
    return 0;
  });

  const tbody = document.getElementById('stats-table-body');
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:var(--text-faint)">No players with ${minGames}+ games in selected rounds.</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="hl">${esc(r.name)}</td>
        <td class="num">${(r.totalWinRate * 100).toFixed(1)}%</td>
        <td class="num">${r.spyGames   > 0 ? (r.spyWinRate   * 100).toFixed(1) + '%' : '—'}
          <span style="font-size:0.67rem;color:var(--text-faint)">(${r.spyWins}/${r.spyGames})</span></td>
        <td class="num">${r.guessGames > 0 ? (r.guessWinRate * 100).toFixed(1) + '%' : '—'}
          <span style="font-size:0.67rem;color:var(--text-faint)">(${r.guessWins}/${r.guessGames})</span></td>
        <td class="num">${r.totalGames}</td>
        <td class="num">${r.assassinAsGuesser}</td>
        <td class="num">${r.teammateAssassinAsSpy}</td>
      </tr>
    `).join('');
  }

  document.querySelectorAll('#stats-table .sort-arrow').forEach(el => {
    const c = el.dataset.col;
    el.classList.toggle('on', c === col);
    el.textContent = (c === col) ? (asc ? '▲' : '▾') : '▾';
  });
}

function sortStats(col) {
  if (statsTableSort.col === col) {
    statsTableSort.asc = !statsTableSort.asc;
  } else {
    statsTableSort.col = col;
    statsTableSort.asc = col === 'name';
  }
  if (lastStats) renderStatsTable(lastStats);
}

