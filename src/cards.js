// Discord messages, built with Components V2 (containers, text displays,
// sections). Pure functions: each returns a message payload and touches no
// state, so test/cards.test.js can validate them with discord.js itself.
//
// In V2 messages, mentions inside text displays DO ping on send (unlike
// embeds), so every payload sets allowedMentions; only the cards meant to ping
// pass `pings`.
//
// Button custom IDs are unchanged from the embed era (signup, leave_tournament,
// log_<team>_win[_gN], cnb_ok_/cnb_no_), so buttons on messages posted before
// the switch keep working.

const {
  ContainerBuilder, TextDisplayBuilder, SeparatorSpacingSize, ButtonBuilder, ButtonStyle,
  ActionRowBuilder, MessageFlags,
} = require('discord.js');

const COLORS = {
  signup: 0x5865f2,
  live: 0x3ccf7e,
  complete: 0xf2b23e,
  round: 0x5865f2,
  game: 0x3ccf7e,
  nextGame: 0xf2b23e,
  summary: 0x4c8dff,
  expired: 0xff4500,
  confirm: 0xffcc00,
  muted: 0x6f7690,
};

// Discord allows 4000 characters of text and 40 components per message.
const TEXT_BUDGET = 3800;
const MAX_MATCH_SECTIONS = 8;
const MEDALS = ['🥇', '🥈', '🥉'];

const mention = id => (/^\d+$/.test(String(id)) ? `<@${id}>` : `\`${id}\``);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const ts = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;

function clamp(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 2)}…`;
}

function payload(containers, { pings = [] } = {}) {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: containers,
    allowedMentions: { parse: [], users: pings.filter(id => /^\d+$/.test(String(id))) },
  };
}

function text(container, content) {
  return container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

function divider(container, spacing = SeparatorSpacingSize.Small) {
  return container.addSeparatorComponents(s => s.setDivider(true).setSpacing(spacing));
}

function linkButton(label, url) {
  return new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url);
}

function teamLine(team, color) {
  const dot = color === 'blue' ? '🔵' : '🔴';
  return `${dot} 🔎 ${mention(team.spymaster)} & ${mention(team.guesser)}`;
}

function lineup(grouping) {
  return `${teamLine(grouping.blue, 'blue')}\n${teamLine(grouping.red, 'red')}`;
}

// ── Tournament (sign-up / live scoreboard / final) ─────────────────────────

function standingsText(standings, gamesPlayed, budget) {
  let rank = 0;
  let lastPts = null;
  const lines = [];
  let used = 0;
  for (let i = 0; i < standings.length; i++) {
    const [id, pts] = standings[i];
    if (pts !== lastPts) { rank = i + 1; lastPts = pts; }
    const games = gamesPlayed[id] || 0;
    const badge = pts > 0 && MEDALS[rank - 1] ? MEDALS[rank - 1] : `\`${String(rank).padStart(2)}\``;
    const avg = games ? ` · ${(pts / games).toFixed(2)}/game` : '';
    const line = `${badge} ${mention(id)} **${pts}** pts · ${plural(games, 'game')}${avg}`;
    if (used + line.length + 1 > budget) {
      lines.push(`-# …and ${standings.length - i} more on the website`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n') || '-# No scores yet';
}

// state: { phase: 'signup'|'live'|'complete', players, prediction, round, totalRounds,
//          matchesDone, matchesInRound, deadlineMs, signupsOpen, activeMatches:
//          [{ matchNumber, game, gamesPlanned, players, threadUrl }], standings, gamesPlayed }
function tournamentCard(state, { webUrl }) {
  const c = new ContainerBuilder();
  const website = linkButton('Website', webUrl);

  if (state.phase === 'signup') {
    c.setAccentColor(COLORS.signup);
    text(c, '## 🕵️ Codenames Tournament\nSign up with the button below. Every pair of players teams up against every other player, in matches of up to 6 games.');
    divider(c);
    const list = state.players.length ? state.players.map(mention).join(' · ') : '-# Nobody yet — be the first!';
    text(c, clamp(`**Signed up (${state.players.length})**\n${list}`, 2500));
    if (state.prediction) {
      const p = state.prediction;
      text(c, `-# Expected: at least ${p.matches} matches (${p.games} games) over ${p.minRounds}+ rounds, ${plural(p.matchesPerRound, 'match', 'matches')} at a time.`);
    }
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('signup').setLabel('Sign up / leave').setStyle(ButtonStyle.Primary),
      website,
    ));
    return payload([c]);
  }

  if (state.phase === 'complete') {
    c.setAccentColor(COLORS.complete);
    text(c, '## 🏆 Tournament complete!\nEvery pair has teamed up against every other player. Final standings:');
    divider(c);
    text(c, standingsText(state.standings, state.gamesPlayed, TEXT_BUDGET - 300));
    c.addActionRowComponents(new ActionRowBuilder().addComponents(website));
    return payload([c]);
  }

  c.setAccentColor(COLORS.live);
  const deadline = state.deadlineMs ? ` · ends ${ts(state.deadlineMs, 'R')}` : '';
  const status = state.signupsOpen ? '\n-# 📋 Signups are open — new rounds start once they close.' : '';
  text(c, `## 🕵️ Codenames Tournament\n**Round ${state.round} of ${state.totalRounds}** · ${state.matchesDone}/${state.matchesInRound} matches done${deadline}${status}`);

  let budget = TEXT_BUDGET - 400;
  if (state.activeMatches.length) {
    divider(c);
    text(c, '### ⚔️ In play');
    for (const m of state.activeMatches.slice(0, MAX_MATCH_SECTIONS)) {
      const body = `**Match ${m.matchNumber}** · game ${m.game} of ${m.gamesPlanned}\n${m.players.map(mention).join(' · ')}`;
      budget -= body.length;
      if (m.threadUrl) {
        c.addSectionComponents(s => s
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
          .setButtonAccessory(linkButton('Thread', m.threadUrl)));
      } else {
        text(c, body);
      }
    }
    if (state.activeMatches.length > MAX_MATCH_SECTIONS) {
      text(c, `-# …and ${state.activeMatches.length - MAX_MATCH_SECTIONS} more matches on the website`);
    }
  }
  divider(c);
  text(c, `### 🏅 Standings\n${standingsText(state.standings, state.gamesPlayed, Math.max(500, budget))}`);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    website,
    new ButtonBuilder().setCustomId('leave_tournament').setLabel('Leave tournament').setStyle(ButtonStyle.Danger),
  ));
  return payload([c]);
}

