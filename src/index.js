require('dotenv').config();

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionsBitField } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const codenamesBridge = require('./codenamesBridge');
const scheduler = require('./scheduler');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOURNAMENT_FILE = path.join(DATA_DIR, 'tournament.json');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// In-memory storage
let tournament = {
  players: new Set(),
  currentRound: 0,
  currentRoundIndex: 0, // Index of current match within the round
  playedGroupings: new Set(),
  scores: new Map(),
  activeMatches: [], // [{grouping, threadId, matchNumber, gamePhase, game1Result, phaseResults, matchCreatedAt}]
  roundResults: [], // [{matchNumber, gameIndex, grouping, winner, assassin, remainingCards, winPoints, losePoints}]
  setupMessage: null,
  setupChannelId: null, // Channel where setup message was posted
  rounds: [], // Array of rounds, each round contains multiple matches
  started: false, // Track if tournament has started
  roundDeadline: null, // Unix ms timestamp when current round expires
  // Rich history — never cleared, accumulates all game results for export
  history: [], // [{roundNumber, matchNumber, game, grouping, winner, assassin, remainingCards, winPoints, losePoints, matchCreatedAt, submittedAt, submittedBy}]
  playerNames: {}, // {userId: displayName} snapshot taken at tournament start
  tournamentStartedAt: null, // ISO timestamp when tournament was started
  roundStartedAt: null, // ISO timestamp when current round was allocated
  leftPlayers: {}, // {userId: {displayName, leftAt, score}} — players who left mid-tournament
  pendingRemoval: null, // {userId, confirmMessageId, requestedAt} — in-flight leave request
  signupsReopened: false, // true while a mid-tournament signup window is open
  signupReopenMessageId: null, // Discord message ID of the active reopen-signups message
};

// Codenames bridge (BGA bot's codenames.game watcher) — optional, see docs/codenames-bridge.md
const BRIDGE_TOKEN = (process.env.BRIDGE_TOKEN || '').trim();
const bridgeClient = codenamesBridge.createBridgeClient({
  token: BRIDGE_TOKEN,
  baseUrls: codenamesBridge.parseUrlList(process.env.BRIDGE_URLS),
});
// threadId -> signature of the binding the BGA bot last accepted (persisted, survives resets)
let codenamesBridgeSynced = {};
let bridgeSyncTimer = null;
let bridgeSyncRunning = false;
let bridgeSyncAgain = false;
const BRIDGE_RESYNC_INTERVAL_MS = 5 * 60 * 1000;
const BRIDGE_STATUS_INTERVAL_MS = 2 * 60 * 1000;
// threadId -> live status from the BGA bot (in memory; refreshed every 2 minutes)
const bridgeStatus = {};
let bridgeStatusRunning = false;

// Round timer handles (in-memory only)
let roundWarningTimer = null;
let roundExpiryTimer = null;
let threadKeepAliveTimer = null;
let removalTimeoutTimer = null;

// Duration of the pending-removal confirmation window (15 minutes)
const REMOVAL_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_GAMES_PER_MATCH = 2;
const MAX_GAMES_PER_MATCH = 4;

function clampGamesPerMatch(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return MIN_GAMES_PER_MATCH;
  return Math.max(MIN_GAMES_PER_MATCH, Math.min(MAX_GAMES_PER_MATCH, n));
}

function getDefaultPhaseSequence(gamesPlanned) {
  const games = clampGamesPerMatch(gamesPlanned);
  return Array.from({ length: games }, (_, i) => i + 1);
}

// Tracks threads currently mid-submission to prevent double-posting
// Key: `${threadId}:${gamePhase}` — set synchronously before any await, cleared after
const processingThreads = new Set();

// Funny keep-alive messages posted to active match threads every 2–3 days
const KEEPALIVE_MESSAGES = [
  "📣 Just checking in — this thread is still alive, unlike your opponent's chances of winning! 🎯",
  "🕵️ The spymaster sees all... including the fact that nobody has submitted a result yet. Tick tock!",
  "🃏 Fun fact: a Codenames game left unfinished is like a clue with no words — technically valid, deeply unsatisfying.",
  "🔵🔴 Neither blue nor red has won yet. The real winner right now is procrastination.",
  "🎲 The dice gods grow restless. They demand a result. Feed them.",
  "📖 Page 47 of the Codenames rulebook: 'Games shall not linger in limbo for eternity.' We checked — it's in there.",
  "🤔 Somewhere, a spymaster is staring at the board wondering if 'CLOUD' connects to 'BANK', 'STORM', and 'NINE'. It does not. Please play.",
  "⏳ This thread is kept alive by sheer willpower and the bot's undying devotion to your tournament.",
  "🎯 Friendly reminder: the assassin word is out there. Don't let *time* be the assassin of this match.",
  "🧠 A spymaster's greatest clue: 'HURRY… 1.' The word? YOUR RESULT. Submit it.",
  "🏓 Ping! This is your board game conscience speaking. It says: finish the game.",
  "🚨 ALERT: Thread detected in the wild. Status: unresolved. Solution: play Codenames.",
  "☕ The bot has had three coffees waiting for this result. Please, for the bot's sake.",
  "🎮 According to our calculations, the average Codenames game takes 15–30 minutes. This round has been running longer. Considerably longer.",
  "🧩 Puzzle: two teams, one board, zero submitted results. What are you? *A mystery.* 🔍",
  "👀 The leaderboard is watching. The leaderboard is *judging*. Don't disappoint the leaderboard.",
  "🛎️ *ding ding ding* That's the sound of this thread reminding you it exists and misses you dearly.",
  "🐢 A tortoise playing Codenames would have finished by now. Are you slower than a tortoise? Prove us wrong.",
  "📡 Transmission received from deep space: 'Finish... your... game...' — probably aliens who are also waiting.",
  "🎭 Act 1: Players join the tournament. Act 2: The game is played. Act 3: **??** — we're still in Act 2, folks.",
  "🦆 If a Codenames game is played and no one submits the result, did it even happen? Philosophically speaking — no.",
  "💤 Zzzzzz— oh! Sorry, the thread dozed off. It's awake now. Are YOU?",
  "🌮 Fun tournament tip: results are best submitted before they get cold, like tacos. Don't let your victory get cold.",
  "🎪 Step right up! See the longest-running Codenames match in recorded history! Admission: just a result submission.",
  "📜 Ancient tournament scroll, decoded: *'Ye who doth not submit their result shall be haunted by ping messages for eternity.'*",
  "🤖 Beep boop. Bot online. Thread alive. Result: missing. Conclusion: please help the bot.",
  "🏆 Somewhere in this tournament, someone is going to win. It could be you! But first you have to *play*.",
  "🎯 Clue: 'SUBMIT' — 1. The word? Your game result. The board is waiting.",
  "🌈 Every time a Codenames result gets submitted, a rainbow appears. The sky has been suspiciously clear lately.",
  "🦁 Be the spymaster you wish to see in the world. Also be the person who submits results on time.",
  "🏰 The tournament castle stands strong. Its gates are open. The drawbridge is down. Just come in and submit your result.",
  "🔮 The tournament oracle predicts: *someone will win this match*. Prophecy pending result submission.",
  "🎸 🎵 *Don't stop believin'... hold on to that game result...* 🎵 — Journey (probably, if they played board games)",
  "🌍 Seven billion people on Earth. Only you four are standing between this thread and a result. No pressure.",
  "🍕 Results are like pizza — even when they're late, they're still welcome. Bring your result. We have metaphorical pizza.",
  "📱 You have 1 unread message from: your unfinished Codenames match. It says: 'please come back, I miss you.'",
  "🧲 This message is magnetically attracted to your attention. Its purpose: remind you a game awaits completion.",
  "⚔️ Two teams. One board. Twenty-five words. Infinite procrastination potential. Please reduce the potential.",
  "🎰 The slot machine of destiny has been spinning since this round began. Pull the lever. Submit the result.",
  "🌊 Like a wave that never reaches the shore, this game result floats somewhere in the ether. Bring it home.",
  "🦅 Freedom is submitting your Codenames result and watching the scoreboard update in real time. Fly free.",
  "🧁 Every game result submitted earns exactly zero cupcakes. But the emotional satisfaction? Priceless.",
  "🎬 *[Director's voice]* Okay team, we've been on this scene for a while. Let's get that result and move on to the next round!",
  "🧸 Even the tournament mascot (a small imaginary bear named Gerald) is rooting for you to finish this game.",
  "🏄 Ride the wave of tournament glory. It starts with one small step: clicking that result button.",
  "💡 Hot tip from a Codenames grandmaster: *winning is better when you actually finish the game.*",
  "🗺️ You are HERE → [unfinished match]. The treasure is HERE → [submitted result]. Adventure awaits.",
  "🎻 *plays world's smallest violin for the unsubmitted game result* 🎻 It's a touching melody. Very sad.",
  "🚀 Houston, we have a match. It's in progress. Mission control is standing by for your result transmission.",
  "🌟 Stars aligned, players assembled, board laid out, clues given — the only thing missing is *your result*. You've got this!",
];

const commands = [
  new SlashCommandBuilder()
    .setName('tournament')
    .setDescription('Set up the Codenames tournament'),
];

client.once('clientReady', async () => {
  console.log('Bot is ready!');

  // Print a permissions URL so you can verify the bot has everything it needs
  const requiredPermissions = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,           // see the tournament channel
    PermissionsBitField.Flags.SendMessages,           // post match embeds + round headers
    PermissionsBitField.Flags.SendMessagesInThreads,  // post inside game threads
    PermissionsBitField.Flags.EmbedLinks,             // send rich embeds
    PermissionsBitField.Flags.ReadMessageHistory,     // fetch messages to delete between rounds
    PermissionsBitField.Flags.ManageMessages,         // delete old round messages
    PermissionsBitField.Flags.CreatePublicThreads,    // create game threads
    PermissionsBitField.Flags.ManageThreads,          // archive threads after a match
    PermissionsBitField.Flags.UseApplicationCommands, // slash command support
  ]);
  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=${requiredPermissions.bitfield}&scope=bot+applications.commands`;
  console.log('\n=== BOT PERMISSIONS URL ===');
  console.log(inviteUrl);
  console.log('===========================\n');

  // Load tournament data on startup
  await loadTournamentData();
  if (bridgeClient.enabled) {
    console.log('[bridge] Codenames bridge enabled');
    scheduleBridgeSync(0);
    // Retries bindings the BGA bot couldn't take (e.g. it was restarting).
    setInterval(() => scheduleBridgeSync(0), BRIDGE_RESYNC_INTERVAL_MS);
    setTimeout(() => pollBridgeStatus().catch(e => console.error('[bridge] Status poll failed:', e.message)), 5000);
    setInterval(() => pollBridgeStatus().catch(e => console.error('[bridge] Status poll failed:', e.message)), BRIDGE_STATUS_INTERVAL_MS);
  }

  // Register commands
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (guild) {
    await guild.commands.set(commands);
    console.log('Commands registered');0
  }

  // Rebuild setup message on startup so embed changes propagate without manual intervention
  if (tournament.setupMessage && tournament.setupChannelId && guild) {
    try {
      const channel = await guild.channels.fetch(tournament.setupChannelId).catch(() => null);
      if (channel) {
        if (tournament.started) {
          await updateScoreboard(guild);
          console.log('[startup] Scoreboard rebuilt');
          // Re-schedule round timers after restart
          if (tournament.roundDeadline) {
            scheduleRoundTimers(guild);
            if (tournament.activeMatches.length > 0) startThreadKeepAlive(guild);
          }

          // Recovery: handle pending removal timeout
          if (tournament.pendingRemoval) {
            const elapsed = Date.now() - new Date(tournament.pendingRemoval.requestedAt).getTime();
            if (elapsed >= REMOVAL_TIMEOUT_MS) {
              console.log('[startup] Pending removal expired, auto-cancelling');
              cancelPendingRemoval(guild, 'timeout').catch(e => console.error('[startup]', e.message));
            } else {
              const remaining = REMOVAL_TIMEOUT_MS - elapsed;
              console.log(`[startup] Re-scheduling removal timeout in ${Math.round(remaining / 1000)}s`);
              removalTimeoutTimer = setTimeout(() => {
                cancelPendingRemoval(guild, 'timeout').catch(e => console.error('[removal-timeout]', e.message));
              }, remaining);
            }
          }

          // Recovery: if the current round has no active matches and isn't complete,
          // the threads were never created (e.g. permission error or crash during allocateRound).
          // Re-run allocateRound automatically so no manual intervention is needed.
          const roundNotFinished = tournament.currentRound <= tournament.rounds.length;
          if (roundNotFinished && tournament.activeMatches.length === 0) {
            console.log(`[startup] Round ${tournament.currentRound} has no active matches — re-allocating threads...`);
            try {
              const result = await allocateRound(guild);
              if (result.success) {
                console.log(`[startup] Recovery allocation succeeded: ${result.message}`);
              } else {
                console.warn(`[startup] Recovery allocation failed: ${result.message}`);
              }
            } catch (e) {
              console.error('[startup] Recovery allocation threw:', e.message);
            }
          }
        } else {
          await updateSignupMessage(channel);
          console.log('[startup] Signup message rebuilt');
        }
      } else {
        console.warn('[startup] setupChannelId channel not found:', tournament.setupChannelId);
      }
    } catch (error) {
      console.error('[startup] Failed to rebuild setup message:', error.message);
    }
  }
});

async function loadTournamentData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(TOURNAMENT_FILE, 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('No previous tournament data found, starting fresh');
      return;
    }
    // Never carry on with an empty tournament: the next save would overwrite the real data.
    const backup = `${TOURNAMENT_FILE}.unreadable-${Date.now()}`;
    await fs.copyFile(TOURNAMENT_FILE, backup).catch(() => null);
    console.error(`[startup] ${TOURNAMENT_FILE} could not be read (${error.message}). A copy was saved to ${backup}. Fix or restore the file, then restart.`);
    process.exit(1);
  }
  tournament.players = new Set(parsed.players);
  tournament.scores = new Map(parsed.scores);
  tournament.playedGroupings = new Set(parsed.playedGroupings);
  tournament.currentRound = parsed.currentRound;
  tournament.currentRoundIndex = parsed.currentRoundIndex || 0;
  tournament.activeMatches = parsed.activeMatches || [];
  tournament.roundResults = parsed.roundResults || [];
  tournament.roundDeadline = parsed.roundDeadline || null;
  tournament.setupMessage = parsed.setupMessage;
  tournament.setupChannelId = parsed.setupChannelId;
  tournament.rounds = parsed.rounds || [];
  tournament.started = parsed.started || false;
  tournament.history = parsed.history || [];
  tournament.playerNames = parsed.playerNames || {};
  tournament.tournamentStartedAt = parsed.tournamentStartedAt || null;
  tournament.roundStartedAt = parsed.roundStartedAt || null;
  tournament.leftPlayers = parsed.leftPlayers || {};
  tournament.pendingRemoval = parsed.pendingRemoval || null;
  tournament.signupsReopened = parsed.signupsReopened || false;
  tournament.signupReopenMessageId = parsed.signupReopenMessageId || null;
  codenamesBridgeSynced = parsed.codenamesBindings || {};
  console.log('Tournament data loaded from storage');
}

// Saves run one at a time, and each writes a temp file then renames it over
// the real one, so a crash mid-write can't leave a half-written file.
let saveChain = Promise.resolve();

function saveTournamentData() {
  const run = saveChain.then(writeTournamentData);
  saveChain = run.catch(() => null);
  return run;
}

async function writeTournamentData() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const data = {
      players: Array.from(tournament.players),
      scores: Array.from(tournament.scores),
      playedGroupings: Array.from(tournament.playedGroupings),
      currentRound: tournament.currentRound,
      currentRoundIndex: tournament.currentRoundIndex,
      activeMatches: tournament.activeMatches,
      roundResults: tournament.roundResults,
      roundDeadline: tournament.roundDeadline,
      setupMessage: tournament.setupMessage,
      setupChannelId: tournament.setupChannelId,
      rounds: tournament.rounds,
      started: tournament.started,
      history: tournament.history,
      playerNames: tournament.playerNames,
      tournamentStartedAt: tournament.tournamentStartedAt,
      roundStartedAt: tournament.roundStartedAt,
      leftPlayers: tournament.leftPlayers,
      pendingRemoval: tournament.pendingRemoval,
      signupsReopened: tournament.signupsReopened,
      signupReopenMessageId: tournament.signupReopenMessageId,
      codenamesBindings: codenamesBridgeSynced,
    };
    const tmp = `${TOURNAMENT_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, TOURNAMENT_FILE);
  } catch (error) {
    console.error('Failed to save tournament data:', error);
  }
  scheduleBridgeSync();
}

