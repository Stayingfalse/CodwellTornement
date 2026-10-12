// Tournament dashboard. Data comes from /api (public) and /auth/me; admin
// actions POST to /api/admin/<action>. stats.js renders the Stats tab.

// ── State ──────────────────────────────────────────────────────────────────
let D = null;               // tournament data from /api
let currentUser = null;     // from /auth/me
let currentTab = 'tournament';
let lastFetchedAt = 0;
const openRounds = new Set(); // round numbers the viewer expanded (current round is open by default)
const closedRounds = new Set(); // round numbers the viewer collapsed
const REFRESH_MS = 60 * 1000;

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function displayName(id) {
  return (D && D.playerNames && D.playerNames[id]) ? D.playerNames[id] : id;
}

const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;

function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return withTime ? `${date}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : date;
}

function fmtDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function swapRoles(team) { return { spymaster: team.guesser, guesser: team.spymaster }; }

// Legacy matches store one grouping plus phases (2 = both swap, 3 = blue swaps, 4 = red swaps).
function groupingForPhase(g, phase) {
  if (phase === 2) return { blue: swapRoles(g.blue), red: swapRoles(g.red) };
  if (phase === 3) return { blue: swapRoles(g.blue), red: g.red };
  if (phase === 4) return { blue: g.blue, red: swapRoles(g.red) };
  return g;
}

// Every game's line-up for a round entry or active match.
function matchGames(match) {
  if (match && Array.isArray(match.games) && match.games.length) return match.games;
  const legacy = match && match.grouping ? match : { grouping: match };
  const phases = Array.isArray(legacy.phaseSequence) && legacy.phaseSequence.length
    ? legacy.phaseSequence
    : Array.from({ length: Math.min(4, Math.max(2, parseInt(legacy.gamesPlanned, 10) || 2)) }, (_, i) => i + 1);
  return phases.map(p => groupingForPhase(legacy.grouping, p));
}

function matchPlayers(match) {
  const g = matchGames(match)[0];
  return [g.blue.spymaster, g.blue.guesser, g.red.spymaster, g.red.guesser];
}

const teamKey = t => [t.spymaster, t.guesser].sort().join('+');
const splitKey = g => [teamKey(g.blue), teamKey(g.red)].sort().join('|');

function historyEntry(roundNumber, matchNumber, game) {
  return D.history.find(h => h.roundNumber === roundNumber && h.matchNumber === matchNumber && h.game === game) || null;
}

function activeMatch(matchNumber) {
  return D.activeMatches.find(m => m.matchNumber === matchNumber) || null;
}

const isAdmin = () => !!(currentUser && currentUser.isAdmin);
const myId = () => (currentUser && currentUser.loggedIn ? currentUser.userId : null);

// ── Header & status strip ──────────────────────────────────────────────────
function renderBrandSub() {
  const el = document.getElementById('brand-sub');
  if (!D) { el.textContent = 'Loading…'; return; }
  if (!D.started) { el.textContent = 'Not started yet'; return; }
  const done = D.currentRound > D.totalRounds;
  const parts = [done ? 'Complete' : `Round ${D.currentRound} of ${D.totalRounds}`];
  if (D.tournamentStartedAt) parts.push(`started ${fmtDate(D.tournamentStartedAt)}`);
  el.textContent = parts.join(' · ');
}

function renderStatusStrip() {
  const el = document.getElementById('status-strip');
  if (!D || !D.started) {
    el.innerHTML = D ? `<div class="stat"><span class="stat-label">Status</span><span class="stat-value">Waiting to start</span><span class="stat-sub">${plural((D.scores || []).length, 'player')} signed up</span></div>` : '';
    return;
  }
  const plannedGames = D.rounds.reduce((sum, round) => sum + round.reduce((s, m) => s + matchGames(m).length, 0), 0);
  const played = D.history.length;
  const pct = plannedGames ? Math.min(100, (played / plannedGames) * 100) : 0;
  const done = D.currentRound > D.totalRounds;
  const left = D.leftPlayers ? Object.keys(D.leftPlayers).length : 0;

  const stats = [];
  stats.push(`<div class="stat stat-wide">
      <span class="stat-label">Progress</span>
      <span class="stat-value">${played} <small>/ ${plannedGames} games</small></span>
      <span class="bar"><span style="width:${pct.toFixed(1)}%"></span></span>
    </div>`);
  stats.push(`<div class="stat"><span class="stat-label">Round</span><span class="stat-value">${done ? '🏆 Done' : `${D.currentRound} <small>/ ${D.totalRounds}</small>`}</span><span class="stat-sub">${D.roundStartedAt && !done ? `began ${fmtDate(D.roundStartedAt)}` : '&nbsp;'}</span></div>`);
  if (D.roundDeadline && !done) {
    const ms = D.roundDeadline - Date.now();
    const cls = ms < 0 ? 'is-bad' : ms < 2 * 864e5 ? 'is-warn' : '';
    stats.push(`<div class="stat ${cls}"><span class="stat-label">Round deadline</span><span class="stat-value">${ms < 0 ? 'Passed' : fmtDuration(ms)}</span><span class="stat-sub">${fmtDate(new Date(D.roundDeadline).toISOString(), true)}</span></div>`);
  }
  stats.push(`<div class="stat"><span class="stat-label">Players</span><span class="stat-value">${D.scores.length}</span><span class="stat-sub">${left ? `${left} left` : '&nbsp;'}</span></div>`);
  if (D.signupsReopened) stats.push('<div class="stat is-info"><span class="stat-label">Signups</span><span class="stat-value">Open</span><span class="stat-sub">rounds paused</span></div>');
  if (D.pendingRemoval) stats.push('<div class="stat is-warn"><span class="stat-label">Leave request</span><span class="stat-value">Pending</span><span class="stat-sub">rounds paused</span></div>');
  el.innerHTML = stats.join('');
}

// ── Standings ──────────────────────────────────────────────────────────────
function renderScoreboard() {
  const el = document.getElementById('scoreboard');
  if (!D || !D.started || D.scores.length === 0) {
    el.innerHTML = '<li class="empty-row">No scores yet</li>';
    return;
  }
  const me = myId();
  const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
  let rank = 0;
  let lastPts = null;
  let html = D.scores.map(([id, pts], i) => {
    if (pts !== lastPts) { rank = i + 1; lastPts = pts; }
    const games = (D.gamesPlayed && D.gamesPlayed[id]) || 0;
    const avg = games ? (pts / games).toFixed(2) : '—';
    const ptsCell = isAdmin()
      ? `<button class="pts editable" data-userid="${esc(id)}" data-pts="${pts}" title="Edit score">${pts}</button>`
      : `<span class="pts">${pts}</span>`;
    return `<li class="standing${id === me ? ' is-me' : ''}">
        <span class="rank">${(pts > 0 && medals[rank]) || rank}</span>
        <span class="name" title="${esc(displayName(id))}">${esc(displayName(id))}</span>
        ${ptsCell}<span class="games">${games}</span><span class="avg">${avg}</span>
      </li>`;
  }).join('');

  const leftEntries = D.leftPlayers ? Object.entries(D.leftPlayers) : [];
  if (leftEntries.length) {
    html += '<li class="standings-divider">Left the tournament</li>';
    html += leftEntries.map(([id, info]) => {
      const games = (D.gamesPlayed && D.gamesPlayed[id]) || 0;
      return `<li class="standing is-left">
          <span class="rank">—</span><span class="name">${esc(info.displayName || displayName(id))}</span>
          <span class="pts">${info.score || 0}</span><span class="games">${games}</span><span class="avg">${games ? ((info.score || 0) / games).toFixed(2) : '—'}</span>
        </li>`;
    }).join('');
  }
  el.innerHTML = html;
  el.querySelectorAll('.pts.editable').forEach(btn => btn.addEventListener('click', () => startScoreEdit(btn)));
}

function startScoreEdit(trigger) {
  if (trigger.querySelector('input')) return;
  const userId = trigger.dataset.userid;
  const current = parseInt(trigger.dataset.pts, 10);
  let done = false;
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'pts-input';
  input.value = current;
  const finish = save => {
    if (done) return;
    done = true;
    const next = parseInt(input.value, 10);
    if (!save || isNaN(next) || next === current) { trigger.textContent = current; return; }
    trigger.textContent = '…';
    adminAction('adjust-score', { userId, delta: next - current });
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
  trigger.textContent = '';
  trigger.appendChild(input);
  input.select();
}

// ── Matches ────────────────────────────────────────────────────────────────
function playerHtml(id, role) {
  const me = myId();
  return `<span class="p${id === me ? ' is-me' : ''}${role === 'spy' ? ' spy' : ''}" title="${esc(displayName(id))}${role === 'spy' ? ' (spymaster)' : ' (guesser)'}">${esc(displayName(id))}</span>`;
}

function teamHtml(team, color) {
  return `<span class="team team-${color}">${playerHtml(team.spymaster, 'spy')}<span class="amp">&amp;</span>${playerHtml(team.guesser, 'guess')}</span>`;
}

function resultHtml(result, { active, gameIndex, isPast, adminMeta }) {
  if (result) {
    const blue = result.winner === 'blue';
    const how = result.assassin ? 'assassin' : (result.remainingCards != null ? `${result.remainingCards} left` : '');
    const pts = `+${result.winPoints}/${result.losePoints > 0 ? '+' : ''}${result.losePoints}`;
    const label = `${blue ? 'Blue' : 'Red'} won`;
    const body = `<b>${label}</b><small>${how ? how + ' · ' : ''}${pts}</small>`;
    if (adminMeta) {
      return `<button class="result ${blue ? 'r-blue' : 'r-red'} editable" onclick="openResultEdit(this)"
        data-round="${adminMeta.roundNumber}" data-match="${adminMeta.matchNumber}" data-game="${adminMeta.game}"
        data-winner="${esc(result.winner)}" data-assassin="${result.assassin ? 1 : 0}" data-remaining="${result.remainingCards ?? 0}"
        title="Change this result" aria-label="${label}, change this result">${body}</button>`;
    }
    return `<span class="result ${blue ? 'r-blue' : 'r-red'}">${body}</span>`;
  }
  const phase = active ? (active.gamePhase ?? 1) : null;
  if (active && phase === gameIndex) return '<span class="result r-active"><b>In progress</b></span>';
  if (active && gameIndex > phase) return '<span class="result r-waiting">Waiting</span>';
  if (isPast) return '<span class="result r-skipped">Skipped</span>';
  return '<span class="result r-pending">Upcoming</span>';
}

function liveStatusHtml(matchNumber) {
  const st = D.matchStatus && D.matchStatus[matchNumber];
  if (!st) return '';
  const parts = [];
  const live = st.live;
  const name = p => (p.id && D.playerNames && D.playerNames[p.id]) || p.name || 'someone';
  if (live) {
    const team = live.activeTeam === 'red' ? '🔴 Red' : live.activeTeam === 'blue' ? '🔵 Blue' : '';
    switch (live.state) {
      case 'no_room': parts.push('<span>📎 No room posted yet</span>'); break;
      case 'lobby': parts.push(`<span>🛋️ Room ready · game ${st.game} not started</span>`); break;
      case 'finished': parts.push(`<span>🏁 Game over in the room · game ${st.game} not started</span>`); break;
      case 'unreachable': parts.push('<span>⚠️ Live status unavailable</span>'); break;
      case 'unbound': parts.push('<span>⏳ Connecting to the room…</span>'); break;
      case 'in_progress': {
        const who = esc((live.waitingOn || []).map(name).join(' & ') || team);
        parts.push(live.activeRole === 'spymasters'
          ? `<span class="live">${team} spymaster ${who} to give a clue</span>`
          : `<span class="live">${team} guessing${live.clue ? ` “${esc(live.clue.word)}” ${esc(live.clue.number)}` : ''} · ${who}</span>`);
        if (live.turnStartedAt) {
          const waited = Date.now() - new Date(live.turnStartedAt).getTime();
          const cls = waited > 72 * 36e5 ? 'is-bad' : waited > 24 * 36e5 ? 'is-warn' : '';
          parts.push(`<span class="${cls}" title="Time since this turn started">⏱ ${fmtDuration(waited)}</span>`);
        }
        if (live.remaining) parts.push(`<span title="Agents left to find">🔴 ${live.remaining.red} · 🔵 ${live.remaining.blue} left</span>`);
        break;
      }
    }
  }
  if (st.pendingConfirmations > 0) parts.push('<span class="is-warn">✋ Result waiting for confirmation</span>');
  return parts.length ? `<div class="live-status">${parts.join('')}</div>` : '';
}

function matchCardHtml(roundNumber, matchNumber, entry, { isCurrent, isPast }) {
  const active = isCurrent ? activeMatch(matchNumber) : null;
  const games = matchGames(active || entry);
  const players = matchPlayers(active || entry);
  const phaseResults = (active && active.phaseResults) || {};
  const status = D.matchStatus && D.matchStatus[matchNumber];
  const me = myId();
  const mine = me && players.includes(me);

  let playedCount = 0;
  const rows = games.map((g, i) => {
    const gameIndex = i + 1;
    const hist = (isCurrent || isPast) ? historyEntry(roundNumber, matchNumber, gameIndex) : null;
    const result = hist || phaseResults[gameIndex] || (gameIndex === 1 && active ? active.game1Result : null) || null;
    if (result) playedCount++;
    const adminMeta = isAdmin() && result ? { roundNumber, matchNumber, game: gameIndex } : null;
    const note = i === 0 ? '' : splitKey(games[i - 1]) === splitKey(g) ? 'roles swapped' : 'new teams';
    const isNow = active && (active.gamePhase ?? 1) === gameIndex;
    return `<li class="game${isNow ? ' is-now' : ''}${result ? ' is-done' : ''}">
        <span class="g-num" title="${note}">G${gameIndex}</span>
        <span class="g-teams">${teamHtml(g.blue, 'blue')}<span class="vs">vs</span>${teamHtml(g.red, 'red')}</span>
        ${resultHtml(result, { active, gameIndex, isPast, adminMeta })}
      </li>`;
  }).join('');

  let badge = '';
  if (active) badge = `<span class="pill pill-amber">Game ${active.gamePhase ?? 1} of ${games.length}</span>`;
  else if (isCurrent || isPast) badge = playedCount === games.length ? '<span class="pill pill-green">Done</span>' : `<span class="pill">${playedCount}/${games.length}</span>`;
  else badge = `<span class="pill">${plural(games.length, 'game')}</span>`;
  const thread = active && status && status.threadUrl
    ? `<a class="thread-link" href="${esc(status.threadUrl)}" target="_blank" rel="noopener">Open thread ↗</a>` : '';

  return `<article class="match${active ? ' is-active' : ''}${mine ? ' is-mine' : ''}">
      <header class="match-head">
        <h3>Match ${matchNumber}</h3>${badge}${mine ? '<span class="pill pill-me">You</span>' : ''}${thread}
      </header>
      ${active ? liveStatusHtml(matchNumber) : ''}
      <ol class="games">${rows}</ol>
    </article>`;
}

function roundSummaryCounts(roundNumber, roundMatches) {
  const planned = roundMatches.reduce((s, m) => s + matchGames(m).length, 0);
  let played = D.history.filter(h => h.roundNumber === roundNumber).length;
  if (roundNumber === D.currentRound) {
    for (const m of D.activeMatches) played += Object.keys(m.phaseResults || {}).length;
  }
  return { planned, played };
}

function renderCurrentRound() {
  const el = document.getElementById('current-round');
  if (!D) { el.innerHTML = '<div class="empty"><p>Loading…</p></div>'; return; }
  if (!D.started || D.rounds.length === 0) {
    el.innerHTML = `<div class="empty"><span aria-hidden="true">🕵️</span><h2>Not started yet</h2><p>${plural(D.scores.length, 'player')} signed up. Sign up with the button in Discord.</p></div>`;
    return;
  }
  if (D.currentRound > D.totalRounds) {
    const top = D.scores[0];
    el.innerHTML = `<div class="empty"><span aria-hidden="true">🏆</span><h2>Tournament complete</h2><p>${top ? `${esc(displayName(top[0]))} finished top with ${top[1]} points.` : ''}</p></div>`;
    return;
  }
  const n = D.currentRound;
  const roundMatches = D.rounds[n - 1] || [];
  const { planned, played } = roundSummaryCounts(n, roundMatches);
  const forceEnd = isAdmin() && D.activeMatches.length
    ? '<button class="btn btn-sm btn-warn" onclick="confirmForceEnd()">Force end round</button>' : '';
  const waiting = D.activeMatches.length === 0
    ? '<p class="muted">Waiting for this round to be allocated.</p>' : '';
  el.innerHTML = `<div class="section-head">
      <h2>Round ${n} <small>${played}/${planned} games</small></h2>
      <div class="section-actions">${forceEnd}</div>
    </div>
    ${waiting}
    <div class="match-grid">${roundMatches.map((m, i) => matchCardHtml(n, i + 1, m, { isCurrent: true, isPast: false })).join('')}</div>`;
}

function roundRowHtml(roundNumber) {
  const roundMatches = D.rounds[roundNumber - 1];
  const isPast = roundNumber < D.currentRound;
  const { planned, played } = roundSummaryCounts(roundNumber, roundMatches);
  const me = myId();
  const mine = me && roundMatches.some(m => matchPlayers(m).includes(me));
  const open = openRounds.has(roundNumber) && !closedRounds.has(roundNumber);
  const pct = planned ? (played / planned) * 100 : 0;
  return `<details class="round${isPast ? ' is-past' : ' is-future'}" data-round="${roundNumber}"${open ? ' open' : ''}>
      <summary>
        <span class="round-name">Round ${roundNumber}</span>
        ${isPast ? '<span class="pill pill-green">Done</span>' : '<span class="pill">Upcoming</span>'}
        ${mine ? '<span class="pill pill-me">You</span>' : ''}
        <span class="bar bar-sm"><span style="width:${pct.toFixed(1)}%"></span></span>
        <span class="round-count">${isPast ? `${played}/${planned}` : plural(roundMatches.length, 'match', 'matches')}</span>
      </summary>
      <div class="match-grid">${open ? roundMatches.map((m, i) => matchCardHtml(roundNumber, i + 1, m, { isCurrent: false, isPast })).join('') : ''}</div>
    </details>`;
}

const GROUP_PREVIEW = 5;
const expandedGroups = new Set();
function expandGroup(id) { expandedGroups.add(id); renderRounds(); }

function renderRounds() {
  const el = document.getElementById('rounds-list');
  if (!D || !D.started || D.rounds.length === 0) { el.innerHTML = ''; return; }
  const past = [];
  const future = [];
  for (let r = 1; r <= D.rounds.length; r++) {
    if (r < D.currentRound) past.push(r);
    else if (r > D.currentRound) future.push(r);
  }
  // Long lists show the nearest few rounds until the viewer asks for the rest.
  const group = (title, rounds, id, actions = '') => {
    if (!rounds.length) return '';
    const expanded = expandedGroups.has(id) || rounds.length <= GROUP_PREVIEW + 2;
    const shown = expanded ? rounds : rounds.slice(0, GROUP_PREVIEW);
    const more = expanded ? '' : `<button class="btn btn-sm show-more" onclick="expandGroup('${id}')">Show ${rounds.length - shown.length} more</button>`;
    return `<div class="round-group" id="${id}"><h2 class="group-title">${title} <small>${rounds.length}</small>${actions}</h2>${shown.map(roundRowHtml).join('')}${more}</div>`;
  };
  const shuffle = isAdmin() && future.length > 1
    ? '<button class="btn btn-sm" onclick="confirmShuffle()">Shuffle upcoming</button>' : '';
  el.innerHTML = group('Upcoming', future, 'rounds-upcoming', shuffle) + group('Completed', past.reverse(), 'rounds-past');
  el.querySelectorAll('details.round').forEach(d => d.addEventListener('toggle', () => {
    const n = Number(d.dataset.round);
    if (d.open) {
      openRounds.add(n); closedRounds.delete(n);
      const grid = d.querySelector('.match-grid');
      if (!grid.innerHTML) {
        grid.innerHTML = D.rounds[n - 1].map((m, i) => matchCardHtml(n, i + 1, m, { isCurrent: false, isPast: n < D.currentRound })).join('');
      }
    } else {
      openRounds.delete(n); closedRounds.add(n);
    }
  }));
}

// ── Rendering & data ───────────────────────────────────────────────────────
function renderAll() {
  renderBrandSub();
  renderStatusStrip();
  renderAdminPanel();
  renderCurrentRound();
  renderRounds();
  renderScoreboard();
  if (currentTab === 'stats' && typeof renderStats === 'function') renderStats();
}

let fetching = false;
async function fetchData() {
  if (fetching) return;
  fetching = true;
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('is-spinning');
  try {
    const res = await fetch('/api', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    D = await res.json();
    lastFetchedAt = Date.now();
    btn.title = 'Refresh (updated just now)';
    btn.classList.remove('is-error');
    // Don't redraw under someone editing a score.
    if (!document.querySelector('.pts-input')) renderAll();
  } catch {
    btn.classList.add('is-error');
    btn.title = 'Could not refresh — click to retry';
  } finally {
    fetching = false;
    btn.classList.remove('is-spinning');
  }
}

// Refresh every minute while the tab is visible, and on return to the tab.
setInterval(() => { if (document.visibilityState === 'visible') fetchData(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastFetchedAt > REFRESH_MS / 2) fetchData();
});
setInterval(() => {
  const btn = document.getElementById('refresh-btn');
  if (lastFetchedAt && !btn.classList.contains('is-error')) btn.title = `Refresh (updated ${fmtDuration(Date.now() - lastFetchedAt)} ago)`;
}, 15000);

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('view-tournament').hidden = tab !== 'tournament';
  document.getElementById('view-stats').hidden = tab !== 'stats';
  for (const t of ['tournament', 'stats']) {
    const b = document.getElementById(`tab-btn-${t}`);
    b.classList.toggle('active', t === tab);
    b.setAttribute('aria-selected', String(t === tab));
  }
  if (tab === 'stats' && D && typeof renderStats === 'function') renderStats();
}

const isDarkTheme = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

function renderThemeButton() {
  const btn = document.getElementById('theme-btn');
  btn.textContent = isDarkTheme() ? '☀' : '☾';
  btn.title = btn.ariaLabel = isDarkTheme() ? 'Switch to light theme' : 'Switch to dark theme';
}

function toggleTheme() {
  const root = document.documentElement;
  root.dataset.theme = isDarkTheme() ? 'light' : 'dark';
  renderThemeButton();
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
  if (currentTab === 'stats' && D && typeof renderStats === 'function') renderStats();
}

// ── Dialogs ────────────────────────────────────────────────────────────────
function openDialog(id) { const d = document.getElementById(id); if (!d.open) d.showModal(); }
function closeDialog(id) { const d = document.getElementById(id); if (d.open) d.close(); }
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

// Confirm dialog. With `typeToConfirm`, the button stays disabled until that word is typed.
function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, typeToConfirm = null }) {
  return new Promise(resolve => {
    const dlg = document.getElementById('confirm-modal');
    const ok = document.getElementById('confirm-ok');
    const typeWrap = document.getElementById('confirm-type-wrap');
    const typeInput = document.getElementById('confirm-type');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').innerHTML = body;
    ok.textContent = confirmLabel;
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    typeWrap.hidden = !typeToConfirm;
    typeInput.value = '';
    ok.disabled = !!typeToConfirm;
    if (typeToConfirm) {
      document.getElementById('confirm-type-label').textContent = `Type ${typeToConfirm} to confirm`;
      typeInput.oninput = () => { ok.disabled = typeInput.value.trim().toUpperCase() !== typeToConfirm; };
    }
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.returnValue = '';
    dlg.showModal();
    (typeToConfirm ? typeInput : ok).focus();
  });
}

// ── Auth ───────────────────────────────────────────────────────────────────
async function fetchMe() {
  try {
    const res = await fetch('/auth/me', { cache: 'no-store' });
    if (!res.ok) return;
    currentUser = await res.json();
    renderAuth();
    if (D) renderAll();
  } catch { /* stay logged out */ }
}

function renderAuth() {
  const area = document.getElementById('auth-area');
  area.innerHTML = '';
  if (!currentUser) return;
  if (!currentUser.loggedIn) {
    if (currentUser.oauthEnabled) area.innerHTML = '<a href="/auth/discord" class="btn btn-sm btn-discord">Log in</a>';
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'user';
  if (currentUser.avatar) {
    const img = document.createElement('img');
    img.src = `https://cdn.discordapp.com/avatars/${encodeURIComponent(currentUser.userId)}/${encodeURIComponent(currentUser.avatar)}.png?size=32`;
    img.alt = '';
    wrap.appendChild(img);
  }
  const name = document.createElement('span');
  name.className = 'user-name';
  name.textContent = currentUser.globalName || currentUser.username;
  wrap.appendChild(name);
  if (currentUser.isAdmin) {
    const badge = document.createElement('span');
    badge.className = 'pill pill-purple';
    badge.textContent = 'Admin';
    wrap.appendChild(badge);
  }
  const out = document.createElement('button');
  out.className = 'btn btn-sm';
  out.textContent = 'Log out';
  out.addEventListener('click', logout);
  wrap.appendChild(out);
  area.appendChild(wrap);
}