// ── Rounds ─────────────────────────────────────────────────────────────────

// Posted in the tournament channel once a round's threads exist.
// matches: [{ matchNumber, players, gamesPlanned, threadUrl }]
function roundCard({ round, matches, deadlineMs }) {
  const c = new ContainerBuilder().setAccentColor(COLORS.round);
  text(c, `## 📋 Round ${round} — ${plural(matches.length, 'match', 'matches')}\nPlay every game before ${ts(deadlineMs, 'F')} (${ts(deadlineMs, 'R')}). Line-ups and result buttons are in each match's thread.`);
  divider(c);
  for (const m of matches.slice(0, 12)) {
    const body = `**Match ${m.matchNumber}** · ${plural(m.gamesPlanned, 'game')}\n${m.players.map(mention).join(' · ')}`;
    if (m.threadUrl) {
      c.addSectionComponents(s => s
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
        .setButtonAccessory(linkButton('Open thread', m.threadUrl)));
    } else {
      text(c, body);
    }
  }
  if (matches.length > 12) text(c, `-# …and ${matches.length - 12} more matches`);
  return payload([c]);
}

// One game of a match, posted in its thread with the result buttons.
// `intro` (game 1) pings the four players and lists the whole match plan.
function gameCard({ round, matchNumber, gameIndex, games, bridgeEnabled, intro = false }) {
  const g = games[gameIndex - 1];
  const c = new ContainerBuilder().setAccentColor(intro ? COLORS.game : COLORS.nextGame);
  const title = intro
    ? `## Round ${round} · Match ${matchNumber}\n**Game 1 of ${games.length}**`
    : `## Game ${gameIndex} of ${games.length}\n-# Round ${round} · Match ${matchNumber}`;
  text(c, `${title}\n${lineup(g)}\n-# 🔎 = spymaster`);
  if (intro && games.length > 1) {
    divider(c);
    const plan = games.map((x, i) =>
      `\`G${i + 1}\` 🔵 ${mention(x.blue.spymaster)} & ${mention(x.blue.guesser)}  vs  🔴 ${mention(x.red.spymaster)} & ${mention(x.red.guesser)}`);
    text(c, clamp(`**Match plan** (spymaster first)\n${plan.join('\n')}`, 1800));
  }
  divider(c);
  const how = bridgeEnabled
    ? (intro
      ? '🕵️ Post your **codenames.game** room link here and every result is logged automatically. Use the same room for every game (**Play next game**). The buttons below are a fallback.'
      : '🕵️ Use **Play next game** in the same codenames.game room — the result is logged automatically.')
    : `Play game ${gameIndex}, then log the result:`;
  text(c, how);
  const suffix = gameIndex > 1 ? `_g${gameIndex}` : '';
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`log_blue_win${suffix}`).setLabel('Blue won').setEmoji('🔵').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`log_red_win${suffix}`).setLabel('Red won').setEmoji('🔴').setStyle(ButtonStyle.Danger),
  ));
  const players = [g.blue.spymaster, g.blue.guesser, g.red.spymaster, g.red.guesser];
  return payload([c], { pings: intro ? players : [] });
}