// ── Codenames bridge ───────────────────────────────────────────────────────

function getMatchBridgeRef(match) {
  return `R${tournament.currentRound}M${match.matchNumber}`;
}

// Tell the BGA bot which threads are live matches (debounced; runs after every save).
function scheduleBridgeSync(delayMs = 1000) {
  if (!bridgeClient.enabled) return;
  if (bridgeSyncTimer) clearTimeout(bridgeSyncTimer);
  bridgeSyncTimer = setTimeout(() => {
    bridgeSyncTimer = null;
    syncBridgeBindings().catch(e => console.error('[bridge] Sync failed:', e.message));
  }, delayMs);
}

async function syncBridgeBindings() {
  if (bridgeSyncRunning) { bridgeSyncAgain = true; return; }
  bridgeSyncRunning = true;
  try {
    do {
      bridgeSyncAgain = false;
      const desired = new Map();
      for (const match of tournament.activeMatches) {
        if (!match.threadId) continue;
        const game = match.gamePhase ?? 1;
        const gamesPlanned = getMatchGameCount(match);
        desired.set(match.threadId, codenamesBridge.buildBinding({
          guildId: process.env.GUILD_ID,
          externalRef: getMatchBridgeRef(match),
          grouping: match.grouping,
          currentGrouping: game <= gamesPlanned ? getGroupingForMatchGame(match, game) : null,
          game,
          lastEventId: (match.bridgeEvents || []).slice(-1)[0] || null,
          playerNames: tournament.playerNames,
          deadlineMs: tournament.roundDeadline,
        }));
      }
      const changed = await bridgeClient.reconcile(desired, codenamesBridgeSynced);
      if (changed) await saveTournamentData();
    } while (bridgeSyncAgain);
  } finally {
    bridgeSyncRunning = false;
  }
}

// Ask the BGA bot what is happening in each active match's room.
async function pollBridgeStatus() {
  if (!bridgeClient.enabled || bridgeStatusRunning) return;
  bridgeStatusRunning = true;
  try {
    const active = new Set();
    for (const match of tournament.activeMatches) {
      if (!match.threadId) continue;
      active.add(match.threadId);
      if (!codenamesBridgeSynced[match.threadId]) {
        bridgeStatus[match.threadId] = { state: 'unbound', checkedAt: new Date().toISOString() };
        continue;
      }
      const res = await bridgeClient.getBinding(match.threadId);
      if (res.ok) {
        bridgeStatus[match.threadId] = codenamesBridge.summariseStatus(res.data);
      } else if (res.status === 404) {
        // The BGA bot has forgotten this thread (e.g. a fresh database): bind it again.
        delete codenamesBridgeSynced[match.threadId];
        bridgeStatus[match.threadId] = { state: 'unbound', checkedAt: new Date().toISOString() };
        scheduleBridgeSync(0);
      } else {
        bridgeStatus[match.threadId] = { state: 'unreachable', checkedAt: new Date().toISOString() };
      }
    }
    for (const threadId of Object.keys(bridgeStatus)) {
      if (!active.has(threadId)) delete bridgeStatus[threadId];
    }
  } finally {
    bridgeStatusRunning = false;
  }
}

function getThreadUrl(threadId) {
  return process.env.GUILD_ID && threadId ? `https://discord.com/channels/${process.env.GUILD_ID}/${threadId}` : null;
}

// Live status per active match number, for the dashboard.
function buildMatchStatus() {
  const out = {};
  for (const match of tournament.activeMatches) {
    out[match.matchNumber] = {
      threadUrl: getThreadUrl(match.threadId),
      game: match.gamePhase ?? 1,
      pendingConfirmations: Object.keys(match.pendingBridgeResults || {}).length,
      live: bridgeClient.enabled ? (bridgeStatus[match.threadId] || null) : null,
    };
  }
  return out;
}

function bridgeThreadHint() {
  return bridgeClient.enabled
    ? '\n\n🕵️ Post your **codenames.game** room link in this thread and results are logged automatically. ' +
      'Use the same room for every game in this match (**Play next game**). The buttons below still work if you need them.'
    : '';
}

function buildSignupDescription() {
  const playerList = Array.from(tournament.players);

  let description = 'Sign up for the tournament and manage it with the buttons below.\n\n**Signed Up Players:**\n';
  if (playerList.length > 0) {
    description += playerList.map(id => id.startsWith('debug_') ? `\`${id}\`` : `<@${id}>`).join('\n');
  } else {
    description += 'None yet';
  }

  if (playerList.length >= 4) {
    const prediction = scheduler.predictSchedule(playerList.length);
    if (prediction) {
      description += `\n\n**Tournament Prediction:**\n`;
      description += `At least ${prediction.matches} matches (${prediction.games} games) • ${prediction.minRounds}+ rounds`;
      description += `\n${prediction.matchesPerRound} match${prediction.matchesPerRound === 1 ? '' : 'es'} per round, 6 games each`;
      description += `\nEvery pair teams up against every other player`;
    }
  }

  return description;
}

