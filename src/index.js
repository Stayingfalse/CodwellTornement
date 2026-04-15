require('dotenv').config();

const http = require('http');
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionsBitField } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');

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
  activeMatches: [], // [{grouping, threadId, matchNumber, gamePhase, game1Result, matchCreatedAt}]
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
};

// Round timer handles (in-memory only)
let roundWarningTimer = null;
let roundExpiryTimer = null;
let threadKeepAliveTimer = null;

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
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const data = await fs.readFile(TOURNAMENT_FILE, 'utf-8');
    const parsed = JSON.parse(data);
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
    console.log('Tournament data loaded from storage');
  } catch (error) {
    console.log('No previous tournament data found, starting fresh');
  }
}

async function saveTournamentData() {
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
    };
    await fs.writeFile(TOURNAMENT_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Failed to save tournament data:', error);
  }
}

function buildSignupDescription() {
  const playerList = Array.from(tournament.players);
  console.log(`[buildSignupDescription] Players in Set (${playerList.length}):`, playerList);

  let description = 'Sign up for the tournament and manage it with the buttons below.\n\n**Signed Up Players:**\n';
  if (playerList.length > 0) {
    description += playerList.map(id => id.startsWith('debug_') ? `\`${id}\`` : `<@${id}>`).join('\n');
  } else {
    description += 'None yet';
  }

  if (playerList.length >= 4) {
    const prediction = getTournamentPrediction(playerList.length);
    if (prediction) {
      description += `\n\n**Tournament Prediction:**\n`;
      description += `${prediction.totalGames} Total Games • ~${prediction.rounds} Rounds`;
      description += `\n${prediction.concurrentGames} game${prediction.concurrentGames === 1 ? '' : 's'} per round`;
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
        sortedScores.forEach((entry, idx) => {
          description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`;
        });

        embed = new EmbedBuilder()
          .setTitle('Codenames Tournament')
          .setDescription(description)
          .setColor(0x00ff00);

        row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('admin')
              .setLabel('Admin')
              .setStyle(ButtonStyle.Secondary),
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
              .setCustomId('admin')
              .setLabel('Admin')
              .setStyle(ButtonStyle.Secondary),
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

      const adminRow = new ActionRowBuilder().addComponents(adminComponents.slice(0, 5));
      const adminRows = [adminRow];
      if (adminComponents.length > 5) {
        adminRows.push(new ActionRowBuilder().addComponents(adminComponents.slice(5)));
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
      tournament.rounds = generateRounds(Array.from(tournament.players));

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
            sortedScores.forEach((entry, idx) => {
              description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`;
            });
            
            const embed = message.embeds[0];
            const updatedEmbed = EmbedBuilder.from(embed)
              .setDescription(description)
              .setColor(0x00ff00);
            await message.edit({ embeds: [updatedEmbed] });
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
    } else if (customId === 'admin_force_end') {
      if (tournament.activeMatches.length === 0) {
        await interaction.reply({ content: 'No matches currently active to force end.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Archive all active threads (fire-and-forget)
      for (const match of tournament.activeMatches) {
        try {
          const t = interaction.guild.channels.cache.get(match.threadId);
          if (t) t.setArchived(true).catch(() => null);
        } catch {}
      }
      const skippedCount = tournament.activeMatches.length;
      tournament.activeMatches = [];
      clearRoundTimers();
      tournament.currentRound++;
      tournament.currentRoundIndex = 0;
      await saveTournamentData();

      let autoAllocated = false;
      if (tournament.currentRound <= tournament.rounds.length) {
        allocateRound(interaction.guild).catch(e => console.error('Auto-allocate failed:', e.message));
      }

      updateScoreboard(interaction.guild).catch(() => null);
      await interaction.editReply({ content: `Force ended ${skippedCount} active match(es) with 0 points. Next round allocating...` });
    } else if (customId === 'force_end_round') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      for (const match of tournament.activeMatches) {
        try {
          const t = interaction.guild.channels.cache.get(match.threadId);
          if (t) t.setArchived(true).catch(() => null);
        } catch {}
      }
      const skippedCount2 = tournament.activeMatches.length;
      tournament.activeMatches = [];
      clearRoundTimers();
      tournament.currentRound++;
      tournament.currentRoundIndex = 0;
      await saveTournamentData();

      let autoAllocated2 = false;
      if (tournament.currentRound <= tournament.rounds.length) {
        allocateRound(interaction.guild).catch(e => console.error('Auto-allocate failed:', e.message));
        autoAllocated2 = true;
      }

      updateScoreboard(interaction.guild).catch(() => null);
      await interaction.editReply({ content: `Round force ended. ${skippedCount2} match(es) skipped.${autoAllocated2 ? ' Next round automatically allocated.' : ''}` });
    } else if (customId === 'admin_reset') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Capture message/channel IDs before wiping them so we can update the embed after reset
      const prevSetupMessage = tournament.setupMessage;
      const prevSetupChannelId = tournament.setupChannelId;

      clearRoundTimers();
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
                    .setCustomId('admin')
                    .setLabel('Admin')
                    .setStyle(ButtonStyle.Secondary),
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

      const isGame2 = customId.endsWith('_g2');
      const expectedPhase = isGame2 ? 2 : 1;
      const currentPhase = matchData.gamePhase ?? 1;
      if (currentPhase !== expectedPhase) {
        await interaction.reply({ content: `These buttons are for Game ${expectedPhase}, but this match is currently on Game ${currentPhase}.`, flags: MessageFlags.Ephemeral });
        return;
      }

      const winner = (customId === 'log_blue_win' || customId === 'log_blue_win_g2') ? 'blue' : 'red';

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

      await interaction.reply({ content: `Game ${expectedPhase}: Was the winning move an assassin hit?`, components: [assassinRow], flags: MessageFlags.Ephemeral });
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

      if (wasAssassin) {
        await processGameResult(interaction, matchData2, winner, true, 0);
        return;
      }

      // Not an assassin — show modal for remaining cards
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
    } else if (customId === 'timeout_force_end') {
      const adminRoleId = process.env.ADMIN_ROLE_ID;
      if (!interaction.member.roles.cache.has(adminRoleId)) {
        await interaction.reply({ content: 'Only admins can force end the round.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const skippedT = tournament.activeMatches.length;
      for (const match of tournament.activeMatches) {
        try {
          const t = await interaction.guild.channels.fetch(match.threadId).catch(() => null);
          if (t) t.setArchived(true).catch(() => null);
        } catch {}
      }
      tournament.activeMatches = [];
      clearRoundTimers();
      tournament.roundDeadline = null;
      tournament.currentRound++;
      tournament.currentRoundIndex = 0;
      await saveTournamentData();
      updateScoreboard(interaction.guild).catch(() => null);
      if (tournament.currentRound <= tournament.rounds.length) {
        allocateRound(interaction.guild).catch(e => console.error('Auto-allocate after timeout failed:', e.message));
      }
      await interaction.editReply({ content: `Timeout force end: ${skippedT} match(es) skipped. Advancing...` });
    } else if (customId.startsWith('correct_result_')) {
      // Only match players or admins can correct a result
      const adminRoleId = process.env.ADMIN_ROLE_ID;
      const isAdminC = interaction.member.roles.cache.has(adminRoleId);

      const corrParts = customId.split('_');
      const matchNumToCorrect = parseInt(corrParts[2]);
      const gameIndexToCorrect = corrParts[3] ? parseInt(corrParts[3]) : 1;

      if (gameIndexToCorrect === 2) {
        // Correct Game 2 result
        const result2Idx = tournament.roundResults.findIndex(r => r.matchNumber === matchNumToCorrect && r.gameIndex === 2);
        if (result2Idx === -1) {
          await interaction.reply({ content: 'No recorded Game 2 result found to correct. It may have already been corrected.', flags: MessageFlags.Ephemeral });
          return;
        }
        const prevResult2 = tournament.roundResults[result2Idx];
        const result1Idx = tournament.roundResults.findIndex(r => r.matchNumber === matchNumToCorrect && r.gameIndex === 1);
        const prevResult1 = result1Idx !== -1 ? tournament.roundResults[result1Idx] : null;

        const matchPlayers2 = [
          prevResult2.grouping.blue.spymaster, prevResult2.grouping.blue.guesser,
          prevResult2.grouping.red.spymaster,  prevResult2.grouping.red.guesser,
        ];
        if (!isAdminC && !matchPlayers2.includes(interaction.user.id)) {
          await interaction.reply({ content: 'Only players in this game or an admin can correct this result.', flags: MessageFlags.Ephemeral });
          return;
        }

        // Reverse Game 2 scores
        const bluePlayers2 = [prevResult2.grouping.blue.spymaster, prevResult2.grouping.blue.guesser];
        const redPlayers2  = [prevResult2.grouping.red.spymaster,  prevResult2.grouping.red.guesser];
        if (prevResult2.winner === 'blue') {
          bluePlayers2.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) - prevResult2.winPoints));
          redPlayers2.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) - prevResult2.losePoints));
        } else {
          redPlayers2.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) - prevResult2.winPoints));
          bluePlayers2.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) - prevResult2.losePoints));
        }

        // Remove both results from roundResults (remove highest index first to avoid shifting)
        const indicesToRemove = [result2Idx, result1Idx !== -1 ? result1Idx : -1].filter(i => i !== -1).sort((a, b) => b - a);
        for (const idx of indicesToRemove) tournament.roundResults.splice(idx, 1);

        // Game 2 grouping IS the swapped grouping — swap back to get the original
        const originalGrouping = getSwappedGrouping(prevResult2.grouping);
        const game1Result = prevResult1 ? {
          winner: prevResult1.winner,
          assassin: prevResult1.assassin,
          remainingCards: prevResult1.remainingCards,
          winPoints: prevResult1.winPoints,
          losePoints: prevResult1.losePoints,
        } : null;

        tournament.currentRoundIndex = Math.max(0, tournament.currentRoundIndex - 1);
        tournament.activeMatches.push({
          grouping: originalGrouping,
          threadId: interaction.channelId,
          matchNumber: matchNumToCorrect,
          gamePhase: 2,
          game1Result,
        });

        await saveTournamentData();
        updateScoreboard(interaction.guild).catch(() => null);

        const relogRow2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('log_blue_win_g2').setLabel('Blue Wins').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('log_red_win_g2').setLabel('Red Wins').setStyle(ButtonStyle.Danger),
        );
        await interaction.reply({ content: '⚠️ Game 2 result reversed. Please re-submit the correct outcome:', components: [relogRow2] });
      } else {
        // Legacy correction (pre-update results that have no gameIndex)
        const resultIdx = tournament.roundResults.findIndex(r => r.matchNumber === matchNumToCorrect && !r.gameIndex);
        if (resultIdx === -1) {
          await interaction.reply({ content: 'No recorded result found to correct. It may have already been corrected.', flags: MessageFlags.Ephemeral });
          return;
        }
        const prevResult = tournament.roundResults[resultIdx];
        const matchPlayers = [
          prevResult.grouping.blue.spymaster, prevResult.grouping.blue.guesser,
          prevResult.grouping.red.spymaster,  prevResult.grouping.red.guesser,
        ];
        if (!isAdminC && !matchPlayers.includes(interaction.user.id)) {
          await interaction.reply({ content: 'Only players in this game or an admin can correct this result.', flags: MessageFlags.Ephemeral });
          return;
        }

        const bluePlayers = [prevResult.grouping.blue.spymaster, prevResult.grouping.blue.guesser];
        const redPlayers  = [prevResult.grouping.red.spymaster,  prevResult.grouping.red.guesser];
        if (prevResult.winner === 'blue') {
          bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) - prevResult.winPoints));
          redPlayers.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) - prevResult.losePoints));
        } else {
          redPlayers.forEach(id =>  tournament.scores.set(id, (tournament.scores.get(id) || 0) - prevResult.winPoints));
          bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) - prevResult.losePoints));
        }

        tournament.roundResults.splice(resultIdx, 1);
        tournament.currentRoundIndex = Math.max(0, tournament.currentRoundIndex - 1);
        tournament.activeMatches.push({
          grouping: prevResult.grouping,
          threadId: interaction.channelId,
          matchNumber: prevResult.matchNumber,
          gamePhase: 1,
          game1Result: null,
        });

        await saveTournamentData();
        updateScoreboard(interaction.guild).catch(() => null);

        const relogRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('log_blue_win').setLabel('Blue Wins').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('log_red_win').setLabel('Red Wins').setStyle(ButtonStyle.Danger),
        );
        await interaction.reply({ content: '⚠️ Previous result reversed. Please re-submit the correct outcome:', components: [relogRow] });
      }
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
    }
  } else if (interaction.isModalSubmit()) {
    const { customId } = interaction;
    if (customId.startsWith('outcome_modal_')) {
      const parts = customId.split('_');
      const winner = parts[2]; // blue or red
      const assassin = parts[3] === 'assassin';
      const gamePhase = parts[4] ? parseInt(parts[4]) : 1;

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
    if (tournament.currentRound > tournament.rounds.length) {
      description = `**Tournament Complete!**\n\n**Final Scoreboard:**\n`;
      Array.from(tournament.scores.entries())
        .sort((a, b) => b[1] - a[1])
        .forEach((entry, idx) => { description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`; });
    } else {
      const roundMatches = tournament.rounds[tournament.currentRound - 1] || [];
      const completedInRound = roundMatches.length - tournament.activeMatches.length;
      description = `**Tournament Live - Round ${tournament.currentRound}/${tournament.rounds.length}**\n`;
      description += `${completedInRound}/${roundMatches.length} matches completed\n\n`;
      if (tournament.activeMatches.length > 0) {
        description += `**Active Matches:**\n`;
        tournament.activeMatches.forEach(m => {
          const activePhase = m.gamePhase ?? 1;
          const activeGrouping = activePhase === 2 ? getSwappedGrouping(m.grouping) : m.grouping;
          description += `Match ${m.matchNumber} (Game ${activePhase}/2): 🔵 <@${activeGrouping.blue.spymaster}> & <@${activeGrouping.blue.guesser}> vs 🔴 <@${activeGrouping.red.spymaster}> & <@${activeGrouping.red.guesser}>\n`;
        });
        description += '\n';
      }
      description += `**Scoreboard:**\n`;
      Array.from(tournament.scores.entries())
        .sort((a, b) => b[1] - a[1])
        .forEach((entry, idx) => { description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`; });
    }

    const embed = message.embeds[0];
    const updatedEmbed = EmbedBuilder.from(embed).setDescription(description);
    await message.edit({ embeds: [updatedEmbed] });
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
      if (results.length > 0) {
        results.forEach(r => {
          const howStr = r.assassin ? 'assassin' : `${r.remainingCards} card${r.remainingCards !== 1 ? 's' : ''} left`;
          const winnerLabel = r.winner === 'blue' ? '🔵 Blue wins' : '🔴 Red wins';
          const wSpy  = r.winner === 'blue' ? r.grouping.blue.spymaster  : r.grouping.red.spymaster;
          const wGues = r.winner === 'blue' ? r.grouping.blue.guesser    : r.grouping.red.guesser;
          const lSpy  = r.winner === 'blue' ? r.grouping.red.spymaster   : r.grouping.blue.spymaster;
          const lGues = r.winner === 'blue' ? r.grouping.red.guesser     : r.grouping.blue.guesser;
          const ptsLine = r.losePoints !== 0
            ? `+${r.winPoints} / ${r.losePoints > 0 ? '+' : ''}${r.losePoints} pts`
            : `+${r.winPoints} / +0 pts`;
          const gameLabel = r.gameIndex ? ` (Game ${r.gameIndex})` : '';
          summaryEmbed.addFields({
            name: `Match ${r.matchNumber}${gameLabel} — ${winnerLabel} (${howStr})`,
            value: `🔵 <@${r.grouping.blue.spymaster}> & <@${r.grouping.blue.guesser}> vs 🔴 <@${r.grouping.red.spymaster}> & <@${r.grouping.red.guesser}>\n` +
                   `🏆 <@${wSpy}> & <@${wGues}>  ${ptsLine}  ·  😔 <@${lSpy}> & <@${lGues}>`,
          });
        });
      } else {
        summaryEmbed.setDescription('No match results recorded.');
      }
      await channel.send({ embeds: [summaryEmbed] });

      // Clear results for the next round
      tournament.roundResults = [];
      await saveTournamentData();
    } catch (e) { console.error('Failed to post round summary:', e.message); }
  }

  // Allocate all matches in this round simultaneously
  const channel = mainChannel;

  // Post round header with deadline (deadline is set just after the loop, so compute it now for display)
  const timeoutDaysHeader = parseFloat(process.env.ROUND_TIMEOUT_DAYS) || 14;
  const deadlineMs = Date.now() + timeoutDaysHeader * 24 * 60 * 60 * 1000;
  const deadlineTs = Math.floor(deadlineMs / 1000);
  const headerEmbed = new EmbedBuilder()
    .setTitle(`📋 Round ${tournament.currentRound} — ${currentRoundMatches.length} Game${currentRoundMatches.length !== 1 ? 's' : ''}`)
    .setDescription(`Complete all games below before <t:${deadlineTs}:F> (<t:${deadlineTs}:R>).`)
    .setColor(0x5865f2);
  await channel.send({ embeds: [headerEmbed] });

  for (let i = 0; i < currentRoundMatches.length; i++) {
    const grouping = currentRoundMatches[i];
    const matchNumber = i + 1;

    const embed = new EmbedBuilder()
      .setTitle(`Round ${tournament.currentRound} — Game ${matchNumber}`)
      .setDescription(
        `<@${grouping.blue.spymaster}> - Spymaster, <@${grouping.blue.guesser}> - Guesser\n**vs**\n` +
        `<@${grouping.red.spymaster}> - Spymaster, <@${grouping.red.guesser}> - Guesser`
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
        .setTitle(`Round ${tournament.currentRound} \u2014 Match ${matchNumber} (Game 1 of 2)`)
        .setDescription(
          `**Blue Team:**\nSpymaster: <@${grouping.blue.spymaster}>\nGuesser: <@${grouping.blue.guesser}>\n\n` +
          `**Red Team:**\nSpymaster: <@${grouping.red.spymaster}>\nGuesser: <@${grouping.red.guesser}>\n\nPlay Game 1 then log the result below. Game 2 will start automatically with roles swapped.`
        )
        .setColor(0x00ff00);

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId('log_blue_win').setLabel('Blue Wins').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('log_red_win').setLabel('Red Wins').setStyle(ButtonStyle.Danger),
        );

      await thread.send({ embeds: [threadEmbed], components: [row] });
      tournament.activeMatches.push({ grouping, threadId: thread.id, matchNumber, gamePhase: 1, game1Result: null, matchCreatedAt: new Date().toISOString() });
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

async function sendThreadKeepAlive(guild) {
  if (!tournament.started || tournament.activeMatches.length === 0) return;
  const msg = KEEPALIVE_MESSAGES[Math.floor(Math.random() * KEEPALIVE_MESSAGES.length)];
  for (const match of tournament.activeMatches) {
    try {
      const thread = await guild.channels.fetch(match.threadId).catch(() => null);
      if (!thread) continue;
      // Unarchive if Discord auto-archived it
      if (thread.archived) await thread.setArchived(false).catch(() => null);
      await thread.send(msg);
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
  const completedNums  = new Set(tournament.roundResults.map(r => r.matchNumber));
  const stillActive    = tournament.activeMatches;

  const expiredEmbed = new EmbedBuilder()
    .setTitle(`⏰ Round ${tournament.currentRound} Timer Expired`)
    .setColor(0xff4500)
    .setDescription(`The round deadline was <t:${ts}:F>.`);

  if (completedNums.size > 0) {
    const completedLines = tournament.roundResults
      .sort((a, b) => a.matchNumber - b.matchNumber)
      .map(r => {
        const wLabel = r.winner === 'blue' ? '🔵 Blue' : '🔴 Red';
        return `Game ${r.matchNumber}: **${wLabel}** won`;
      }).join('\n');
    expiredEmbed.addFields({ name: `✅ Completed (${completedNums.size}/${allRoundMatches.length})`, value: completedLines });
  }

  if (stillActive.length > 0) {
    const activeLines = stillActive
      .sort((a, b) => a.matchNumber - b.matchNumber)
      .map(m => `Game ${m.matchNumber}: 🔵 <@${m.grouping.blue.spymaster}> & <@${m.grouping.blue.guesser}> vs 🔴 <@${m.grouping.red.spymaster}> & <@${m.grouping.red.guesser}>`)
      .join('\n');
    expiredEmbed.addFields({ name: `⏳ Still Active (${stillActive.length}/${allRoundMatches.length})`, value: activeLines });
  }

  const forceRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('timeout_force_end')
      .setLabel(`Force End & Advance to Round ${tournament.currentRound + 1}`)
      .setStyle(ButtonStyle.Danger),
  );

  await mainChannel.send({ embeds: [expiredEmbed], components: [forceRow] });
}

function getTournamentPrediction(playerCount) {
  if (playerCount < 4) return null;

  // Analytical formula: each player plays every other player in each of the
  // 4 role configs (blue-spy, blue-guess, red-spy, red-guess), so total games
  // = N*(N-1).  floor(N/4) games can run simultaneously per round.
  const totalGames = playerCount * (playerCount - 1);
  const concurrentGames = Math.floor(playerCount / 4);
  const totalRounds = Math.ceil((totalGames / 2) / concurrentGames);

  return {
    rounds: totalRounds,
    concurrentGames,
    totalGames,
  };
}

function generateGrouping(players) {
  // Shuffle players
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  return {
    blue: { spymaster: shuffled[0], guesser: shuffled[1] },
    red: { spymaster: shuffled[2], guesser: shuffled[3] },
  };
}

function getSwappedGrouping(grouping) {
  return {
    blue: { spymaster: grouping.blue.guesser, guesser: grouping.blue.spymaster },
    red:  { spymaster: grouping.red.guesser,  guesser: grouping.red.spymaster },
  };
}

function generateRounds(players) {
  const rounds = [];
  const pairs = new Map(); // Track all player pairings and their configurations
  
  // Initialize all pairs - each pair needs 4 configurations
  // Config: (team, role) where team is blue/red and role is spymaster/guesser
  for (let i = 0; i < players.length; i++) {
    for (let j = 0; j < players.length; j++) {
      if (i === j) continue;
      const key = `${players[i]}-${players[j]}`;
      pairs.set(key, [
        { team: 'blue', role: 'spymaster' },  // i is spymaster on blue, j is guesser
        { team: 'blue', role: 'guesser' },     // i is guesser on blue, j is spymaster
        { team: 'red', role: 'spymaster' },    // i is spymaster on red, j is guesser
        { team: 'red', role: 'guesser' },      // i is guesser on red, j is spymaster
      ]);
    }
  }
  
  const playedConfigs = new Set();
  
  while (playedConfigs.size < pairs.size * 4) {
    const round = [];
    const playersUsedThisRound = new Set();

    // Keep adding matches to this round until no more can be found for unused players
    let continueRound = true;
    while (continueRound) {
      let foundMatch = false;

      matchSearch:
      for (let i = 0; i < players.length; i++) {
        if (playersUsedThisRound.has(players[i])) continue;
        
        for (let j = i + 1; j < players.length; j++) {
          if (playersUsedThisRound.has(players[j])) continue;
          
          for (let k = 0; k < players.length; k++) {
            if (k === i || k === j || playersUsedThisRound.has(players[k])) continue;
            
            for (let l = k + 1; l < players.length; l++) {
              if (l === i || l === j || playersUsedThisRound.has(players[l])) continue;
              
              // We have 4 players: i, j, k, l
              const pairings = [
                { blue: [players[i], players[j]], red: [players[k], players[l]] },
                { blue: [players[i], players[k]], red: [players[j], players[l]] },
                { blue: [players[i], players[l]], red: [players[j], players[k]] },
              ];
              
              for (const pairing of pairings) {
                const roleAssignments = [
                  { 
                    blue: { spymaster: pairing.blue[0], guesser: pairing.blue[1] },
                    red: { spymaster: pairing.red[0], guesser: pairing.red[1] }
                  },
                  {
                    blue: { spymaster: pairing.blue[1], guesser: pairing.blue[0] },
                    red: { spymaster: pairing.red[0], guesser: pairing.red[1] }
                  },
                  {
                    blue: { spymaster: pairing.blue[0], guesser: pairing.blue[1] },
                    red: { spymaster: pairing.red[1], guesser: pairing.red[0] }
                  },
                  {
                    blue: { spymaster: pairing.blue[1], guesser: pairing.blue[0] },
                    red: { spymaster: pairing.red[1], guesser: pairing.red[0] }
                  },
                ];
                
                for (const assignment of roleAssignments) {
                  const allUnplayed = checkAndMarkConfigs(assignment, playedConfigs);
                  
                  if (allUnplayed) {
                    round.push(assignment);
                    playersUsedThisRound.add(pairing.blue[0]);
                    playersUsedThisRound.add(pairing.blue[1]);
                    playersUsedThisRound.add(pairing.red[0]);
                    playersUsedThisRound.add(pairing.red[1]);
                    foundMatch = true;
                    break matchSearch; // break all nested loops, restart round search
                  }
                }
              }
            }
          }
        }
      }

      if (!foundMatch) continueRound = false;
    }
    
    if (round.length > 0) {
      rounds.push(round);
    } else if (playedConfigs.size < pairs.size * 4) {
      // No more perfect pairings possible, break to avoid infinite loop
      console.warn('Could not complete full round-robin schedule');
      break;
    }
  }
  
  return rounds;
}

function checkAndMarkConfigs(assignment, playedConfigs) {
  const swapped = getSwappedGrouping(assignment);
  const configs = [
    `${assignment.blue.spymaster}-${assignment.blue.guesser}-blue-spymaster`,
    `${assignment.blue.guesser}-${assignment.blue.spymaster}-blue-guesser`,
    `${assignment.red.spymaster}-${assignment.red.guesser}-red-spymaster`,
    `${assignment.red.guesser}-${assignment.red.spymaster}-red-guesser`,
    `${swapped.blue.spymaster}-${swapped.blue.guesser}-blue-spymaster`,
    `${swapped.blue.guesser}-${swapped.blue.spymaster}-blue-guesser`,
    `${swapped.red.spymaster}-${swapped.red.guesser}-red-spymaster`,
    `${swapped.red.guesser}-${swapped.red.spymaster}-red-guesser`,
  ];
  for (const config of configs) {
    if (playedConfigs.has(config)) return false;
  }
  for (const config of configs) {
    playedConfigs.add(config);
  }
  return true;
}

async function processGameResult(interaction, matchData, winner, assassin, remainingCards) {
  const submittedBy = interaction.user.id;
  const submittedAt = new Date().toISOString();
  const gamePhase = matchData.gamePhase ?? 1;
  const currentGrouping = gamePhase === 2 ? getSwappedGrouping(matchData.grouping) : matchData.grouping;

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

  if (gamePhase === 1) {
    matchData.game1Result = { winner, assassin, remainingCards, winPoints, losePoints, submittedAt, submittedBy };
    matchData.gamePhase = 2;
    await saveTournamentData();
    updateScoreboard(interaction.guild).catch(() => null);

    const replyText = `**Game 1** result logged: **${winnerLabel}** won (${howStr}).\nWin: **+${winPoints} pts** · Lose: **${losePoints > 0 ? '+' : ''}${losePoints} pts**\n\n_Game 2 is starting — roles have been swapped!_`;
    await interaction.reply({ content: replyText });

    const swapped = getSwappedGrouping(matchData.grouping);
    const game2Embed = new EmbedBuilder()
      .setTitle(`Match ${matchData.matchNumber} — Game 2 of 2`)
      .setDescription(
        `Roles have been swapped!\n\n` +
        `**Blue Team:**\nSpymaster: <@${swapped.blue.spymaster}>\nGuesser: <@${swapped.blue.guesser}>\n\n` +
        `**Red Team:**\nSpymaster: <@${swapped.red.spymaster}>\nGuesser: <@${swapped.red.guesser}>\n\nPlay Game 2 then log the result below.`
      )
      .setColor(0xff9900);

    const game2Row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('log_blue_win_g2').setLabel('Blue Wins').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('log_red_win_g2').setLabel('Red Wins').setStyle(ButtonStyle.Danger),
    );

    await interaction.channel.send({ embeds: [game2Embed], components: [game2Row] });
  } else {
    // Game 2 complete — push both results and clean up
    const g1 = matchData.game1Result;
    tournament.roundResults.push({
      matchNumber: matchData.matchNumber,
      gameIndex: 1,
      grouping: matchData.grouping,
      winner: g1.winner,
      assassin: g1.assassin,
      remainingCards: g1.remainingCards,
      winPoints: g1.winPoints,
      losePoints: g1.losePoints,
    });
    tournament.roundResults.push({
      matchNumber: matchData.matchNumber,
      gameIndex: 2,
      grouping: currentGrouping,
      winner,
      assassin,
      remainingCards,
      winPoints,
      losePoints,
    });

    // Push both games to the permanent history
    tournament.history.push({
      roundNumber: tournament.currentRound,
      matchNumber: matchData.matchNumber,
      game: 1,
      grouping: matchData.grouping,
      winner: g1.winner,
      assassin: g1.assassin,
      remainingCards: g1.remainingCards,
      winPoints: g1.winPoints,
      losePoints: g1.losePoints,
      matchCreatedAt: matchData.matchCreatedAt || null,
      submittedAt: g1.submittedAt || null,
      submittedBy: g1.submittedBy || null,
    });
    tournament.history.push({
      roundNumber: tournament.currentRound,
      matchNumber: matchData.matchNumber,
      game: 2,
      grouping: currentGrouping,
      winner,
      assassin,
      remainingCards,
      winPoints,
      losePoints,
      matchCreatedAt: matchData.matchCreatedAt || null,
      submittedAt,
      submittedBy,
    });

    tournament.activeMatches = tournament.activeMatches.filter(m => m.threadId !== interaction.channelId);
    tournament.currentRoundIndex++;

    const remainingActive = tournament.activeMatches.length;
    const roundComplete = remainingActive === 0;

    let replyText = `**Game 2** result logged: **${winnerLabel}** won (${howStr}).\nWin: **+${winPoints} pts** · Lose: **${losePoints > 0 ? '+' : ''}${losePoints} pts**`;
    if (roundComplete) replyText += '\nAll matches complete — round advancing.';
    else replyText += `\n${remainingActive} match(es) still active this round.`;

    const correctRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`correct_result_${matchData.matchNumber}_2`)
        .setLabel('Correct Game 2 Result')
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content: replyText, components: [correctRow] });

    await saveTournamentData();
    updateScoreboard(interaction.guild).catch(() => null);

    if (roundComplete) {
      clearRoundTimers();
      tournament.currentRound++;
      tournament.currentRoundIndex = 0;
      await saveTournamentData();
      if (tournament.currentRound <= tournament.rounds.length) {
        allocateRound(interaction.guild).catch(e => console.error('Auto-allocation failed:', e.message));
      }
    }
  }
}