async function logout() {
  try { await fetch('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  currentUser = { loggedIn: false, oauthEnabled: true };
  renderAuth();
  if (D) renderAll();
}

// ── Admin ──────────────────────────────────────────────────────────────────
let feedbackTimer = null;
function setAdminFeedback(msg, isError) {
  const el = document.getElementById('admin-feedback');
  el.textContent = msg;
  el.className = `admin-feedback ${isError ? 'is-bad' : 'is-good'}`;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { el.textContent = ''; }, 10000);
}

function renderAdminPanel() {
  const panel = document.getElementById('admin-panel');
  if (!isAdmin()) { panel.hidden = true; return; }
  panel.hidden = false;
  const started = D && D.started;
  const hasActive = D && D.activeMatches.length > 0;
  const allDone = D && D.currentRound > D.totalRounds;
  const paused = D && (D.pendingRemoval || D.signupsReopened);
  const btns = [];
  if (!started) btns.push('<button class="btn btn-primary" onclick="adminAction(\'start\')">Start tournament</button>');
  if (started && !hasActive && !allDone && !paused) btns.push('<button class="btn btn-primary" onclick="adminAction(\'allocate\')">Allocate round</button>');
  if (started && !D.signupsReopened) btns.push('<button class="btn" onclick="adminAction(\'reopen-signups\')">Reopen signups</button>');
  if (started && D.signupsReopened) btns.push('<button class="btn btn-warn" onclick="confirmCloseSignups()">Close signups</button>');
  if (started) btns.push('<button class="btn" onclick="confirmRecalculateRounds()">Fix matchups</button>');
  btns.push('<button class="btn btn-danger-ghost" onclick="confirmReset()">Reset…</button>');
  let note = '';
  if (D && D.pendingRemoval) note = '<p class="note is-warn">A leave request is waiting for confirmation. New rounds are paused until it resolves.</p>';
  if (D && D.signupsReopened) note += '<p class="note is-info">Signups are open. New rounds are paused until they close.</p>';
  document.getElementById('admin-actions').innerHTML = btns.join('') + note;
}

async function adminAction(action, body) {
  try {
    const opts = { method: 'POST' };
    if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    const res = await fetch(`/api/admin/${action}`, opts);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) setAdminFeedback('✓ ' + (data.message || 'Done'), false);
    else setAdminFeedback('✗ ' + (data.error || data.message || `Error ${res.status}`), true);
  } catch {
    setAdminFeedback('✗ Network error — try again', true);
  }
  fetchData();
}