// byMatch: [{ matchNumber, games: [{ gameIndex, winner, assassin, remainingCards, winPoints, losePoints, grouping }] }]
function roundSummaryCard({ round, byMatch }) {
  const c = new ContainerBuilder().setAccentColor(COLORS.summary);
  text(c, `## 📊 Round ${round} complete`);
  if (!byMatch.length) {
    text(c, '-# No results were recorded.');
    return payload([c]);
  }
  const perMatch = Math.floor((TEXT_BUDGET - 100) / byMatch.length);
  for (const { matchNumber, games } of byMatch) {
    const blueWins = games.filter(r => r.winner === 'blue').length;
    const lines = games.map(r => {
      const how = r.assassin ? 'assassin' : `${r.remainingCards} left`;
      const w = r.winner === 'blue' ? r.grouping.blue : r.grouping.red;
      const pts = `+${r.winPoints}/${r.losePoints > 0 ? '+' : ''}${r.losePoints}`;
      return `\`G${r.gameIndex || 1}\` ${r.winner === 'blue' ? '🔵' : '🔴'} ${mention(w.spymaster)} & ${mention(w.guesser)} · ${how} · ${pts}`;
    });
    divider(c);
    text(c, clamp(`**Match ${matchNumber}** — 🔵 ${blueWins} · 🔴 ${games.length - blueWins}\n${lines.join('\n')}`, perMatch));
  }
  return payload([c]);
}

// completed: [{ matchNumber, played, blueWins }]; active: [{ matchNumber, game, gamesPlanned, players }]
function roundExpiryCard({ round, deadlineMs, totalMatches, completed, active, webUrl }) {
  const c = new ContainerBuilder().setAccentColor(COLORS.expired);
  text(c, `## ⏰ Round ${round}: time's up\nThe deadline was ${ts(deadlineMs, 'F')}.`);
  if (completed.length) {
    divider(c);
    text(c, clamp(`**✅ Finished (${completed.length}/${totalMatches})**\n${completed.map(m =>
      `Match ${m.matchNumber}: ${plural(m.played, 'game')} (🔵 ${m.blueWins} – 🔴 ${m.played - m.blueWins})`).join('\n')}`, 1500));
  }
  if (active.length) {
    divider(c);
    text(c, clamp(`**⏳ Still playing (${active.length}/${totalMatches})**\n${active.map(m =>
      `Match ${m.matchNumber} (game ${m.game} of ${m.gamesPlanned}): ${m.players.map(mention).join(' · ')}`).join('\n')}`, 1800));
  }
  divider(c);
  c.addSectionComponents(s => s
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('**Admins:** force-end the round from the website to move on.'))
    .setButtonAccessory(linkButton('Website', webUrl)));
  return payload([c]);
}

// ── codenames.game bridge ──────────────────────────────────────────────────

function bridgeConfirmCard({ pendingId, gamePhase, winner, assassin, remainingCards, roomUrl, expected, seatsText }) {
  const c = new ContainerBuilder().setAccentColor(COLORS.confirm);
  const how = assassin ? 'assassin hit' : `${plural(remainingCards, 'card')} left`;
  text(c, `## 🕵️ Game ${gamePhase} result detected — please confirm\ncodenames.game says **${winner === 'blue' ? '🔵 Blue' : '🔴 Red'}** won (${how})${roomUrl ? ` in ${roomUrl}` : ''}.`);
  text(c, `-# The seats in the room didn't match the line-up for game ${gamePhase} (or some players haven't pressed **I'm playing** on the room card), so it wasn't logged automatically.`);
  divider(c);
  text(c, `**Expected**\n${lineup(expected)}`);
  text(c, `**In the room**\n${seatsText}`);
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cnb_ok_${pendingId}`).setLabel(`Log as game ${gamePhase}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cnb_no_${pendingId}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
  ));
  return payload([c]);
}

// A one-line card, e.g. to replace a resolved confirmation.
function noticeCard(content, color = COLORS.muted) {
  const c = new ContainerBuilder().setAccentColor(color);
  text(c, content);
  return payload([c]);
}

module.exports = {
  COLORS,
  tournamentCard,
  roundCard,
  gameCard,
  roundSummaryCard,
  roundExpiryCard,
  bridgeConfirmCard,
  noticeCard,
};