client.on('error', (error) => {
  console.error('Client error:', error);
});

// ----- Web dashboard -----
function buildWebData() {
  return {
    started: tournament.started,
    currentRound: tournament.currentRound,
    totalRounds: tournament.rounds.length,
    tournamentStartedAt: tournament.tournamentStartedAt,
    roundStartedAt: tournament.roundStartedAt,
    playerNames: tournament.playerNames,
    scores: Array.from(tournament.scores.entries()).sort((a, b) => b[1] - a[1]),
    rounds: tournament.rounds,
    history: tournament.history,
    activeMatches: tournament.activeMatches,
  };
}

let cachedDashboardHtml = null;
try {
  cachedDashboardHtml = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'));
} catch {
  console.warn('[web] public/index.html not found — dashboard will return 404');
}

const WEB_PORT = parseInt(process.env.WEB_PORT) || 80;
http.createServer((req, res) => {
  if (req.url === '/api') {
    const payload = JSON.stringify(buildWebData());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(payload);
  } else if (cachedDashboardHtml) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(cachedDashboardHtml);
  } else {
    res.writeHead(404);
    res.end('Dashboard not available. Ensure public/index.html exists.');
  }
}).listen(WEB_PORT, () => console.log(`[web] Dashboard running on port ${WEB_PORT}`));

console.log('Attempting to login with token:', process.env.BOT_TOKEN ? 'Token found' : 'Token missing');
client.login(process.env.BOT_TOKEN);