async function confirmCloseSignups() {
  if (await confirmDialog({ title: 'Close signups?', body: '<p>Everyone signed up now is included, and future rounds are recalculated.</p>', confirmLabel: 'Close signups' })) adminAction('close-signups');
}

async function confirmRecalculateRounds() {
  if (await confirmDialog({
    title: 'Fix matchups?',
    body: '<p>Rebuilds every future round with the 6-game format for the current players.</p><p>The current round is left alone and counted as if it finishes as scheduled. Games already played are kept, so some groups get shorter matches.</p>',
    confirmLabel: 'Recalculate',
  })) adminAction('recalculate-rounds');
}

async function confirmForceEnd() {
  if (await confirmDialog({
    title: `Force end round ${D.currentRound}?`,
    body: '<p>Games already logged are kept. Unplayed games score nothing, threads are archived and the next round starts.</p>',
    confirmLabel: 'Force end', danger: true,
  })) adminAction('force-end');
}

async function confirmShuffle() {
  if (await confirmDialog({ title: 'Shuffle upcoming rounds?', body: '<p>Randomly reorders the rounds that haven\'t started. Match-ups stay the same.</p>', confirmLabel: 'Shuffle' })) adminAction('shuffle-rounds');
}

async function confirmReset() {
  if (await confirmDialog({
    title: 'Reset the tournament?',
    body: '<p>This deletes <b>every player, round, score and result</b>. It can\'t be undone.</p>',
    confirmLabel: 'Reset everything', danger: true, typeToConfirm: 'RESET',
  })) adminAction('reset');
}