async function updateSignupMessage(channel) {
  try {
    if (!tournament.setupMessage) return;
    const message = await channel.messages.fetch(tournament.setupMessage).catch(() => null);
    if (!message) {
      console.warn('[updateSignupMessage] Could not fetch setupMessage:', tournament.setupMessage);
      return;
    }
    const embed = message.embeds[0];
    const updatedEmbed = EmbedBuilder.from(embed).setDescription(buildSignupDescription());
    await message.edit({ embeds: [updatedEmbed] });
    console.log('[updateSignupMessage] Setup message updated successfully');
  } catch (error) {
    console.error('[updateSignupMessage] Failed:', error.message);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isCommand()) {
    const { commandName } = interaction;

    if (commandName === 'tournament') {
      // Delete the old setup message if one exists
      if (tournament.setupMessage && tournament.setupChannelId) {
        try {
          const oldChannel = await interaction.guild.channels.fetch(tournament.setupChannelId).catch(() => null);
          if (oldChannel) {
            const oldMessage = await oldChannel.messages.fetch(tournament.setupMessage).catch(() => null);
            if (oldMessage) await oldMessage.delete().catch(() => null);
          }
        } catch (err) {
          console.warn('[tournament] Could not delete old setup message:', err.message);
        }
      }

      let embed;
      let row;

      if (tournament.started) {
        // Tournament is live - show current status and scores
        const roundMatches = tournament.rounds[tournament.currentRound - 1] || [];
        const completedInRound = roundMatches.length - tournament.activeMatches.length;
        let description = `**Tournament Live - Round ${tournament.currentRound}/${tournament.rounds.length}**\n`;
        description += `${completedInRound}/${roundMatches.length} matches completed\n\n`;
        
        if (tournament.activeMatches.length > 0) {
          description += `**Active Matches:**\n`;
          tournament.activeMatches.forEach(m => {
            description += `Match ${m.matchNumber}: 🔵 <@${m.grouping.blue.spymaster}> & <@${m.grouping.blue.guesser}> vs 🔴 <@${m.grouping.red.spymaster}> & <@${m.grouping.red.guesser}>\n`;
          });
          description += '\n';
        }

        description += `**Scoreboard:**\n`;
        const sortedScores = Array.from(tournament.scores.entries())
          .sort((a, b) => b[1] - a[1]);
        const gamesPlayedMap = getGamesPlayedMap();
        let rank = 0;
        let lastPts = null;
        sortedScores.forEach((entry, idx) => {
          if (entry[1] !== lastPts) { rank = idx + 1; lastPts = entry[1]; }
          const gp = gamesPlayedMap[entry[0]] || 0;
          description += `${rank}. <@${entry[0]}> - ${entry[1]} pts (${gp} game${gp !== 1 ? 's' : ''})\n`;
        });

        embed = new EmbedBuilder()
          .setTitle('Codenames Tournament')
          .setDescription(description)
          .setColor(0x00ff00);

        row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setLabel('🌐 Website')
              .setStyle(ButtonStyle.Link)
              .setURL(getWebBaseUrl()),
            new ButtonBuilder()
              .setCustomId('leave_tournament')
              .setLabel('🚪 Leave Tournament')
              .setStyle(ButtonStyle.Danger),
          );
      } else {
        // Tournament not started - show sign-up
        embed = new EmbedBuilder()
          .setTitle('Codenames Tournament')
          .setDescription(buildSignupDescription())
          .setColor(0x0099ff);

        row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('signup')
              .setLabel('Sign Up')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setLabel('🌐 Website')
              .setStyle(ButtonStyle.Link)
              .setURL(getWebBaseUrl()),
          );
      }

      const response = await interaction.reply({ embeds: [embed], components: [row], withResponse: true });
      const message = response.resource.message;
      tournament.setupMessage = message.id;
      tournament.setupChannelId = message.channelId;
      await saveTournamentData();
    }
  } else if (interaction.isButton()) {
    const { customId } = interaction;

    if (customId === 'signup') {
      if (tournament.started) {
        await interaction.reply({ content: 'Tournament has already started! Sign-ups are closed.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (tournament.players.has(interaction.user.id)) {
        // User is already signed up, ask if they want to remove themselves
        const confirmRow = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`confirm_remove_${interaction.user.id}`)
              .setLabel('Yes, Remove Me')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`cancel_remove_${interaction.user.id}`)
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary),
          );
        await interaction.reply({ content: 'You\'re already signed up! Do you want to remove yourself from the tournament?', components: [confirmRow], flags: MessageFlags.Ephemeral });
      } else {
        // New sign-up
        tournament.players.add(interaction.user.id);
        // Reply immediately to avoid interaction timeout, then update message in background
        await interaction.reply({ content: 'You have signed up!', flags: MessageFlags.Ephemeral });
        await saveTournamentData();
        updateSignupMessage(interaction.channel); // fire-and-forget
      }
    } else if (customId === 'admin') {
      const adminRoleId = process.env.ADMIN_ROLE_ID; // Replace with your admin role ID
      if (!interaction.member.roles.cache.has(adminRoleId)) {
        await interaction.reply({ content: 'You do not have permission to access admin functions.', flags: MessageFlags.Ephemeral });
        return;
      }
      const adminEmbed = new EmbedBuilder()
        .setTitle('Admin Panel')
        .setDescription('Select an admin action.')
        .setColor(0xff0000);

      const debugMode = process.env.DEBUG_MODE === 'true';
      const debugPlayerCount = parseInt(process.env.DEBUG_PLAYER_COUNT) || 8;

      const adminComponents = [
          new ButtonBuilder()
            .setCustomId('admin_start')
            .setLabel('Start Tournament')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('admin_allocate')
            .setLabel('Allocate Next Round')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('admin_scores')
            .setLabel('View Scores')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('admin_force_end')
            .setLabel('Force End Match')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('admin_adjust_score')
            .setLabel('Adjust Score')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('admin_reset')
            .setLabel('Reset Tournament')
            .setStyle(ButtonStyle.Danger),
      ];

      if (debugMode) {
        adminComponents.push(
          new ButtonBuilder()
            .setCustomId('debug_seed_players')
            .setLabel(`[DEBUG] Seed ${debugPlayerCount} Players`)
            .setStyle(ButtonStyle.Secondary)
        );
      }

      if (tournament.started) {
        adminComponents.push(
          new ButtonBuilder()
            .setCustomId('admin_reopen_signups')
            .setLabel(tournament.signupsReopened ? '🔒 Close Signups' : '📋 Reopen Signups')
            .setStyle(tournament.signupsReopened ? ButtonStyle.Danger : ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('admin_fix_matchups')
            .setLabel('🔧 Fix Match-ups')
            .setStyle(ButtonStyle.Warning),
        );
      }

      const adminRow = new ActionRowBuilder().addComponents(adminComponents.slice(0, 5));
      const adminRows = [adminRow];
      if (adminComponents.length > 5) {
        adminRows.push(new ActionRowBuilder().addComponents(adminComponents.slice(5)));
      }
      if (adminComponents.length > 10) {
        adminRows.push(new ActionRowBuilder().addComponents(adminComponents.slice(10)));
      }

      await interaction.reply({ embeds: [adminEmbed], components: adminRows, flags: MessageFlags.Ephemeral });
    } else if (customId === 'admin_start') {
      if (tournament.started) {
        await interaction.reply({ content: 'Tournament has already started.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (tournament.players.size < 4) {
        await interaction.reply({ content: 'Need at least 4 players to start.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      tournament.currentRound = 1;
      tournament.currentRoundIndex = 0;
      tournament.started = true;
      tournament.tournamentStartedAt = new Date().toISOString();
      tournament.scores = new Map([...tournament.players].map(id => [id, 0]));
      tournament.rounds = scheduler.generateSchedule(Array.from(tournament.players));

      // Snapshot display names for all players
      tournament.playerNames = {};
      for (const id of tournament.players) {
        if (id.startsWith('debug_')) {
          tournament.playerNames[id] = id;
        } else {
          try {
            const member = await interaction.guild.members.fetch(id).catch(() => null);
            tournament.playerNames[id] = member ? member.displayName : id;
          } catch { tournament.playerNames[id] = id; }
        }
      }
      
      // Update the setup message to show tournament live
      try {
        if (tournament.setupMessage && tournament.setupChannelId) {
          const channel = await interaction.guild.channels.fetch(tournament.setupChannelId).catch(() => null);
          if (!channel) throw new Error('Could not fetch setup channel');
          const message = await channel.messages.fetch(tournament.setupMessage).catch(() => null);
          if (message) {
            let description = `**Tournament Live - Round ${tournament.currentRound}**\n`;
            description += `Match ${tournament.currentRoundIndex}/${tournament.rounds[tournament.currentRound - 1]?.length || 0}\n\n`;
            description += `**Scoreboard:**\n`;
            const sortedScores = Array.from(tournament.scores.entries())
              .sort((a, b) => b[1] - a[1]);
            const gamesPlayedMap = getGamesPlayedMap();
            let rank = 0;
            let lastPts = null;
            sortedScores.forEach((entry, idx) => {
              if (entry[1] !== lastPts) { rank = idx + 1; lastPts = entry[1]; }
              const gp = gamesPlayedMap[entry[0]] || 0;
              description += `${rank}. <@${entry[0]}> - ${entry[1]} pts (${gp} game${gp !== 1 ? 's' : ''})\n`;
            });
            
            const embed = message.embeds[0];
            const updatedEmbed = EmbedBuilder.from(embed)
              .setDescription(description)
              .setFields([])
              .setColor(0x00ff00);
            const websiteRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setLabel('🌐 Website').setStyle(ButtonStyle.Link).setURL(getWebBaseUrl()),
              new ButtonBuilder().setCustomId('leave_tournament').setLabel('🚪 Leave Tournament').setStyle(ButtonStyle.Danger),
            );
            await message.edit({ embeds: [updatedEmbed], components: [websiteRow] });
          }
        }
      } catch (error) {
        console.error('Failed to update setup message:', error.message);
      }
      
      await saveTournamentData();
      await interaction.editReply({ content: `Tournament started with ${tournament.players.size} players! Generated ${tournament.rounds.length} rounds.` });
    } else if (customId === 'admin_allocate') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await allocateRound(interaction.guild);
      if (!result.success) {
        await interaction.editReply({ content: result.message });
        return;
      }
      await interaction.editReply({ content: result.message });
    } else if (customId === 'admin_scores') {
      const scoreList = Array.from(tournament.scores.entries()).map(([id, score]) => `<@${id}>: ${score}`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle('Current Scores')
        .setDescription(scoreList || 'No scores yet.')
        .setColor(0xff9900);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else if (customId === 'admin_adjust_score') {
      const modal = new ModalBuilder()
        .setCustomId('adjust_score_modal')
        .setTitle('Adjust Player Score');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('adjust_player_id')
            .setLabel('Player ID or @mention')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('e.g. 123456789012345678'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('adjust_delta')
            .setLabel('Points to add (use negative to subtract)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('e.g. 3 or -2'),
        ),
      );
      await interaction.showModal(modal);
    } else if (customId === 'admin_reset') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Capture message/channel IDs before wiping them so we can update the embed after reset
      const prevSetupMessage = tournament.setupMessage;
      const prevSetupChannelId = tournament.setupChannelId;

      clearRoundTimers();
      clearRemovalTimer();
      tournament = {
        players: new Set(),
        currentRound: 0,
        currentRoundIndex: 0,
        playedGroupings: new Set(),
        scores: new Map(),
        currentGrouping: null,
        activeMatches: [],
        roundResults: [],
        roundDeadline: null,
        setupMessage: prevSetupMessage,
        setupChannelId: prevSetupChannelId,
        rounds: [],
        started: false,
        history: [],
        playerNames: {},
        tournamentStartedAt: null,
        roundStartedAt: null,
        leftPlayers: {},
        pendingRemoval: null,
        signupsReopened: false,
        signupReopenMessageId: null,
      };
      await saveTournamentData();

      // Update the signup embed to show the cleared player list
      if (prevSetupMessage && prevSetupChannelId) {
        try {
          const channel = await interaction.guild.channels.fetch(prevSetupChannelId).catch(() => null);
          if (channel) {
            const message = await channel.messages.fetch(prevSetupMessage).catch(() => null);
            if (message) {
              const signupRow = new ActionRowBuilder()
                .addComponents(
                  new ButtonBuilder()
                    .setCustomId('signup')
                    .setLabel('Sign Up')
                    .setStyle(ButtonStyle.Primary),
                  new ButtonBuilder()
                    .setLabel('🌐 Website')
                    .setStyle(ButtonStyle.Link)
                    .setURL(getWebBaseUrl()),
                );
              const resetEmbed = new EmbedBuilder()
                .setTitle('Codenames Tournament')
                .setDescription(buildSignupDescription())
                .setColor(0x0099ff);
              await message.edit({ embeds: [resetEmbed], components: [signupRow] });
            }
          }
        } catch (error) {
          console.error('[admin_reset] Failed to update signup message:', error.message);
        }
      }

      await interaction.editReply({ content: 'Tournament reset.' });
    } else if (customId === 'debug_seed_players') {
      if (process.env.DEBUG_MODE !== 'true') {
        await interaction.reply({ content: 'Debug mode is not enabled.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (tournament.started) {
        await interaction.reply({ content: 'Cannot seed players after tournament has started.', flags: MessageFlags.Ephemeral });
        return;
      }
      const debugPlayerCount = parseInt(process.env.DEBUG_PLAYER_COUNT) || 8;
      // Use fake snowflake-style IDs for debug players
      const seedCount = Math.max(0, debugPlayerCount - tournament.players.size);
      for (let i = 0; i < seedCount; i++) {
        tournament.players.add(`debug_player_${Date.now()}_${i}`);
      }
      await saveTournamentData();
      updateSignupMessage(interaction.channel); // fire-and-forget
      await interaction.reply({ content: `[DEBUG] Seeded ${seedCount} fake player(s). Total players: ${tournament.players.size}`, flags: MessageFlags.Ephemeral });
    } else if (customId.startsWith('log_')) {
      const matchData = tournament.activeMatches.find(m => m.threadId === interaction.channelId);
      if (!matchData) {
        await interaction.reply({ content: 'No active match found for this thread.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Only players in this game or admins may submit results
      const adminRoleId = process.env.ADMIN_ROLE_ID;
      const isAdmin = interaction.member.roles.cache.has(adminRoleId);
      const { grouping } = matchData;
      const matchPlayers = [grouping.blue.spymaster, grouping.blue.guesser, grouping.red.spymaster, grouping.red.guesser];
      if (!isAdmin && !matchPlayers.includes(interaction.user.id)) {
        await interaction.reply({ content: 'You are not a player in this game and cannot submit the result.', flags: MessageFlags.Ephemeral });
        return;
      }

      const logMatch = customId.match(/^log_(blue|red)_win(?:_g(\d+))?$/);
      if (!logMatch) {
        await interaction.reply({ content: 'Invalid result button.', flags: MessageFlags.Ephemeral });
        return;
      }
      const winner = logMatch[1] === 'blue' ? 'blue' : 'red';
      const expectedPhase = logMatch[2] ? parseInt(logMatch[2], 10) : 1;
      const currentPhase = matchData.gamePhase ?? 1;
      if (currentPhase !== expectedPhase) {
        await interaction.reply({ content: `These buttons are for Game ${expectedPhase}, but this match is currently on Game ${currentPhase}.`, flags: MessageFlags.Ephemeral });
        return;
      }

      // Deduplication guard — prevent two simultaneous button clicks for the same game.
      // JavaScript is single-threaded so has() + add() with no await between is atomic.
      const submissionKey = `${interaction.channelId}:${expectedPhase}:button`;
      if (processingThreads.has(submissionKey)) {
        await interaction.reply({ content: 'A result is already being submitted for this game. Please wait.', flags: MessageFlags.Ephemeral });
        return;
      }
      processingThreads.add(submissionKey);

      // Show buttons for assassin question instead of modal
      const assassinRow = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`assassin_yes_${winner}_${expectedPhase}`)
            .setLabel('Yes, Assassin Hit')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`assassin_no_${winner}_${expectedPhase}`)
            .setLabel('No, Not Assassin')
            .setStyle(ButtonStyle.Primary),
        );

      try {
        await interaction.reply({ content: `Game ${expectedPhase}: Was the winning move an assassin hit?`, components: [assassinRow], flags: MessageFlags.Ephemeral });
      } finally {
        processingThreads.delete(submissionKey);
      }
    } else if (customId.startsWith('assassin_')) {
      const parts = customId.split('_');
      const wasAssassin = parts[1] === 'yes';
      const winner = parts[2];
      const expectedPhase = parts[3] ? parseInt(parts[3]) : 1;

      const matchData2 = tournament.activeMatches.find(m => m.threadId === interaction.channelId);
      if (!matchData2) {
        await interaction.reply({ content: 'Could not find an active match for this thread.', flags: MessageFlags.Ephemeral });
        return;
      }

      const adminRoleId = process.env.ADMIN_ROLE_ID;
      const isAdmin2 = interaction.member.roles.cache.has(adminRoleId);
      const g2 = matchData2.grouping;
      const matchPlayers2 = [g2.blue.spymaster, g2.blue.guesser, g2.red.spymaster, g2.red.guesser];
      if (!isAdmin2 && !matchPlayers2.includes(interaction.user.id)) {
        await interaction.reply({ content: 'You are not a player in this game.', flags: MessageFlags.Ephemeral });
        return;
      }

      if ((matchData2.gamePhase ?? 1) !== expectedPhase) {
        await interaction.reply({ content: `Cannot submit — this match is on Game ${matchData2.gamePhase ?? 1}, not Game ${expectedPhase}.`, flags: MessageFlags.Ephemeral });
        return;
      }

      // Deduplication guard for the assassin→result step
      const resultProcessingKey = `${interaction.channelId}:${expectedPhase}:result`;
      if (processingThreads.has(resultProcessingKey)) {
        await interaction.reply({ content: 'A result is already being submitted for this game. Please wait.', flags: MessageFlags.Ephemeral });
        return;
      }
      processingThreads.add(resultProcessingKey); // synchronous

      if (wasAssassin) {
        try {
          await processGameResult(interaction, matchData2, winner, true, 0);
        } finally {
          processingThreads.delete(resultProcessingKey);
        }
        return;
      }

      // Not an assassin — show modal for remaining cards
      processingThreads.delete(resultProcessingKey); // modal submission is a separate interaction
      const modal = new ModalBuilder()
        .setCustomId(`outcome_modal_${winner}_normal_${expectedPhase}`)
        .setTitle(`${winner === 'blue' ? 'Blue' : 'Red'} Won — Game ${expectedPhase} Details`);

      const remainingCardsInput = new TextInputBuilder()
        .setCustomId('remaining_cards')
        .setLabel('Cards remaining? (0-8)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(1)
        .setRequired(true)
        .setPlaceholder('e.g. 3');

      const firstActionRow = new ActionRowBuilder().addComponents(remainingCardsInput);
      modal.addComponents(firstActionRow);

      await interaction.showModal(modal);
    } else if (customId.startsWith('cnb_ok_') || customId.startsWith('cnb_no_')) {
      const accept = customId.startsWith('cnb_ok_');
      const pendingId = customId.slice('cnb_ok_'.length);
      const matchData = tournament.activeMatches.find(m => m.threadId === interaction.channelId);
      const pending = matchData && matchData.pendingBridgeResults && matchData.pendingBridgeResults[pendingId];
      if (!pending) {
        await interaction.reply({ content: 'This detected result is no longer pending.', flags: MessageFlags.Ephemeral });
        return;
      }
      const isAdmin = interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID);
      const g = matchData.grouping;
      if (!isAdmin && ![g.blue.spymaster, g.blue.guesser, g.red.spymaster, g.red.guesser].includes(interaction.user.id)) {
        await interaction.reply({ content: 'Only the players in this match or an admin can do that.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!accept) {
        delete matchData.pendingBridgeResults[pendingId];
        await saveTournamentData();
        await interaction.update({ content: `Dismissed by <@${interaction.user.id}>.`, components: [] });
        return;
      }
      const currentPhase = matchData.gamePhase ?? 1;
      if (currentPhase !== pending.gamePhase) {
        delete matchData.pendingBridgeResults[pendingId];
        await saveTournamentData();
        await interaction.update({ content: `Not logged: this match has moved on to Game ${currentPhase}.`, components: [] });
        return;
      }
      const confirmKey = `${interaction.channelId}:${currentPhase}:result`;
      if (processingThreads.has(confirmKey)) {
        await interaction.reply({ content: 'A result is already being submitted for this game. Please wait.', flags: MessageFlags.Ephemeral });
        return;
      }
      processingThreads.add(confirmKey);
      try {
        delete matchData.pendingBridgeResults[pendingId];
        await interaction.update({ content: `Confirmed by <@${interaction.user.id}>.`, components: [] });
        await recordGameResult({
          guild: interaction.guild,
          channel: interaction.channel,
          submittedBy: interaction.user.id,
          source: 'codenames-bridge-confirmed',
          detail: pending.detail || null,
          reply: (content) => interaction.followUp({ content }),
        }, matchData, pending.winner, pending.assassin, pending.remainingCards);
      } finally {
        processingThreads.delete(confirmKey);
      }
    } else if (customId.startsWith('correct_result_')) {
      // Result correction has been moved to the tournament website admin panel.
      await interaction.reply({
        content: `⚠️ Result corrections can no longer be made from Discord. Please visit the **tournament website** and log in as admin to correct this result.`,
        flags: MessageFlags.Ephemeral,
      });
    } else if (customId.startsWith('confirm_remove_')) {
      const userId = customId.split('_')[2];
      if (interaction.user.id === userId) {
        tournament.players.delete(userId);
        await interaction.reply({ content: 'You have been removed from the tournament.', flags: MessageFlags.Ephemeral });
        await saveTournamentData();
        updateSignupMessage(interaction.channel); // fire-and-forget
      } else {
        await interaction.reply({ content: 'You cannot confirm removal for another user.', flags: MessageFlags.Ephemeral });
      }
    } else if (customId.startsWith('cancel_remove_')) {
      const userId = customId.split('_')[2];
      if (interaction.user.id === userId) {
        await interaction.reply({ content: 'Cancelled. You remain signed up.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'This button is not for you.', flags: MessageFlags.Ephemeral });
      }

    // ── Leave tournament (player-initiated, mid-tournament) ──────────────────
    } else if (customId === 'leave_tournament') {
      if (!tournament.started) {
        await interaction.reply({ content: 'The tournament has not started yet.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!tournament.players.has(interaction.user.id)) {
        await interaction.reply({ content: 'You are not currently in the tournament.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (tournament.pendingRemoval) {
        await interaction.reply({ content: `Another player's removal is already pending confirmation. Please wait until it resolves.`, flags: MessageFlags.Ephemeral });
        return;
      }
      const channel = await interaction.guild.channels.fetch(tournament.setupChannelId).catch(() => null);
      if (!channel) {
        await interaction.reply({ content: 'Could not find the tournament channel.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const hasActiveMatch = tournament.activeMatches.some(m =>
        [m.grouping.blue.spymaster, m.grouping.blue.guesser, m.grouping.red.spymaster, m.grouping.red.guesser].includes(interaction.user.id)
      );
      const activeMatchNote = hasActiveMatch
        ? '\n\n⚠️ You have an active match in progress — if you leave, that match will continue and count toward scores. Future rounds will not include you.'
        : '';
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_leave_${interaction.user.id}`)
          .setLabel('✅ Yes, Leave Tournament')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`cancel_leave_${interaction.user.id}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );
      const confirmMsg = await channel.send({
        content: `⚠️ <@${interaction.user.id}> has requested to leave the tournament. <@${interaction.user.id}>, please confirm within 15 minutes by clicking the button below.${activeMatchNote}`,
        components: [confirmRow],
      });
      tournament.pendingRemoval = {
        userId: interaction.user.id,
        confirmMessageId: confirmMsg.id,
        requestedAt: new Date().toISOString(),
      };
      await saveTournamentData();
      scheduleRemovalTimeout(interaction.guild);
      await interaction.editReply({ content: 'Your leave request has been posted in the tournament channel. Please confirm within 15 minutes.' });

    // ── Confirm leave (player confirms their own removal) ────────────────────
    } else if (customId.startsWith('confirm_leave_')) {
      const userId = customId.slice('confirm_leave_'.length);
      if (interaction.user.id !== userId) {
        await interaction.reply({ content: 'This confirmation is not for you.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!tournament.pendingRemoval || tournament.pendingRemoval.userId !== userId) {
        await interaction.reply({ content: 'No pending leave request found. It may have already been processed or expired.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { confirmMessageId } = tournament.pendingRemoval;
      const leaveDisplayName = tournament.playerNames[userId] || userId;
      const leaveScore = tournament.scores.get(userId) || 0;
      tournament.leftPlayers[userId] = { displayName: leaveDisplayName, leftAt: new Date().toISOString(), score: leaveScore };
      tournament.players.delete(userId);
      tournament.scores.delete(userId);
      clearRemovalTimer();
      tournament.pendingRemoval = null;
      const activePlayers = Array.from(tournament.players);
      recalculateFutureRounds(activePlayers);
      await saveTournamentData();
      const leaveChannel = await interaction.guild.channels.fetch(tournament.setupChannelId).catch(() => null);
      if (leaveChannel) {
        try {
          const prevMsg = await leaveChannel.messages.fetch(confirmMessageId).catch(() => null);
          if (prevMsg) await prevMsg.delete().catch(() => null);
        } catch {}
        const remaining = activePlayers.length;
        await leaveChannel.send(`✅ <@${userId}> has left the tournament. Future rounds have been recalculated with ${remaining} remaining player${remaining !== 1 ? 's' : ''}. ${tournament.rounds.length} total rounds now planned.`);
      }
      updateScoreboard(interaction.guild).catch(() => null);
      if (tournament.activeMatches.length === 0 && tournament.currentRound <= tournament.rounds.length) {
        allocateRound(interaction.guild).catch(e => console.error('[leave] Auto-allocate failed:', e.message));
      }
      await interaction.editReply({ content: '✅ You have left the tournament. Goodbye!' });

    // ── Cancel leave ─────────────────────────────────────────────────────────
    } else if (customId.startsWith('cancel_leave_')) {
      const userId = customId.slice('cancel_leave_'.length);
      if (interaction.user.id !== userId) {
        await interaction.reply({ content: 'This button is not for you.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!tournament.pendingRemoval || tournament.pendingRemoval.userId !== userId) {
        await interaction.reply({ content: 'No pending leave request found.', flags: MessageFlags.Ephemeral });
        return;
      }
      const { confirmMessageId: cancelMsgId } = tournament.pendingRemoval;
      clearRemovalTimer();
      tournament.pendingRemoval = null;
      await saveTournamentData();
      const cancelChannel = await interaction.guild.channels.fetch(tournament.setupChannelId).catch(() => null);
      if (cancelChannel) {
        try {
          const prevMsg = await cancelChannel.messages.fetch(cancelMsgId).catch(() => null);
          if (prevMsg) await prevMsg.delete().catch(() => null);
        } catch {}
        await cancelChannel.send(`❌ <@${userId}> has chosen to stay in the tournament.`);
      }
      await interaction.reply({ content: '❌ Your leave request has been cancelled. You remain in the tournament.', flags: MessageFlags.Ephemeral });

    // ── Reopen signup (player joins during mid-tournament signup window) ──────
    } else if (customId === 'reopen_signup') {
      if (!tournament.signupsReopened) {
        await interaction.reply({ content: 'Signups are not currently open.', flags: MessageFlags.Ephemeral });
        return;
      }
      const userId = interaction.user.id;
      if (tournament.players.has(userId)) {
        await interaction.reply({ content: 'You are already in the tournament!', flags: MessageFlags.Ephemeral });
        return;
      }
      tournament.players.add(userId);
      tournament.scores.set(userId, 0);
      try {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        tournament.playerNames[userId] = member ? member.displayName : userId;
      } catch { tournament.playerNames[userId] = userId; }
      if (tournament.leftPlayers[userId]) {
        const { [userId]: _removed, ...rest } = tournament.leftPlayers;
        tournament.leftPlayers = rest;
      }
      await saveTournamentData();
      await interaction.reply({ content: `✅ You have joined the tournament! You'll be included in future rounds once signups close.`, flags: MessageFlags.Ephemeral });

    // ── Close signups (admin, from the channel message button) ───────────────
    } else if (customId === 'close_signups') {
      const adminRoleId = process.env.ADMIN_ROLE_ID;
      if (!interaction.member.roles.cache.has(adminRoleId)) {
        await interaction.reply({ content: 'Only admins can close signups.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!tournament.signupsReopened) {
        await interaction.reply({ content: 'Signups are not currently open.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await closeSignups(interaction.guild);
      await interaction.editReply({ content: `✅ Signups closed. Future rounds recalculated.` });

    // ── Admin reopen signups (from the Discord admin panel) ──────────────────
    } else if (customId === 'admin_reopen_signups') {
      const adminRoleId = process.env.ADMIN_ROLE_ID;
      if (!interaction.member.roles.cache.has(adminRoleId)) {
        await interaction.reply({ content: 'You do not have permission.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!tournament.started) {
        await interaction.reply({ content: 'The tournament has not started yet.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (tournament.signupsReopened) {
        // Toggle: close signups
        await closeSignups(interaction.guild);
        await interaction.editReply({ content: `✅ Signups closed. Future rounds recalculated.` });
      } else {
        // Open signups
        const channel = await interaction.guild.channels.fetch(tournament.setupChannelId).catch(() => null);
        if (!channel) { await interaction.editReply({ content: 'Could not find the tournament channel.' }); return; }
        const reopenRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('reopen_signup').setLabel('✅ Join Tournament').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('close_signups').setLabel('🔒 Close Signups (Admin)').setStyle(ButtonStyle.Danger),
        );
        const msg = await channel.send({
          content: '📋 **Signups are reopened!** Click below to join the tournament. New rounds won\'t start until signups are closed by an admin.',
          components: [reopenRow],
        });
        tournament.signupsReopened = true;
        tournament.signupReopenMessageId = msg.id;
        await saveTournamentData();
        updateScoreboard(interaction.guild).catch(() => null);
        await interaction.editReply({ content: '✅ Signups have been reopened. A message has been posted in the tournament channel.' });
      }

    // ── Admin fix match-ups ───────────────────────────────────────────────────
    } else if (customId === 'admin_fix_matchups') {
      const adminRoleId = process.env.ADMIN_ROLE_ID;
      if (!interaction.member.roles.cache.has(adminRoleId)) {
        await interaction.reply({ content: 'You do not have permission.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!tournament.started) {
        await interaction.reply({ content: 'The tournament has not started yet.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await fixMatchups(interaction.guild);
      await interaction.editReply({ content: `✅ ${describeFixMatchups(result)}` });
    }
  } else if (interaction.isModalSubmit()) {
    const { customId } = interaction;
    if (customId.startsWith('outcome_modal_')) {
      const parts = customId.split('_');
      const winner = parts[2]; // blue or red
      const assassin = parts[3] === 'assassin';
      const gamePhase = parts[4] ? parseInt(parts[4]) : 1;

      // Deduplication guard for the modal→result step
      const modalProcessingKey = `${interaction.channelId}:${gamePhase}:result`;
      if (processingThreads.has(modalProcessingKey)) {
        await interaction.reply({ content: 'A result is already being submitted for this game. Please wait.', flags: MessageFlags.Ephemeral });
        return;
      }
      processingThreads.add(modalProcessingKey); // synchronous

      try {
        const remainingCardsValue = interaction.fields.getTextInputValue('remaining_cards');
        const remainingCards = parseInt(remainingCardsValue);

        if (isNaN(remainingCards) || remainingCards < 0 || remainingCards > 8) {
          await interaction.reply({ content: 'Invalid number of remaining cards. Must be 0-8.', flags: MessageFlags.Ephemeral });
          return;
        }

        const matchData = tournament.activeMatches.find(m => m.threadId === interaction.channelId);
        if (!matchData) {
          await interaction.reply({ content: 'Could not find an active match for this thread. It may have already been completed.', flags: MessageFlags.Ephemeral });
          return;
        }

        if ((matchData.gamePhase ?? 1) !== gamePhase) {
          await interaction.reply({ content: `This submission is for Game ${gamePhase}, but the match is on Game ${matchData.gamePhase ?? 1}.`, flags: MessageFlags.Ephemeral });
          return;
        }

        await processGameResult(interaction, matchData, winner, assassin, remainingCards);
      } catch (error) {
        console.error('Error processing outcome:', error);
        try {
          await interaction.reply({ content: 'An error occurred while processing the outcome. Please try again.', flags: MessageFlags.Ephemeral });
        } catch {}
      } finally {
        processingThreads.delete(modalProcessingKey);
      }
    } else if (customId === 'adjust_score_modal') {
      const rawId = interaction.fields.getTextInputValue('adjust_player_id').trim().replace(/[<@!>]/g, '');
      const delta = parseInt(interaction.fields.getTextInputValue('adjust_delta').trim());
      if (isNaN(delta)) {
        await interaction.reply({ content: 'Invalid points value. Please enter a number like `3` or `-2`.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!tournament.scores.has(rawId)) {
        await interaction.reply({ content: `No score found for player ID \`${rawId}\`. Make sure you used the raw numeric ID.`, flags: MessageFlags.Ephemeral });
        return;
      }
      const oldScore = tournament.scores.get(rawId);
      tournament.scores.set(rawId, oldScore + delta);
      await saveTournamentData();
      updateScoreboard(interaction.guild).catch(() => null);
      await interaction.reply({ content: `Score adjusted: <@${rawId}> ${oldScore} → **${oldScore + delta} pts** (${delta > 0 ? '+' : ''}${delta})`, flags: MessageFlags.Ephemeral });
    }
  }
});

async function updateScoreboard(guild) {
  if (!tournament.setupMessage || !tournament.setupChannelId) return;
  try {
    const channel = await guild.channels.fetch(tournament.setupChannelId).catch(() => null);
    if (!channel) return;
    const message = await channel.messages.fetch(tournament.setupMessage).catch(() => null);
    if (!message) return;

    let description;
    const fields = [];
    const gamesPlayedMap = getGamesPlayedMap();
    if (tournament.currentRound > tournament.rounds.length) {
      description = `**Tournament Complete!**\n\n**Final Scoreboard:**\n`;
      let rankF = 0;
      let lastPtsF = null;
      Array.from(tournament.scores.entries())
        .sort((a, b) => b[1] - a[1])
        .forEach((entry, idx) => {
          if (entry[1] !== lastPtsF) { rankF = idx + 1; lastPtsF = entry[1]; }
          const gp = gamesPlayedMap[entry[0]] || 0;
          description += `${rankF}. <@${entry[0]}> - ${entry[1]} pts (${gp} game${gp !== 1 ? 's' : ''})\n`;
        });
    } else {
      const roundMatches = tournament.rounds[tournament.currentRound - 1] || [];
      const completedInRound = roundMatches.length - tournament.activeMatches.length;
      description = `**Tournament Live - Round ${tournament.currentRound}/${tournament.rounds.length}**\n`;
      description += `${completedInRound}/${roundMatches.length} matches completed\n\n`;
      if (tournament.activeMatches.length > 0) {
        description += `**⚔️ Active Matches:**\n`;
        tournament.activeMatches.forEach(m => {
          const activePhase = m.gamePhase ?? 1;
          const gamesPerMatch = getMatchGameCount(m);
          const activeGrouping = getGroupingForMatchGame(m, activePhase);
          fields.push({
            name: `Match ${m.matchNumber} — Game ${activePhase}/${gamesPerMatch}`,
            value: `🔵 <@${activeGrouping.blue.spymaster}> & <@${activeGrouping.blue.guesser}>\nvs 🔴 <@${activeGrouping.red.spymaster}> & <@${activeGrouping.red.guesser}>`,
            inline: true,
          });
        });
      }
      description += `**Scoreboard:**\n`;
      let rankL = 0;
      let lastPtsL = null;
      Array.from(tournament.scores.entries())
        .sort((a, b) => b[1] - a[1])
        .forEach((entry, idx) => {
          if (entry[1] !== lastPtsL) { rankL = idx + 1; lastPtsL = entry[1]; }
          const gp = gamesPlayedMap[entry[0]] || 0;
          description += `${rankL}. <@${entry[0]}> - ${entry[1]} pts (${gp} game${gp !== 1 ? 's' : ''})\n`;
        });
    }

    const websiteRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('🌐 Website').setStyle(ButtonStyle.Link).setURL(getWebBaseUrl()),
      new ButtonBuilder().setCustomId('leave_tournament').setLabel('🚪 Leave Tournament').setStyle(ButtonStyle.Danger),
    );
    const updatedEmbed = EmbedBuilder.from(message.embeds[0]).setDescription(description).setFields(fields);
    await message.edit({ embeds: [updatedEmbed], components: [websiteRow] });
  } catch (error) {
    console.error('[updateScoreboard] Failed:', error.message);
  }
}

async function allocateRound(guild) {
  if (!tournament.started || tournament.rounds.length === 0) {
    return { success: false, message: 'Tournament has not been started. Use the Start button first.' };
  }
  if (tournament.currentRound > tournament.rounds.length) {
    return { success: false, message: `All ${tournament.rounds.length} rounds have been completed!` };
  }
  if (tournament.activeMatches.length > 0) {
    return { success: false, message: `Round ${tournament.currentRound} is already in progress. ${tournament.activeMatches.length} match(es) still active.` };
  }
  if (tournament.pendingRemoval) {
    return { success: false, message: 'A player removal is pending confirmation. Waiting before starting the next round.' };
  }
  if (tournament.signupsReopened) {
    return { success: false, message: 'Signups are currently open. Close signups before advancing to the next round.' };
  }

  const currentRoundMatches = tournament.rounds[tournament.currentRound - 1];
  if (!currentRoundMatches || currentRoundMatches.length === 0) {
    return { success: false, message: `Round ${tournament.currentRound} has no matches.` };
  }

  // Always use the main tournament channel, not any thread channel
  const mainChannel = await guild.channels.fetch(tournament.setupChannelId).catch(() => null);
  if (!mainChannel) return { success: false, message: 'Could not find the tournament channel.' };

  // Clean up channel and post round summary when starting a subsequent round
  if (tournament.currentRound > 1) {
    try {
      const channel = mainChannel;
      const messages = await channel.messages.fetch({ limit: 100 });
      const toDelete = messages.filter(msg => msg.id !== tournament.setupMessage);
      for (const msg of toDelete.values()) await msg.delete().catch(() => null);

      const completedRound = tournament.currentRound - 1;
      const summaryEmbed = new EmbedBuilder()
        .setTitle(`📊 Round ${completedRound} Complete!`)
        .setColor(0x0099ff);

      const results = tournament.roundResults.slice().sort((a, b) => a.matchNumber - b.matchNumber || (a.gameIndex || 1) - (b.gameIndex || 1));
      // One field per match (Discord allows 25 fields), one line per game.
      const byMatch = new Map();
      for (const r of results) {
        if (!byMatch.has(r.matchNumber)) byMatch.set(r.matchNumber, []);
        byMatch.get(r.matchNumber).push(r);
      }
      for (const [matchNumber, games] of Array.from(byMatch).slice(0, 25)) {
        const blueWins = games.filter(r => r.winner === 'blue').length;
        const lines = games.map(r => {
          const howStr = r.assassin ? 'assassin' : `${r.remainingCards} left`;
          const winners = r.winner === 'blue' ? r.grouping.blue : r.grouping.red;
          const pts = `+${r.winPoints} / ${r.losePoints > 0 ? '+' : ''}${r.losePoints}`;
          return `G${r.gameIndex || 1} ${r.winner === 'blue' ? '🔵' : '🔴'} <@${winners.spymaster}> & <@${winners.guesser}> (${howStr}, ${pts})`;
        });
        summaryEmbed.addFields({
          name: `Match ${matchNumber} — 🔵 ${blueWins} · 🔴 ${games.length - blueWins}`,
          value: lines.join('\n').slice(0, 1024),
        });
      }
      if (results.length === 0) summaryEmbed.setDescription('No match results recorded.');
      await channel.send({ embeds: [summaryEmbed] });

      // Clear results only after the summary has been successfully posted
      tournament.roundResults = [];
      await saveTournamentData();
    } catch (e) {
      console.error('Failed to post round summary:', e.message);
      // Still clear roundResults so the next round starts cleanly, but log the failure
      tournament.roundResults = [];
      await saveTournamentData().catch(() => null);
    }
  }

  // Allocate all matches in this round simultaneously
  const channel = mainChannel;

  // Post round header with deadline (deadline is set just after the loop, so compute it now for display)
  const timeoutDaysHeader = parseFloat(process.env.ROUND_TIMEOUT_DAYS) || 14;
  const deadlineMs = Date.now() + timeoutDaysHeader * 24 * 60 * 60 * 1000;
  const deadlineTs = Math.floor(deadlineMs / 1000);
  const headerEmbed = new EmbedBuilder()
    .setTitle(`📋 Round ${tournament.currentRound} — ${currentRoundMatches.length} Match${currentRoundMatches.length !== 1 ? 'es' : ''}`)
    .setDescription(`Complete all games below before <t:${deadlineTs}:F> (<t:${deadlineTs}:R>).`)
    .setColor(0x5865f2);
  await channel.send({ embeds: [headerEmbed] });

  for (let i = 0; i < currentRoundMatches.length; i++) {
    const roundEntry = getRoundMatchEntry(currentRoundMatches[i]);
    const grouping = roundEntry.grouping;
    const matchNumber = i + 1;
    const gamesPerMatch = roundEntry.gamesPlanned;
    const phaseSequence = roundEntry.phaseSequence;
    const games = roundEntry.games || getMatchGames(roundEntry);
    const firstGrouping = games[0];

    const embed = new EmbedBuilder()
      .setTitle(`Round ${tournament.currentRound} — Match ${matchNumber}`)
      .setDescription(
        `${scheduler.playersOf(grouping).map(id => `<@${id}>`).join(' · ')}\n` +
        `${gamesPerMatch} game${gamesPerMatch !== 1 ? 's' : ''} — line-ups are posted in the thread.`
      )
      .setColor(0x0099ff);

    try {
      await channel.send({ embeds: [embed] });

      const thread = await channel.threads.create({
        name: `R${tournament.currentRound}M${matchNumber} Game`,
        autoArchiveDuration: 10080,
        reason: 'Tournament game thread',
      });

      const threadEmbed = new EmbedBuilder()
        .setTitle(`Round ${tournament.currentRound} \u2014 Match ${matchNumber} (Game 1 of ${gamesPerMatch})`)
        .setDescription(
          `**Blue Team:**\nSpymaster: <@${firstGrouping.blue.spymaster}>\nGuesser: <@${firstGrouping.blue.guesser}>\n\n` +
          `**Red Team:**\nSpymaster: <@${firstGrouping.red.spymaster}>\nGuesser: <@${firstGrouping.red.guesser}>\n\nPlay Game 1 then log the result below.${bridgeThreadHint()}`
        )
        .setColor(0x00ff00);
      if (games.length > 1) threadEmbed.addFields({ name: 'Match plan', value: formatMatchPlan(games) });

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId('log_blue_win').setLabel('Blue Wins').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('log_red_win').setLabel('Red Wins').setStyle(ButtonStyle.Danger),
        );

      await thread.send({ embeds: [threadEmbed], components: [row] });
      tournament.activeMatches.push({ grouping, games: roundEntry.games || undefined, gamesPlanned: gamesPerMatch, phaseSequence: roundEntry.games ? undefined : phaseSequence, threadId: thread.id, matchNumber, gamePhase: 1, game1Result: null, phaseResults: {}, matchCreatedAt: new Date().toISOString() });
    } catch (e) {
      console.error(`Failed to create thread for match ${matchNumber}:`, e.message);
    }
  }

  if (tournament.activeMatches.length === 0) {
    return { success: false, message: 'Failed to create any game threads. Check bot permissions.' };
  }

  // Set round deadline and schedule warning + expiry timers
  const timeoutDays = parseFloat(process.env.ROUND_TIMEOUT_DAYS) || 14;
  tournament.roundDeadline = Date.now() + timeoutDays * 24 * 60 * 60 * 1000;
  tournament.roundStartedAt = new Date().toISOString();
  await saveTournamentData();
  scheduleRoundTimers(guild);
  startThreadKeepAlive(guild);
  return { success: true, message: `Round ${tournament.currentRound} allocated with ${tournament.activeMatches.length} match(es).` };
}


function clearRoundTimers() {
  if (roundWarningTimer)   { clearTimeout(roundWarningTimer);   roundWarningTimer   = null; }
  if (roundExpiryTimer)    { clearTimeout(roundExpiryTimer);    roundExpiryTimer    = null; }
  if (threadKeepAliveTimer){ clearTimeout(threadKeepAliveTimer); threadKeepAliveTimer = null; }
}

function clearRemovalTimer() {
  if (removalTimeoutTimer) { clearTimeout(removalTimeoutTimer); removalTimeoutTimer = null; }
}

function scheduleRemovalTimeout(guild) {
  clearRemovalTimer();
  removalTimeoutTimer = setTimeout(() => {
    cancelPendingRemoval(guild, 'timeout').catch(e => console.error('[removal-timeout]', e.message));
  }, REMOVAL_TIMEOUT_MS);
}

async function cancelPendingRemoval(guild, reason) {
  if (!tournament.pendingRemoval) return;
  const { userId, confirmMessageId } = tournament.pendingRemoval;
  clearRemovalTimer();
  tournament.pendingRemoval = null;
  await saveTournamentData();
  if (guild && tournament.setupChannelId) {
    try {
      const channel = await guild.channels.fetch(tournament.setupChannelId).catch(() => null);
      if (channel) {
        if (confirmMessageId) {
          try {
            const msg = await channel.messages.fetch(confirmMessageId).catch(() => null);
            if (msg) await msg.delete().catch(() => null);
          } catch {}
        }
        if (reason === 'timeout') {
          await channel.send(`⏰ No response — <@${userId}>'s leave request has expired. They remain in the tournament.`);
        }
      }
    } catch (e) { console.error('[cancelPendingRemoval]', e.message); }
  }
}

function deriveGroupingFromStoredRounds(entry) {
  const roundNumber = parseInt(entry?.roundNumber, 10);
  const matchNumber = parseInt(entry?.matchNumber, 10);
  const gamePhase = parseInt(entry?.gamePhase ?? entry?.game, 10) || 1;
  if (!roundNumber || !matchNumber) return null;
  const round = tournament.rounds[roundNumber - 1];
  if (!Array.isArray(round) || !round[matchNumber - 1]) return null;
  const roundEntry = getRoundMatchEntry(round[matchNumber - 1]);
  if (roundEntry.games) return roundEntry.games[(parseInt(entry?.game, 10) || 1) - 1] || null;
  if (!hasValidGrouping(roundEntry.grouping)) return null;
  return getGroupingForPhase(roundEntry.grouping, gamePhase);
}

function normalizeHistoryForScheduling(activePlayerSet) {
  const normalized = [];
  let reconstructionTriggered = false;
  let skippedEntries = 0;

  for (const entry of tournament.history) {
    let grouping = hasValidGrouping(entry?.grouping) ? entry.grouping : null;
    if (!grouping) {
      grouping = deriveGroupingFromStoredRounds(entry);
      if (grouping) reconstructionTriggered = true;
    }
    if (!hasValidGrouping(grouping)) {
      reconstructionTriggered = true;
      skippedEntries++;
      continue;
    }
    const players = [
      grouping.blue.spymaster,
      grouping.blue.guesser,
      grouping.red.spymaster,
      grouping.red.guesser,
    ];
    if (players.some(id => !activePlayerSet.has(id))) {
      continue;
    }
    normalized.push({ ...entry, grouping });
  }

  return { normalized, reconstructionTriggered, skippedEntries };
}

// Rounds each active player has sat out so far (rounds since they first
// played, or since round 1 for players who were there from the start).
function getSitOutCounts(activePlayers) {
  const playedIn = new Map(activePlayers.map(p => [p, new Set()]));
  for (const entry of tournament.history) {
    if (!hasValidGrouping(entry.grouping)) continue;
    for (const id of scheduler.playersOf(entry.grouping)) if (playedIn.has(id)) playedIn.get(id).add(entry.roundNumber);
  }
  const completedRounds = Math.max(0, tournament.currentRound - 1);
  const counts = new Map();
  for (const p of activePlayers) {
    const rounds = playedIn.get(p);
    const first = rounds.size > 0 ? Math.min(...rounds) : completedRounds + 1;
    const span = Math.max(0, completedRounds - Math.min(first, completedRounds + 1) + 1);
    counts.set(p, Math.max(0, span - rounds.size));
  }
  return counts;
}

// Recalculate all future (not-yet-started) rounds for the current players,
// using the 6-game format (src/scheduler.js). Everything already played
// (history) or in progress (active matches) counts, so groups only get the
// games they still owe. Completed rounds and any in-progress round are kept.
function recalculateFutureRounds(activePlayers) {
  const keepUntilIndex = tournament.activeMatches.length > 0
    ? tournament.currentRound   // rounds[0..currentRound-1] inclusive
    : tournament.currentRound - 1;
  if (activePlayers.length < 4) {
    // Not enough players for any new matches — trim future rounds so tournament ends naturally
    tournament.rounds = tournament.rounds.slice(0, keepUntilIndex);
    return;
  }

  const normalizedHistory = normalizeHistoryForScheduling(new Set(activePlayers));
  if (normalizedHistory.reconstructionTriggered) {
    const skippedLabel = normalizedHistory.skippedEntries === 1 ? 'entry' : 'entries';
    console.warn(`[scheduler] History reconstruction/audit applied for recalculation (skipped ${normalizedHistory.skippedEntries} invalid ${skippedLabel}).`);
  }
  const playedGroupings = normalizedHistory.normalized.map(entry => entry.grouping);
  for (const match of tournament.activeMatches) playedGroupings.push(...getMatchGames(match));

  const futureRounds = scheduler.generateSchedule(activePlayers, {
    playedGroupings,
    sitOutCounts: getSitOutCounts(activePlayers),
  });
  tournament.rounds = [
    ...tournament.rounds.slice(0, keepUntilIndex),
    ...futureRounds,
  ];
  console.log(`[scheduler] ${futureRounds.length} future round(s) planned for ${activePlayers.length} players.`);
}

// "Fix Matchups": rebuild every future round with the current scheduler,
// assuming the current round finishes as scheduled (its matches count as
// played). Also how a schedule from an older format is switched over.
async function fixMatchups(guild) {
  const before = tournament.rounds.length;
  recalculateFutureRounds(Array.from(tournament.players));
  await saveTournamentData();
  if (guild) updateScoreboard(guild).catch(() => null);
  const keptThrough = tournament.activeMatches.length > 0 ? tournament.currentRound : tournament.currentRound - 1;
  return { before, after: tournament.rounds.length, future: tournament.rounds.length - keptThrough, keptThrough };
}

function describeFixMatchups({ before, after, future, keptThrough }) {
  const kept = keptThrough > 0
    ? `Rounds 1–${keptThrough}${tournament.activeMatches.length > 0 ? ' (including the current round)' : ''} are unchanged. `
    : '';
  return `Future rounds recalculated with ${tournament.players.size} players. ${kept}` +
    `${future} round${future !== 1 ? 's' : ''} still to play (${before} → ${after} rounds in total).`;
}

// Shared logic for closing a mid-tournament signup window.
async function closeSignups(guild) {
  if (!tournament.signupsReopened) return;
  const channel = guild ? await guild.channels.fetch(tournament.setupChannelId).catch(() => null) : null;
  if (channel && tournament.signupReopenMessageId) {
    try {
      const msg = await channel.messages.fetch(tournament.signupReopenMessageId).catch(() => null);
      if (msg) await msg.delete().catch(() => null);
    } catch {}
  }
  const activePlayers = Array.from(tournament.players);
  tournament.signupsReopened = false;
  tournament.signupReopenMessageId = null;
  recalculateFutureRounds(activePlayers);
  await saveTournamentData();
  if (channel) {
    await channel.send(`✅ Signups closed with ${activePlayers.length} player${activePlayers.length !== 1 ? 's' : ''}. Future rounds have been recalculated — ${tournament.rounds.length} total round${tournament.rounds.length !== 1 ? 's' : ''} planned.`);
  }
  if (guild) {
    updateScoreboard(guild).catch(() => null);
    if (tournament.activeMatches.length === 0 && tournament.currentRound <= tournament.rounds.length) {
      allocateRound(guild).catch(e => console.error('[closeSignups] Auto-allocate failed:', e.message));
    }
  }
}

async function sendThreadKeepAlive(guild) {
  if (!tournament.started || tournament.activeMatches.length === 0) return;
  const msg = KEEPALIVE_MESSAGES[Math.floor(Math.random() * KEEPALIVE_MESSAGES.length)];
  if (bridgeClient.enabled) await pollBridgeStatus().catch(() => null);
  for (const match of tournament.activeMatches) {
    try {
      const thread = await guild.channels.fetch(match.threadId).catch(() => null);
      if (!thread) continue;
      // Unarchive if Discord auto-archived it
      if (thread.archived) await thread.setArchived(false).catch(() => null);
      // With live status, nudge about what's actually holding the match up;
      // games in progress are left to the BGA bot's own turn reminders.
      const g = match.grouping;
      const plan = bridgeClient.enabled
        ? codenamesBridge.planNudge({
          status: bridgeStatus[match.threadId],
          players: [g.blue.spymaster, g.blue.guesser, g.red.spymaster, g.red.guesser],
          game: match.gamePhase ?? 1,
          deadlineMs: tournament.roundDeadline,
          pendingConfirmations: Object.keys(match.pendingBridgeResults || {}).length,
        })
        : { action: 'fallback' };
      if (plan.action === 'skip') continue;
      if (plan.action === 'send') {
        await thread.send({ content: plan.content, allowedMentions: { users: plan.users } });
      } else {
        await thread.send(msg);
      }
    } catch (e) { console.error(`[keepalive] Thread ${match.threadId} failed:`, e.message); }
  }
  // Schedule next keep-alive in 2–3 days (random to avoid predictability)
  scheduleNextKeepAlive(guild);
}

function scheduleNextKeepAlive(guild) {
  if (threadKeepAliveTimer) { clearTimeout(threadKeepAliveTimer); threadKeepAliveTimer = null; }
  if (!tournament.started || tournament.activeMatches.length === 0) return;
  // Random delay between 2 and 3 days in ms
  const TWO_DAYS   = 2 * 24 * 60 * 60 * 1000;
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
  const delay = TWO_DAYS + Math.random() * (THREE_DAYS - TWO_DAYS);
  threadKeepAliveTimer = setTimeout(() => {
    sendThreadKeepAlive(guild).catch(e => console.error('[keepalive] Failed:', e.message));
  }, delay);
}

function startThreadKeepAlive(guild) {
  scheduleNextKeepAlive(guild);
}

function scheduleRoundTimers(guild) {
  clearRoundTimers();
  if (!tournament.roundDeadline) return;
  const now = Date.now();
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
  const warnAt   = tournament.roundDeadline - TWO_DAYS;
  const expireAt = tournament.roundDeadline;

  if (expireAt <= now) {
    // Already expired — fire immediately
    sendRoundExpiry(guild).catch(e => console.error('[timer] Expiry failed:', e.message));
    return;
  }

  if (warnAt > now) {
    roundWarningTimer = setTimeout(() => {
      sendRoundWarning(guild).catch(e => console.error('[timer] Warning failed:', e.message));
    }, warnAt - now);
  }

  roundExpiryTimer = setTimeout(() => {
    sendRoundExpiry(guild).catch(e => console.error('[timer] Expiry failed:', e.message));
  }, expireAt - now);
}

async function sendRoundWarning(guild) {
  if (!tournament.started || tournament.activeMatches.length === 0) return;
  const ts = Math.floor(tournament.roundDeadline / 1000);
  for (const match of tournament.activeMatches) {
    try {
      const thread = await guild.channels.fetch(match.threadId).catch(() => null);
      if (!thread) continue;
      if (thread.archived) await thread.setArchived(false).catch(() => null);
      await thread.send(`⚠️ **Round timer warning:** This round ends <t:${ts}:F> (<t:${ts}:R>). Please complete your game soon!`);
    } catch (e) { console.error(`[timer] Warning in thread ${match.threadId} failed:`, e.message); }
  }
}

async function sendRoundExpiry(guild) {
  if (!tournament.started) return;
  if (tournament.activeMatches.length === 0) return; // Round already completed naturally
  const mainChannel = await guild.channels.fetch(tournament.setupChannelId).catch(() => null);
  if (!mainChannel) return;

  const ts = Math.floor(tournament.roundDeadline / 1000);
  const allRoundMatches = tournament.rounds[tournament.currentRound - 1] || [];
  const stillActive = tournament.activeMatches.slice().sort((a, b) => a.matchNumber - b.matchNumber);
  const activeNums = new Set(stillActive.map(m => m.matchNumber));
  const completedCount = allRoundMatches.length - stillActive.length;

  const expiredEmbed = new EmbedBuilder()
    .setTitle(`⏰ Round ${tournament.currentRound} Timer Expired`)
    .setColor(0xff4500)
    .setDescription(`The round deadline was <t:${ts}:F>.`);

  if (completedCount > 0) {
    const completedLines = allRoundMatches
      .map((_, i) => i + 1)
      .filter(n => !activeNums.has(n))
      .map(n => {
        const games = tournament.roundResults.filter(r => r.matchNumber === n);
        const blue = games.filter(r => r.winner === 'blue').length;
        return `Match ${n}: ${games.length} game${games.length !== 1 ? 's' : ''} (🔵 ${blue} – 🔴 ${games.length - blue})`;
      }).join('\n');
    expiredEmbed.addFields({ name: `✅ Completed (${completedCount}/${allRoundMatches.length})`, value: completedLines.slice(0, 1024) });
  }

  if (stillActive.length > 0) {
    const activeLines = stillActive
      .map(m => `Match ${m.matchNumber} (game ${m.gamePhase ?? 1} of ${getMatchGameCount(m)}): ${scheduler.playersOf(m.grouping).map(id => `<@${id}>`).join(' · ')}`)
      .join('\n');
    expiredEmbed.addFields({ name: `⏳ Still Active (${stillActive.length}/${allRoundMatches.length})`, value: activeLines.slice(0, 1024) });
  }

  const webUrl = getWebBaseUrl();
  expiredEmbed.addFields({ name: '⚙️ Admin Action Required', value: `Log in to the **[tournament website](${webUrl})** as admin to force-end this round and advance to the next.` });

  await mainChannel.send({ embeds: [expiredEmbed] });
}

function getSwappedGrouping(grouping) {
  return {
    blue: { spymaster: grouping.blue.guesser, guesser: grouping.blue.spymaster },
    red:  { spymaster: grouping.red.guesser,  guesser: grouping.red.spymaster },
  };
}

// Legacy matches (before the 6-game format) stored one grouping plus a list of
// "phases": 2 = both teams swap roles, 3 = only blue swaps, 4 = only red swaps.
function getGroupingForPhase(grouping, phase) {
  if (phase === 2) return getSwappedGrouping(grouping);
  if (phase === 3) return { blue: getSwappedGrouping(grouping).blue, red: grouping.red };
  if (phase === 4) return { blue: grouping.blue, red: getSwappedGrouping(grouping).red };
  return grouping;
}

function getPhaseButtonSuffix(phase) {
  return phase > 1 ? `_g${phase}` : '';
}

function hasValidGrouping(grouping) {
  return !!(
    grouping &&
    grouping.blue &&
    grouping.red &&
    grouping.blue.spymaster &&
    grouping.blue.guesser &&
    grouping.red.spymaster &&
    grouping.red.guesser
  );
}

function getMatchPhaseSequence(matchLike) {
  if (Array.isArray(matchLike?.phaseSequence) && matchLike.phaseSequence.length > 0) {
    const cleaned = matchLike.phaseSequence
      .map(n => parseInt(n, 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= MAX_GAMES_PER_MATCH);
    if (cleaned.length > 0) return cleaned;
  }
  return getDefaultPhaseSequence(matchLike?.gamesPlanned);
}

// The line-up of every game in a match. New matches store it (`games`);
// legacy ones derive it from their grouping and phase sequence.
function getMatchGames(matchLike) {
  if (Array.isArray(matchLike?.games) && matchLike.games.length > 0) return matchLike.games;
  return getMatchPhaseSequence(matchLike).map(phase => getGroupingForPhase(matchLike.grouping, phase));
}

// One line per game: "G1 🔵 @a (spy) & @b vs 🔴 @c (spy) & @d".
function formatMatchPlan(games) {
  return games.map((g, i) =>
    `G${i + 1} 🔵 <@${g.blue.spymaster}> (spy) & <@${g.blue.guesser}> vs 🔴 <@${g.red.spymaster}> (spy) & <@${g.red.guesser}>`
  ).join('\n');
}

function getMatchGameCount(matchLike) {
  return getMatchGames(matchLike).length;
}

function getGroupingForMatchGame(matchLike, gameIndex) {
  const games = getMatchGames(matchLike);
  return games[gameIndex - 1] || games[0];
}

function getRoundMatchEntry(match) {
  if (match && Array.isArray(match.games) && match.games.length > 0) {
    return { grouping: match.games[0], games: match.games, gamesPlanned: match.games.length, phaseSequence: null };
  }
  // Legacy: {grouping, gamesPlanned, phaseSequence}, or older still a bare grouping.
  const legacy = match && match.grouping ? match : { grouping: match, gamesPlanned: MIN_GAMES_PER_MATCH };
  const phaseSequence = getMatchPhaseSequence(legacy);
  return { grouping: legacy.grouping, games: null, gamesPlanned: phaseSequence.length, phaseSequence };
}

// Copy a match's logged games into history and this round's results.
// Returns how many games were copied.
function moveMatchResultsToHistory(matchData) {
  const phaseResults = matchData.phaseResults || {};
  if (matchData.game1Result && !phaseResults[1]) phaseResults[1] = matchData.game1Result;
  const phaseSequence = Array.isArray(matchData.games) ? null : getMatchPhaseSequence(matchData);
  const gamesPerMatch = getMatchGameCount(matchData);
  let moved = 0;
  for (let idx = 1; idx <= gamesPerMatch; idx++) {
    const g = phaseResults[idx];
    if (!g) continue;
    const groupingForGame = getGroupingForMatchGame(matchData, idx);
    const actualGamePhase = phaseSequence ? (phaseSequence[idx - 1] || idx) : idx;
    tournament.roundResults.push({
      matchNumber: matchData.matchNumber,
      gameIndex: idx,
      grouping: groupingForGame,
      winner: g.winner,
      assassin: g.assassin,
      remainingCards: g.remainingCards,
      winPoints: g.winPoints,
      losePoints: g.losePoints,
      threadId: matchData.threadId,
    });
    tournament.history.push({
      roundNumber: tournament.currentRound,
      matchNumber: matchData.matchNumber,
      game: idx,
      gamePhase: actualGamePhase,
      grouping: groupingForGame,
      winner: g.winner,
      assassin: g.assassin,
      remainingCards: g.remainingCards,
      winPoints: g.winPoints,
      losePoints: g.losePoints,
      threadId: matchData.threadId,
      matchCreatedAt: matchData.matchCreatedAt || null,
      submittedAt: g.submittedAt || null,
      submittedBy: g.submittedBy || null,
      source: g.source || 'manual',
      detail: g.detail || null, // clue-by-clue history when the game came from codenames.game
    });
    moved++;
  }
  return moved;
}

// End the current round now: logged games are kept (scores already include
// them), unplayed games score nothing, threads are archived, and the next
// round is allocated.
async function forceEndRound(guild) {
  const ended = tournament.activeMatches.length;
  let gamesKept = 0;
  for (const match of tournament.activeMatches) {
    gamesKept += moveMatchResultsToHistory(match);
    if (guild) {
      const thread = await guild.channels.fetch(match.threadId).catch(() => null);
      if (thread) await thread.setArchived(true).catch(() => null);
    }
  }
  tournament.activeMatches = [];
  clearRoundTimers();
  tournament.roundDeadline = null;
  tournament.currentRound++;
  tournament.currentRoundIndex = 0;
  await saveTournamentData();
  if (guild) {
    updateScoreboard(guild).catch(() => null);
    if (tournament.currentRound <= tournament.rounds.length) {
      allocateRound(guild).catch(e => console.error('[force-end] Auto-allocate failed:', e.message));
    }
  }
  return { ended, gamesKept };
}

async function processGameResult(interaction, matchData, winner, assassin, remainingCards) {
  return recordGameResult({
    guild: interaction.guild,
    channel: interaction.channel,
    submittedBy: interaction.user.id,
    reply: (content) => interaction.reply({ content }),
  }, matchData, winner, assassin, remainingCards);
}

// Score one game of a match and move the match on (next game, or match/round complete).
// `ctx` = { guild, channel (the match thread), submittedBy, reply(content), source? }.
async function recordGameResult(ctx, matchData, winner, assassin, remainingCards) {
  const { guild } = ctx;
  const submittedBy = ctx.submittedBy;
  const submittedAt = new Date().toISOString();
  const gamePhase = matchData.gamePhase ?? 1; // sequential game number (1-based)
  const gamesPerMatch = getMatchGameCount(matchData);
  const currentGrouping = getGroupingForMatchGame(matchData, gamePhase);

  const winPoints = 3;
  const losePoints = assassin ? -1 : (remainingCards <= 3 ? 1 : 0);

  const bluePlayers = [currentGrouping.blue.spymaster, currentGrouping.blue.guesser];
  const redPlayers  = [currentGrouping.red.spymaster,  currentGrouping.red.guesser];

  if (winner === 'blue') {
    bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) + winPoints));
    redPlayers.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) + losePoints));
  } else {
    redPlayers.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) + winPoints));
    bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) + losePoints));
  }

  const winnerLabel = winner === 'blue' ? '🔵 Blue' : '🔴 Red';
  const howStr = assassin ? 'assassin hit' : `${remainingCards} card${remainingCards !== 1 ? 's' : ''} remaining`;
  const phaseResults = matchData.phaseResults || {};
  if (!matchData.phaseResults) {
    matchData.phaseResults = phaseResults;
  }
  if (matchData.game1Result && !phaseResults[1]) {
    phaseResults[1] = matchData.game1Result;
  }
  const currentResult = { winner, assassin, remainingCards, winPoints, losePoints, submittedAt, submittedBy };
  if (ctx.source) currentResult.source = ctx.source;
  if (ctx.detail) currentResult.detail = ctx.detail;
  phaseResults[gamePhase] = currentResult;
  if (gamePhase === 1) {
    matchData.game1Result = currentResult; // Backward compatibility for active-match admin tooling
  }

  if (gamePhase < gamesPerMatch) {
    const nextPhase = gamePhase + 1;
    matchData.gamePhase = nextPhase;
    await saveTournamentData();
    updateScoreboard(guild).catch(() => null);

    const replyText = `**Game ${gamePhase}** result logged: **${winnerLabel}** won (${howStr}).\nWin: **+${winPoints} pts** · Lose: **${losePoints > 0 ? '+' : ''}${losePoints} pts**\n\n_Game ${nextPhase} is starting._`;
    await ctx.reply(replyText);

    const nextGrouping = getGroupingForMatchGame(matchData, nextPhase);
    const nextGameEmbed = new EmbedBuilder()
      .setTitle(`Match ${matchData.matchNumber} — Game ${nextPhase} of ${gamesPerMatch}`)
      .setDescription(
        `**Blue Team:**\nSpymaster: <@${nextGrouping.blue.spymaster}>\nGuesser: <@${nextGrouping.blue.guesser}>\n\n` +
        `**Red Team:**\nSpymaster: <@${nextGrouping.red.spymaster}>\nGuesser: <@${nextGrouping.red.guesser}>\n\nPlay Game ${nextPhase} then log the result below.` +
        (bridgeClient.enabled ? '\n\n🕵️ Use **Play next game** in the same codenames.game room — the result is logged automatically.' : '')
      )
      .setColor(0xff9900);

    const nextPhaseSuffix = getPhaseButtonSuffix(nextPhase);
    const nextGameRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`log_blue_win${nextPhaseSuffix}`).setLabel('Blue Wins').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`log_red_win${nextPhaseSuffix}`).setLabel('Red Wins').setStyle(ButtonStyle.Danger),
    );

    await ctx.channel.send({ embeds: [nextGameEmbed], components: [nextGameRow] });
  } else {
    moveMatchResultsToHistory(matchData);

    tournament.activeMatches = tournament.activeMatches.filter(m => m.threadId !== matchData.threadId);
    tournament.currentRoundIndex++;

    const remainingActive = tournament.activeMatches.length;
    const roundComplete = remainingActive === 0;

    let replyText = `**Game ${gamePhase}** result logged: **${winnerLabel}** won (${howStr}).\nWin: **+${winPoints} pts** · Lose: **${losePoints > 0 ? '+' : ''}${losePoints} pts**`;
    if (roundComplete) replyText += '\nAll matches complete — round advancing.';
    else replyText += `\n${remainingActive} match(es) still active this round.`;
    replyText += `\n\n_Need to correct a result? Visit the tournament website and log in as admin._`;

    await ctx.reply(replyText);

    await saveTournamentData();
    updateScoreboard(guild).catch(() => null);

    if (roundComplete) {
      clearRoundTimers();
      tournament.currentRound++;
      tournament.currentRoundIndex = 0;
      await saveTournamentData();
      if (tournament.currentRound <= tournament.rounds.length) {
        allocateRound(guild).catch(e => console.error('Auto-allocation failed:', e.message));
      }
    }
  }
}

client.on('error', (error) => {
  console.error('Client error:', error);
});

// A finished codenames.game game reported by the BGA bot. Logged straight away
// when the room's seats match the line-up for the match's current game;
// otherwise posted in the thread for a player or admin to confirm.
// Returns { status, data } for the HTTP response (2xx = handled, 503 = retry later).
async function handleBridgeResult(body) {
  const invalid = codenamesBridge.validateResultPayload(body);
  if (invalid) return { status: 400, data: { error: invalid } };

  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const thread = guild ? await guild.channels.fetch(body.channel_id).catch(() => null) : null;

  const matchData = tournament.activeMatches.find(m => m.threadId === body.channel_id);
  if (!matchData) return { status: 200, data: { status: 'ignored', reason: 'no active match for this thread' } };
  if (body.external_ref && body.external_ref !== getMatchBridgeRef(matchData)) {
    return { status: 200, data: { status: 'ignored', reason: 'external_ref does not match the current match' } };
  }
  matchData.bridgeEvents = matchData.bridgeEvents || [];
  if (matchData.bridgeEvents.includes(body.event_id)) return { status: 200, data: { status: 'duplicate' } };
  if (!thread) return { status: 503, data: { error: 'match thread is not reachable right now' } };

  const gamePhase = matchData.gamePhase ?? 1;
  const processingKey = `${matchData.threadId}:${gamePhase}:result`;
  if (processingThreads.has(processingKey)) return { status: 503, data: { error: 'a result for this game is being submitted' } };
  processingThreads.add(processingKey); // synchronous, like the button handlers
  matchData.bridgeEvents.push(body.event_id);

  try {
    const { winner } = body;
    const assassin = Boolean(body.assassin);
    const remainingCards = codenamesBridge.remainingCardsFromPayload(body);
    const gamesPlanned = getMatchGameCount(matchData);
    const seatedGame = codenamesBridge.findGameForSeats(body.seats, gamesPlanned, idx => getGroupingForMatchGame(matchData, idx));

    if (seatedGame === gamePhase) {
      await recordGameResult({
        guild,
        channel: thread,
        submittedBy: 'codenames-bridge',
        source: 'codenames-bridge',
        detail: codenamesBridge.gameDetailFromPayload(body),
        reply: (content) => thread.send({ content: `🕵️ _Logged automatically from codenames.game._\n${content}` }),
      }, matchData, winner, assassin, remainingCards);
      return { status: 200, data: { status: 'logged', game: gamePhase } };
    }

    if (seatedGame !== null && seatedGame < gamePhase) {
      await saveTournamentData();
      await thread.send({ content: `🕵️ codenames.game reported a finished game with the **Game ${seatedGame}** line-up, which is already logged — ignoring it.` });
      return { status: 200, data: { status: 'already_logged', game: seatedGame } };
    }

    const pendingId = crypto.randomBytes(4).toString('hex');
    matchData.pendingBridgeResults = matchData.pendingBridgeResults || {};
    matchData.pendingBridgeResults[pendingId] = {
      eventId: body.event_id, gamePhase, winner, assassin, remainingCards,
      roomUrl: body.room_url || null, receivedAt: new Date().toISOString(),
      detail: codenamesBridge.gameDetailFromPayload(body),
    };
    await saveTournamentData();

    const expected = getGroupingForMatchGame(matchData, gamePhase);
    const winnerLabel = winner === 'blue' ? '🔵 Blue' : '🔴 Red';
    const howStr = assassin ? 'assassin hit' : `${remainingCards} card${remainingCards !== 1 ? 's' : ''} remaining`;
    const embed = new EmbedBuilder()
      .setTitle(`🕵️ Game ${gamePhase} result detected — please confirm`)
      .setDescription(
        `codenames.game says **${winnerLabel}** won (${howStr})${body.room_url ? ` in ${body.room_url}` : ''}.\n\n` +
        `The seats in the room didn't match the line-up for Game ${gamePhase} (or some players haven't pressed **I'm playing** on the room card), so it wasn't logged automatically.\n\n` +
        `**Expected:**\n🔵 Spymaster: <@${expected.blue.spymaster}> · Guesser: <@${expected.blue.guesser}>\n🔴 Spymaster: <@${expected.red.spymaster}> · Guesser: <@${expected.red.guesser}>\n\n` +
        `**In the room:**\n${codenamesBridge.describeSeats(body.seats)}`
      )
      .setColor(0xffcc00);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cnb_ok_${pendingId}`).setLabel(`Log as Game ${gamePhase}`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cnb_no_${pendingId}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
    );
    await thread.send({ embeds: [embed], components: [row] });
    return { status: 202, data: { status: 'needs_confirmation', game: gamePhase } };
  } catch (error) {
    // Let the BGA bot retry: the seat check stops a retry from scoring the game twice.
    matchData.bridgeEvents = matchData.bridgeEvents.filter(id => id !== body.event_id);
    throw error;
  } finally {
    processingThreads.delete(processingKey);
  }
}

// ----- Web dashboard & OAuth -----

// ── Session & OAuth state stores ──────────────────────────────────────────
// Map<sessionId, { userId, username, globalName, avatar, isAdmin, expiresAt }>
const sessions = new Map();
// Map<state, { expiresAt, baseUrl }>
const oauthStates = new Map();

// Clean up expired entries every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (sess.expiresAt < now) sessions.delete(id);
  }
  for (const [state, entry] of oauthStates) {
    if (entry.expiresAt < now) oauthStates.delete(state);
  }
}, 15 * 60 * 1000);

// ── Helpers ────────────────────────────────────────────────────────────────

function getWebBaseUrl(req) {
  if (process.env.WEB_URL) return process.env.WEB_URL.replace(/\/$/, '');
  const port = parseInt(process.env.WEB_PORT) || 80;
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${port}`;
    return `${proto}://${host}`;
  }
  const host = process.env.WEB_HOST || process.env.HOSTNAME || 'localhost';
  return `http://${host}${port === 80 ? '' : ':' + port}`;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
  }
  return cookies;
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies['sid'];
  if (!sid) return null;
  const sess = sessions.get(sid);
  if (!sess) return null;
  if (sess.expiresAt < Date.now()) { sessions.delete(sid); return null; }
  return { sid, ...sess };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: headers || {} };
    const r = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

function httpsPost(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = Buffer.from(body, 'utf-8');
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length }, extraHeaders || {}),
    };
    const r = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

async function exchangeDiscordCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  }).toString();
  return httpsPost('https://discord.com/api/oauth2/token', body);
}

async function fetchDiscordUser(accessToken) {
  return httpsGet('https://discord.com/api/users/@me', { Authorization: `Bearer ${accessToken}` });
}

async function isUserAdmin(userId) {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return false;
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (!adminRoleId) return false;
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;
    return member.roles.cache.has(adminRoleId);
  } catch { return false; }
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getGamesPlayedMap() {
  const map = {};
  for (const entry of tournament.history) {
    const players = [
      entry.grouping.blue.spymaster,
      entry.grouping.blue.guesser,
      entry.grouping.red.spymaster,
      entry.grouping.red.guesser,
    ];
    for (const id of players) {
      if (id) map[id] = (map[id] || 0) + 1;
    }
  }
  return map;
}

function buildWebData() {
  return {
    started: tournament.started,
    currentRound: tournament.currentRound,
    totalRounds: tournament.rounds.length,
    tournamentStartedAt: tournament.tournamentStartedAt,
    roundStartedAt: tournament.roundStartedAt,
    playerNames: tournament.playerNames,
    scores: Array.from(tournament.scores.entries()).sort((a, b) => b[1] - a[1]),
    gamesPlayed: getGamesPlayedMap(),
    rounds: tournament.rounds,
    history: tournament.history,
    activeMatches: tournament.activeMatches,
    leftPlayers: tournament.leftPlayers,
    pendingRemoval: tournament.pendingRemoval !== null,
    signupsReopened: tournament.signupsReopened,
    roundDeadline: tournament.roundDeadline,
    matchStatus: buildMatchStatus(),
  };
}

// The dashboard page and its static files, read once at startup. `__V__` in
// the page becomes a per-start version so browsers fetch new CSS/JS after a deploy.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const ASSET_VERSION = Date.now().toString(36);
let cachedDashboardHtml = null;
try {
  cachedDashboardHtml = require('fs').readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8').replaceAll('__V__', ASSET_VERSION);
} catch {
  console.warn('[web] public/index.html not found — dashboard will return 404');
}
const staticFiles = new Map(); // "/static/app.js" -> { body, type }
try {
  for (const name of require('fs').readdirSync(path.join(PUBLIC_DIR, 'static'))) {
    const type = STATIC_TYPES[path.extname(name)];
    if (type) staticFiles.set(`/static/${name}`, { body: require('fs').readFileSync(path.join(PUBLIC_DIR, 'static', name)), type });
  }
} catch {
  console.warn('[web] public/static not found — dashboard styles and scripts will be missing');
}
// Chart.js is served from the package rather than a CDN.
try {
  staticFiles.set('/static/vendor/chart.umd.js', { body: require('fs').readFileSync(path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js')), type: STATIC_TYPES['.js'] });
} catch {
  console.warn('[web] chart.js package not installed — the Stats charts will not render');
}
const HTML_SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

const WEB_PORT = parseInt(process.env.WEB_PORT) || 80;

// ── HTTP request handler ───────────────────────────────────────────────────
async function handleHttpRequest(req, res) {
  try {
    const rawUrl = req.url || '/';
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
    const search = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';
    const query = Object.fromEntries(new URLSearchParams(search));
    const method = (req.method || 'GET').toUpperCase();

    // ── Codenames bridge: results from the BGA bot ───────────────────────────
    if (pathname === '/api/bridge/codenames/result' && method === 'POST') {
      if (!BRIDGE_TOKEN) return sendJson(res, 404, { error: 'bridge is disabled' });
      if (!codenamesBridge.isAuthorized(req.headers.authorization, BRIDGE_TOKEN)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'body must be JSON' }); }
      try {
        const result = await handleBridgeResult(body);
        return sendJson(res, result.status, result.data);
      } catch (error) {
        console.error('[bridge] Failed to handle result:', error);
        return sendJson(res, 500, { error: 'failed to record the result' });
      }
    }

    // ── Public tournament data ───────────────────────────────────────────────
    if (pathname === '/api' && method === 'GET') {
      const payload = JSON.stringify(buildWebData());
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(payload);
      return;
    }

    // ── Auth: start OAuth2 flow ──────────────────────────────────────────────
    if (pathname === '/auth/discord' && method === 'GET') {
      if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
        res.writeHead(503);
        res.end('OAuth is not configured on this server.');
        return;
      }
      const state = crypto.randomBytes(16).toString('hex');
      const baseUrl = getWebBaseUrl(req);
      oauthStates.set(state, { expiresAt: Date.now() + 10 * 60 * 1000, baseUrl });
      const redirectUri = encodeURIComponent(`${baseUrl}/auth/discord/callback`);
      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=identify&state=${state}`;
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    // ── Auth: OAuth2 callback ────────────────────────────────────────────────
    if (pathname === '/auth/discord/callback' && method === 'GET') {
      const { code, state, error } = query;

      if (error) {
        res.writeHead(302, { Location: `/?auth_error=${encodeURIComponent(error)}` });
        res.end();
        return;
      }

      const stateEntry = oauthStates.get(state);
      if (!code || !state || !stateEntry || stateEntry.expiresAt < Date.now()) {
        oauthStates.delete(state);
        res.writeHead(302, { Location: '/?auth_error=invalid_state' });
        res.end();
        return;
      }
      oauthStates.delete(state);

      const redirectUri = `${stateEntry.baseUrl}/auth/discord/callback`;

      // Exchange code for access token
      const tokenResult = await exchangeDiscordCode(code, redirectUri);
      if (!tokenResult.data || !tokenResult.data.access_token) {
        res.writeHead(302, { Location: '/?auth_error=token_exchange_failed' });
        res.end();
        return;
      }

      // Fetch Discord user info
      const userResult = await fetchDiscordUser(tokenResult.data.access_token);
      if (!userResult.data || !userResult.data.id) {
        res.writeHead(302, { Location: '/?auth_error=user_fetch_failed' });
        res.end();
        return;
      }

      const user = userResult.data;
      const admin = await isUserAdmin(user.id);

      // Create session
      const sid = crypto.randomBytes(32).toString('hex');
      const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
      sessions.set(sid, {
        userId: user.id,
        username: user.username,
        globalName: user.global_name || user.username,
        avatar: user.avatar || null,
        isAdmin: admin,
        expiresAt: Date.now() + SESSION_TTL,
      });

      const isHttps = (process.env.WEB_URL || '').toLowerCase().startsWith('https://');
      const cookieFlags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}${isHttps ? '; Secure' : ''}`;
      res.writeHead(302, { Location: '/', 'Set-Cookie': `sid=${sid}; ${cookieFlags}` });
      res.end();
      return;
    }

    // ── Auth: logout ─────────────────────────────────────────────────────────
    if (pathname === '/auth/logout' && method === 'POST') {
      const session = getSession(req);
      if (session) sessions.delete(session.sid);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Auth: current user ───────────────────────────────────────────────────
    if (pathname === '/auth/me' && method === 'GET') {
      const oauthEnabled = !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
      const session = getSession(req);
      if (!session) {
        sendJson(res, 200, { loggedIn: false, oauthEnabled });
        return;
      }
      // Re-verify admin status on every /auth/me call
      const admin = await isUserAdmin(session.userId);
      if (admin !== session.isAdmin) {
        sessions.set(session.sid, { ...sessions.get(session.sid), isAdmin: admin });
      }
      sendJson(res, 200, {
        loggedIn: true,
        userId: session.userId,
        username: session.username,
        globalName: session.globalName,
        avatar: session.avatar,
        isAdmin: admin,
        oauthEnabled,
      });
      return;
    }

    // ── Admin API endpoints ──────────────────────────────────────────────────
    if (pathname.startsWith('/api/admin/') && method === 'POST') {
      // Require authenticated session
      const session = getSession(req);
      if (!session) { sendJson(res, 401, { error: 'Not authenticated. Please log in.' }); return; }

      // Re-verify admin role on every request
      const admin = await isUserAdmin(session.userId);
      if (!admin) { sendJson(res, 403, { error: 'Forbidden. You do not have the tournament admin role.' }); return; }

      // CSRF mitigation: when WEB_URL is configured, reject requests from other origins
      if (process.env.WEB_URL) {
        const origin = req.headers.origin || '';
        const expectedBase = process.env.WEB_URL.replace(/\/$/, '');
        if (origin && origin !== expectedBase) {
          sendJson(res, 403, { error: 'CSRF check failed.' });
          return;
        }
      }

      const action = pathname.slice('/api/admin/'.length);

      // ── start ──────────────────────────────────────────────────────────────
      if (action === 'start') {
        if (tournament.started) { sendJson(res, 400, { error: 'Tournament has already started.' }); return; }
        if (tournament.players.size < 4) { sendJson(res, 400, { error: 'Need at least 4 players to start.' }); return; }

        tournament.currentRound = 1;
        tournament.currentRoundIndex = 0;
        tournament.started = true;
        tournament.tournamentStartedAt = new Date().toISOString();
        tournament.scores = new Map([...tournament.players].map(id => [id, 0]));
        tournament.rounds = scheduler.generateSchedule(Array.from(tournament.players));

        // Snapshot display names
        tournament.playerNames = {};
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        for (const id of tournament.players) {
          if (id.startsWith('debug_')) {
            tournament.playerNames[id] = id;
          } else {
            try {
              const member = guild ? await guild.members.fetch(id).catch(() => null) : null;
              tournament.playerNames[id] = member ? member.displayName : id;
            } catch { tournament.playerNames[id] = id; }
          }
        }

        await saveTournamentData();
        if (guild) updateScoreboard(guild).catch(() => null);

        sendJson(res, 200, { ok: true, message: `Tournament started with ${tournament.players.size} players! Generated ${tournament.rounds.length} rounds.` });
        return;
      }

      // ── allocate ───────────────────────────────────────────────────────────
      if (action === 'allocate') {
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        if (!guild) { sendJson(res, 500, { error: 'Discord guild not available.' }); return; }
        const result = await allocateRound(guild);
        sendJson(res, result.success ? 200 : 400, { ok: result.success, message: result.message });
        return;
      }

      // ── force-end ──────────────────────────────────────────────────────────
      if (action === 'force-end') {
        if (tournament.activeMatches.length === 0) { sendJson(res, 400, { error: 'No active matches to force-end.' }); return; }
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        const { ended, gamesKept } = await forceEndRound(guild);
        sendJson(res, 200, { ok: true, message: `Force-ended ${ended} active match(es); ${gamesKept} game(s) already played were kept. Advancing to next round.` });
        return;
      }

      // ── reset ──────────────────────────────────────────────────────────────
      if (action === 'reset') {
        const prevSetupMessage = tournament.setupMessage;
        const prevSetupChannelId = tournament.setupChannelId;
        const guild = client.guilds.cache.get(process.env.GUILD_ID);

        clearRoundTimers();
        clearRemovalTimer();
        tournament = {
          players: new Set(),
          currentRound: 0,
          currentRoundIndex: 0,
          playedGroupings: new Set(),
          scores: new Map(),
          currentGrouping: null,
          activeMatches: [],
          roundResults: [],
          roundDeadline: null,
          setupMessage: prevSetupMessage,
          setupChannelId: prevSetupChannelId,
          rounds: [],
          started: false,
          history: [],
          playerNames: {},
          tournamentStartedAt: null,
          roundStartedAt: null,
          leftPlayers: {},
          pendingRemoval: null,
          signupsReopened: false,
          signupReopenMessageId: null,
        };
        await saveTournamentData();

        // Update the Discord embed to show the cleared state
        if (prevSetupMessage && prevSetupChannelId && guild) {
          try {
            const channel = await guild.channels.fetch(prevSetupChannelId).catch(() => null);
            if (channel) {
              const message = await channel.messages.fetch(prevSetupMessage).catch(() => null);
              if (message) {
                const signupRow = new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('signup').setLabel('Sign Up').setStyle(ButtonStyle.Primary),
                  new ButtonBuilder().setLabel('🌐 Website').setStyle(ButtonStyle.Link).setURL(getWebBaseUrl()),
                );
                const resetEmbed = new EmbedBuilder()
                  .setTitle('Codenames Tournament')
                  .setDescription(buildSignupDescription())
                  .setColor(0x0099ff);
                await message.edit({ embeds: [resetEmbed], components: [signupRow] });
              }
            }
          } catch (err) { console.error('[web admin reset] Failed to update Discord embed:', err.message); }
        }

        sendJson(res, 200, { ok: true, message: 'Tournament has been reset.' });
        return;
      }

      // ── adjust-score ───────────────────────────────────────────────────────
      if (action === 'adjust-score') {
        let data;
        try { data = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: 'Invalid JSON body.' }); return; }
        const { userId, delta } = data || {};
        const d = parseInt(delta);
        if (!userId || isNaN(d)) { sendJson(res, 400, { error: 'Provide userId (string) and delta (integer).' }); return; }
        if (!tournament.scores.has(userId)) { sendJson(res, 404, { error: `No score found for player ID "${userId}".` }); return; }
        const oldScore = tournament.scores.get(userId);
        tournament.scores.set(userId, oldScore + d);
        await saveTournamentData();
        const guild2 = client.guilds.cache.get(process.env.GUILD_ID);
        if (guild2) updateScoreboard(guild2).catch(() => null);
        sendJson(res, 200, { ok: true, message: `Score adjusted: ${oldScore} → ${oldScore + d} pts (${d >= 0 ? '+' : ''}${d})` });
        return;
      }

      // ── shuffle-rounds ─────────────────────────────────────────────────────
      if (action === 'shuffle-rounds') {
        if (!tournament.started) { sendJson(res, 400, { error: 'Tournament has not started yet.' }); return; }
        // tournament.currentRound is 1-indexed; future rounds start at that same value as a 0-indexed array offset
        const startIdx = tournament.currentRound; // e.g. currentRound=2 → skip indices 0 (done) and 1 (active)
        if (startIdx >= tournament.rounds.length) {
          sendJson(res, 400, { error: 'No remaining rounds to shuffle.' });
          return;
        }
        const futureRounds = tournament.rounds.slice(startIdx);
        shuffleArray(futureRounds);
        futureRounds.forEach(round => shuffleArray(round));
        tournament.rounds = [...tournament.rounds.slice(0, startIdx), ...futureRounds];
        await saveTournamentData();
        sendJson(res, 200, { ok: true, message: `Shuffled ${futureRounds.length} remaining round(s).` });
        return;
      }

      // ── override-result ────────────────────────────────────────────────────
      if (action === 'override-result') {
        let data;
        try { data = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: 'Invalid JSON body.' }); return; }
        const { roundNumber, matchNumber, game, winner, assassin, remainingCards } = data || {};
        const rNum = parseInt(roundNumber);
        const mNum = parseInt(matchNumber);
        const gNum = parseInt(game);
        const rCards = parseInt(remainingCards) || 0;
        const isAssassin = !!assassin;

        if (!rNum || !mNum || !gNum || !['blue', 'red'].includes(winner)) {
          sendJson(res, 400, { error: 'Required: roundNumber (int), matchNumber (int), game (int >= 1), winner ("blue"|"red"), assassin (bool), remainingCards (int 0-8).' });
          return;
        }
        if (!isAssassin && (rCards < 0 || rCards > 8)) {
          sendJson(res, 400, { error: 'remainingCards must be 0–8.' });
          return;
        }

        // Try history first (fully completed games)
        const histIdx = tournament.history.findIndex(h =>
          h.roundNumber === rNum && h.matchNumber === mNum && h.game === gNum
        );

        // Also try in-progress results from an active match
        const activeMatchForGame = tournament.activeMatches.find(m => {
          if (m.matchNumber !== mNum || tournament.currentRound !== rNum) return false;
          if (m.phaseResults && m.phaseResults[gNum]) return true;
          return gNum === 1 && !!m.game1Result;
        });

        if (histIdx === -1 && !activeMatchForGame) {
          sendJson(res, 404, { error: 'Game result not found. It may not have been submitted yet or the round/match numbers are wrong.' });
          return;
        }

        // Determine old result and grouping
        let oldWinner, oldAssassin, oldWinPoints, oldLosePoints, grouping;
        if (histIdx !== -1) {
          const old = tournament.history[histIdx];
          oldWinner = old.winner; oldAssassin = old.assassin;
          oldWinPoints = old.winPoints; oldLosePoints = old.losePoints;
          grouping = old.grouping;
        } else {
          const activeResult = (activeMatchForGame.phaseResults && activeMatchForGame.phaseResults[gNum])
            || (gNum === 1 ? activeMatchForGame.game1Result : null);
          oldWinner = activeResult.winner; oldAssassin = activeResult.assassin;
          oldWinPoints = activeResult.winPoints; oldLosePoints = activeResult.losePoints;
          grouping = getGroupingForMatchGame(activeMatchForGame, gNum);
        }

        const bluePlayers = [grouping.blue.spymaster, grouping.blue.guesser];
        const redPlayers  = [grouping.red.spymaster,  grouping.red.guesser];

        // Reverse old score impact
        if (oldWinner === 'blue') {
          bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) - oldWinPoints));
          redPlayers.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) - oldLosePoints));
        } else {
          redPlayers.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) - oldWinPoints));
          bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) - oldLosePoints));
        }

        // Compute new points using same formula as processGameResult
        const newWinPoints = 3;
        const newLosePoints = isAssassin ? -1 : (rCards <= 3 ? 1 : 0);

        // Apply new score impact
        if (winner === 'blue') {
          bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) + newWinPoints));
          redPlayers.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) + newLosePoints));
        } else {
          redPlayers.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) + newWinPoints));
          bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) + newLosePoints));
        }

        // Update history entry if present
        if (histIdx !== -1) {
          tournament.history[histIdx] = {
            ...tournament.history[histIdx],
            winner,
            assassin: isAssassin,
            remainingCards: isAssassin ? 0 : rCards,
            winPoints: newWinPoints,
            losePoints: newLosePoints,
          };
        }

        // Update active match stored result if present
        if (activeMatchForGame) {
          if (!activeMatchForGame.phaseResults) activeMatchForGame.phaseResults = {};
          const prev = activeMatchForGame.phaseResults[gNum] || (gNum === 1 ? activeMatchForGame.game1Result : null) || {};
          activeMatchForGame.phaseResults[gNum] = {
            ...prev,
            winner,
            assassin: isAssassin,
            remainingCards: isAssassin ? 0 : rCards,
            winPoints: newWinPoints,
            losePoints: newLosePoints,
          };
          if (gNum === 1) {
            activeMatchForGame.game1Result = activeMatchForGame.phaseResults[gNum];
          }
        }

        // Update roundResults entry for the current round if present
        const rrIdx = tournament.roundResults.findIndex(r =>
          r.matchNumber === mNum && (r.gameIndex ?? 1) === gNum
        );
        if (rrIdx !== -1) {
          tournament.roundResults[rrIdx] = {
            ...tournament.roundResults[rrIdx],
            winner,
            assassin: isAssassin,
            remainingCards: isAssassin ? 0 : rCards,
            winPoints: newWinPoints,
            losePoints: newLosePoints,
          };
        }

        await saveTournamentData();
        const guildOverride = client.guilds.cache.get(process.env.GUILD_ID);
        if (guildOverride) updateScoreboard(guildOverride).catch(() => null);

        // Post a notification to the game thread if it still exists
        const threadId = (histIdx !== -1 ? tournament.history[histIdx].threadId : null)
          || (activeMatchForGame ? activeMatchForGame.threadId : null);
        if (threadId && guildOverride) {
          try {
            const thread = await guildOverride.channels.fetch(threadId).catch(() => null);
            if (thread) {
              const overrideWinnerLabel = winner === 'blue' ? '🔵 Blue' : '🔴 Red';
              const overrideHow = isAssassin ? 'assassin hit' : `${rCards} card${rCards !== 1 ? 's' : ''} remaining`;
              const adminName = session.globalName || session.username;
              const notifyMsg = `⚠️ **Admin result correction** (by ${adminName})\n` +
                `Round ${rNum} · Match ${mNum} · Game ${gNum}: result changed to **${overrideWinnerLabel} wins** (${overrideHow}).`;
              await thread.send(notifyMsg);
            }
          } catch (e) {
            console.error('[override-result] Failed to post thread notification:', e.message);
          }
        }

        sendJson(res, 200, { ok: true, message: `Round ${rNum} Match ${mNum} Game ${gNum} updated: ${winner === 'blue' ? 'Blue' : 'Red'} wins.` });
        return;
      }

      // ── delete-result ──────────────────────────────────────────────────────
      if (action === 'delete-result') {
        let data;
        try { data = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { error: 'Invalid JSON body.' }); return; }
        const { roundNumber, matchNumber, game, adjustScore } = data || {};
        const rNum = parseInt(roundNumber);
        const mNum = parseInt(matchNumber);
        const gNum = parseInt(game);
        // Default to true so older clients still reverse scores; explicit false opts out
        const shouldAdjustScore = adjustScore !== false;

        if (!rNum || !mNum || !gNum) {
          sendJson(res, 400, { error: 'Required: roundNumber (int), matchNumber (int), game (int >= 1).' });
          return;
        }

        // Try history first (fully completed games)
        const histIdx = tournament.history.findIndex(h =>
          h.roundNumber === rNum && h.matchNumber === mNum && h.game === gNum
        );

        // Also try in-progress results of an active match
        const activeMatchForGame = tournament.activeMatches.find(m => {
          if (m.matchNumber !== mNum || tournament.currentRound !== rNum) return false;
          if (m.phaseResults && m.phaseResults[gNum]) return true;
          return gNum === 1 && !!m.game1Result;
        });

        if (histIdx === -1 && !activeMatchForGame) {
          sendJson(res, 404, { error: 'Game result not found. It may not have been submitted yet.' });
          return;
        }

        // Guard: delete in reverse order only (cannot delete an earlier game while later games exist).
        const higherHistoryExists = tournament.history.some(h =>
          h.roundNumber === rNum && h.matchNumber === mNum && h.game > gNum
        );
        const higherActiveExists = tournament.activeMatches.some(m => {
          if (m.matchNumber !== mNum || tournament.currentRound !== rNum) return false;
          const phaseResults = m.phaseResults || {};
          return Object.keys(phaseResults).some(k => parseInt(k, 10) > gNum && !!phaseResults[k]);
        });
        if (higherHistoryExists || higherActiveExists) {
          sendJson(res, 400, { error: 'Higher game results must be deleted first (delete in reverse game order).' });
          return;
        }

        // Capture values before modifying state
        let oldWinner, oldWinPoints, oldLosePoints, grouping, threadId;
        if (histIdx !== -1) {
          const old = tournament.history[histIdx];
          oldWinner = old.winner; oldWinPoints = old.winPoints; oldLosePoints = old.losePoints;
          grouping = old.grouping; threadId = old.threadId;
        } else {
          const activeResult = (activeMatchForGame.phaseResults && activeMatchForGame.phaseResults[gNum])
            || (gNum === 1 ? activeMatchForGame.game1Result : null);
          oldWinner = activeResult.winner; oldWinPoints = activeResult.winPoints; oldLosePoints = activeResult.losePoints;
          grouping = getGroupingForMatchGame(activeMatchForGame, gNum); threadId = activeMatchForGame.threadId;
        }

        const bluePlayers = [grouping.blue.spymaster, grouping.blue.guesser];
        const redPlayers  = [grouping.red.spymaster,  grouping.red.guesser];

        // Optionally reverse score impact
        if (shouldAdjustScore) {
          if (oldWinner === 'blue') {
            bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) - oldWinPoints));
            redPlayers.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) - oldLosePoints));
          } else {
            redPlayers.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) - oldWinPoints));
            bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) - oldLosePoints));
          }
        }

        // Remove from history or reset active match in-progress result
        if (histIdx !== -1) {
          tournament.history.splice(histIdx, 1);
        }
        if (activeMatchForGame) {
          if (!activeMatchForGame.phaseResults) activeMatchForGame.phaseResults = {};
          delete activeMatchForGame.phaseResults[gNum];
          if (gNum === 1) activeMatchForGame.game1Result = null;
          activeMatchForGame.gamePhase = gNum;
        }

        // Remove from roundResults if present
        const rrIdx = tournament.roundResults.findIndex(r =>
          r.matchNumber === mNum && (r.gameIndex ?? 1) === gNum
        );
        if (rrIdx !== -1) tournament.roundResults.splice(rrIdx, 1);

        await saveTournamentData();
        const guildOverride = client.guilds.cache.get(process.env.GUILD_ID);
        if (guildOverride) updateScoreboard(guildOverride).catch(() => null);

        // Notify thread
        if (threadId && guildOverride) {
          try {
            const thread = await guildOverride.channels.fetch(threadId).catch(() => null);
            if (thread) {
              const adminName = session.globalName || session.username;
              const scoreNote = shouldAdjustScore ? 'scores reversed' : 'scores unchanged';
              await thread.send(
                `⚠️ **Admin result deleted** (by ${adminName})\n` +
                `Round ${rNum} · Match ${mNum} · Game ${gNum}: result removed and marked as not played (${scoreNote}).`
              );
            }
          } catch (e) {
            console.error('[delete-result] Failed to post thread notification:', e.message);
          }
        }

        const scoreMsg = shouldAdjustScore ? ' Scores have been reversed.' : ' Scores were not changed.';
        sendJson(res, 200, { ok: true, message: `Round ${rNum} Match ${mNum} Game ${gNum} result deleted.${scoreMsg}` });
        return;
      }

      // ── reopen-signups ─────────────────────────────────────────────────────
      if (action === 'reopen-signups') {
        if (!tournament.started) { sendJson(res, 400, { error: 'Tournament has not started yet.' }); return; }
        if (tournament.signupsReopened) { sendJson(res, 400, { error: 'Signups are already open.' }); return; }
        const guildRO = client.guilds.cache.get(process.env.GUILD_ID);
        const channelRO = guildRO ? await guildRO.channels.fetch(tournament.setupChannelId).catch(() => null) : null;
        if (!channelRO) { sendJson(res, 500, { error: 'Could not find the tournament channel.' }); return; }
        const reopenRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('reopen_signup').setLabel('✅ Join Tournament').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('close_signups').setLabel('🔒 Close Signups (Admin)').setStyle(ButtonStyle.Danger),
        );
        const reopenMsg = await channelRO.send({
          content: '📋 **Signups are reopened!** Click below to join the tournament. New rounds won\'t start until signups are closed by an admin.',
          components: [reopenRow],
        });
        tournament.signupsReopened = true;
        tournament.signupReopenMessageId = reopenMsg.id;
        await saveTournamentData();
        if (guildRO) updateScoreboard(guildRO).catch(() => null);
        sendJson(res, 200, { ok: true, message: 'Signups reopened. A message has been posted in the tournament channel.' });
        return;
      }

      // ── close-signups ──────────────────────────────────────────────────────
      if (action === 'close-signups') {
        if (!tournament.signupsReopened) { sendJson(res, 400, { error: 'Signups are not currently open.' }); return; }
        const guildCS = client.guilds.cache.get(process.env.GUILD_ID);
        await closeSignups(guildCS);
        sendJson(res, 200, { ok: true, message: `Signups closed. Future rounds recalculated. Total rounds: ${tournament.rounds.length}.` });
        return;
      }

      // ── recalculate-rounds ─────────────────────────────────────────────────
      if (action === 'recalculate-rounds') {
        if (!tournament.started) { sendJson(res, 400, { error: 'Tournament has not started yet.' }); return; }
        const result = await fixMatchups(client.guilds.cache.get(process.env.GUILD_ID));
        sendJson(res, 200, { ok: true, message: describeFixMatchups(result) });
        return;
      }

      sendJson(res, 404, { error: `Unknown admin action "${action}".` });
      return;
    }

    // ── Static files ─────────────────────────────────────────────────────────
    if (pathname.startsWith('/static/')) {
      const file = staticFiles.get(pathname);
      if (!file) { res.writeHead(404); res.end('Not found'); return; }
      // Versioned URLs (?v=) can be cached for long; the page itself is never cached.
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.end(file.body);
      return;
    }

    // ── Static dashboard HTML ────────────────────────────────────────────────
    if (!cachedDashboardHtml) {
      res.writeHead(404);
      res.end('Dashboard not available. Ensure public/index.html exists.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...HTML_SECURITY_HEADERS });
    res.end(cachedDashboardHtml);
  } catch (err) {
    console.error('[web] Unhandled request error:', err);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error'); }
  }
}

http.createServer((req, res) => {
  handleHttpRequest(req, res);
}).listen(WEB_PORT, () => console.log(`[web] Dashboard running on port ${WEB_PORT}`));

console.log('Attempting to login with token:', process.env.BOT_TOKEN ? 'Token found' : 'Token missing');
client.login(process.env.BOT_TOKEN);