// ── Result override (admin) ────────────────────────────────────────────────
let resultEditState = null;

function openResultEdit(el) {
  resultEditState = {
    roundNumber: parseInt(el.dataset.round, 10),
    matchNumber: parseInt(el.dataset.match, 10),
    game: parseInt(el.dataset.game, 10),
    winner: el.dataset.winner,
  };
  const assassin = el.dataset.assassin === '1';
  document.getElementById('result-edit-desc').textContent =
    `Round ${resultEditState.roundNumber} · Match ${resultEditState.matchNumber} · Game ${resultEditState.game}`;
  document.getElementById('re-assassin').checked = assassin;
  const rem = document.getElementById('re-remaining');
  rem.value = assassin ? '' : (parseInt(el.dataset.remaining, 10) || 0);
  rem.disabled = assassin;
  document.getElementById('result-edit-feedback').textContent = '';
  document.getElementById('re-adjust-score').checked = true;
  setResultEditWinner(resultEditState.winner);
  openDialog('result-edit-modal');
}

function closeResultEdit() { closeDialog('result-edit-modal'); resultEditState = null; }

function setResultEditWinner(w) {
  if (resultEditState) resultEditState.winner = w;
  document.getElementById('re-blue-btn').classList.toggle('selected', w === 'blue');
  document.getElementById('re-red-btn').classList.toggle('selected', w === 'red');
}

function toggleAssassinEdit(checked) {
  const rem = document.getElementById('re-remaining');
  rem.disabled = checked;
  if (checked) rem.value = '';
}

function resultFeedback(msg, isError) {
  const fb = document.getElementById('result-edit-feedback');
  fb.textContent = msg;
  fb.className = `feedback ${isError ? 'is-bad' : ''}`;
}

async function postResult(path, payload, okMsg) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      closeResultEdit();
      setAdminFeedback('✓ ' + (data.message || okMsg), false);
      fetchData();
    } else {
      resultFeedback('✗ ' + (data.error || `Error ${res.status}`), true);
    }
  } catch {
    resultFeedback('✗ Network error — try again', true);
  }
}

function submitResultEdit() {
  if (!resultEditState || !resultEditState.winner) return resultFeedback('✗ Pick a winner first.', true);
  const assassin = document.getElementById('re-assassin').checked;
  const remaining = assassin ? 0 : parseInt(document.getElementById('re-remaining').value, 10);
  if (!assassin && (isNaN(remaining) || remaining < 0 || remaining > 8)) return resultFeedback('✗ Cards left must be 0–8.', true);
  resultFeedback('Saving…');
  postResult('/api/admin/override-result', { ...resultEditState, assassin, remainingCards: remaining }, 'Result updated');
}

async function submitResultDelete() {
  if (!resultEditState) return;
  const adjustScore = document.getElementById('re-adjust-score').checked;
  const state = { ...resultEditState };
  closeDialog('result-edit-modal');
  const ok = await confirmDialog({
    title: 'Delete this result?',
    body: `<p>Round ${state.roundNumber} · Match ${state.matchNumber} · Game ${state.game} is removed from the history. ${adjustScore ? 'Scores are reversed.' : 'Scores are <b>not</b> changed.'}</p>`,
    confirmLabel: 'Delete result', danger: true,
  });
  if (!ok) return;
  resultEditState = state;
  postResult('/api/admin/delete-result', { roundNumber: state.roundNumber, matchNumber: state.matchNumber, game: state.game, adjustScore }, 'Result deleted');
}

// ── Start ──────────────────────────────────────────────────────────────────
renderThemeButton();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeButton);
fetchMe();
fetchData();
