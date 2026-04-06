require('dotenv').config();

const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
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
  activeMatches: [], // [{grouping, threadId, matchNumber}]
  roundResults: [], // [{matchNumber, grouping, winner, assassin, remainingCards, winPoints, losePoints}]
  setupMessage: null,
  setupChannelId: null, // Channel where setup message was posted
  rounds: [], // Array of rounds, each round contains multiple matches
  started: false, // Track if tournament has started
};

const commands = [
  new SlashCommandBuilder()
    .setName('tournament')
    .setDescription('Set up the Codenames tournament'),
];

client.once('clientReady', async () => {
  console.log('Bot is ready!');
  
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
    tournament.setupMessage = parsed.setupMessage;
    tournament.setupChannelId = parsed.setupChannelId;
    tournament.rounds = parsed.rounds || [];
    tournament.started = parsed.started || false;
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
      setupMessage: tournament.setupMessage,
      setupChannelId: tournament.setupChannelId,
      rounds: tournament.rounds,
      started: tournament.started,
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
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
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
      if (debugMode && adminComponents.length > 5) {
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
      tournament.scores = new Map([...tournament.players].map(id => [id, 0]));
      tournament.rounds = generateRounds(Array.from(tournament.players));
      
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
      const result = await allocateRound(interaction);
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
      tournament.currentRound++;
      tournament.currentRoundIndex = 0;
      await saveTournamentData();

      let autoAllocated = false;
      if (tournament.currentRound <= tournament.rounds.length) {
        allocateRound(interaction).catch(e => console.error('Auto-allocate failed:', e.message));
      }

      updateScoreboard(interaction.guild).catch(() => null);
      await interaction.editReply({ content: `Force ended ${skippedCount} active match(es) with 0 points. Next round allocating...` });
    } else if (customId === 'force_end_round') {
      await interaction.deferReply();

      for (const match of tournament.activeMatches) {
        try {
          const t = interaction.guild.channels.cache.get(match.threadId);
          if (t) t.setArchived(true).catch(() => null);
        } catch {}
      }
      const skippedCount2 = tournament.activeMatches.length;
      tournament.activeMatches = [];
      tournament.currentRound++;
      tournament.currentRoundIndex = 0;
      await saveTournamentData();

      let autoAllocated2 = false;
      if (tournament.currentRound <= tournament.rounds.length) {
        allocateRound(interaction).catch(e => console.error('Auto-allocate failed:', e.message));
        autoAllocated2 = true;
      }

      updateScoreboard(interaction.guild).catch(() => null);
      await interaction.editReply({ content: `Round force ended. ${skippedCount2} match(es) skipped.${autoAllocated2 ? ' Next round automatically allocated.' : ''}` });
    } else if (customId === 'admin_reset') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Capture message/channel IDs before wiping them so we can update the embed after reset
      const prevSetupMessage = tournament.setupMessage;
      const prevSetupChannelId = tournament.setupChannelId;

      tournament = {
        players: new Set(),
        currentRound: 0,
        currentRoundIndex: 0,
        playedGroupings: new Set(),
        scores: new Map(),
        currentGrouping: null,
        activeMatches: [],
        setupMessage: prevSetupMessage,
        setupChannelId: prevSetupChannelId,
        rounds: [],
        started: false,
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
      const winner = customId === 'log_blue_win' ? 'blue' : 'red';

      // Show buttons for assassin question instead of modal
      const assassinRow = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`assassin_yes_${winner}`)
            .setLabel('Yes, Assassin Hit')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`assassin_no_${winner}`)
            .setLabel('No, Not Assassin')
            .setStyle(ButtonStyle.Primary),
        );

      await interaction.reply({ content: 'Was the winning move an assassin hit?', components: [assassinRow], flags: MessageFlags.Ephemeral });
    } else if (customId.startsWith('assassin_')) {
      const parts = customId.split('_');
      const wasAssassin = parts[1] === 'yes';
      const winner = parts[2];

      // Now show modal for remaining cards
      const modal = new ModalBuilder()
        .setCustomId(`outcome_modal_${winner}_${wasAssassin ? 'assassin' : 'normal'}`)
        .setTitle(`${winner === 'blue' ? 'Blue' : 'Red'} Won - Game Details`);

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
    } else if (customId.startsWith('confirm_remove_')) {
      const userId = customId.split('_')[2];
      if (interaction.user.id === userId) {
        tournament.players.delete(userId);
        // Reply immediately to avoid interaction timeout, then update message in background
        await interaction.reply({ content: 'You have been removed from the tournament.', flags: MessageFlags.Ephemeral });
        await saveTournamentData();
        updateSignupMessage(interaction.channel); // fire-and-forget
      }
    } else if (customId.startsWith('cancel_remove_')) {
      const userId = customId.split('_')[2];
      if (interaction.user.id === userId) {
        await interaction.reply({ content: 'Cancelled. You remain signed up.', flags: MessageFlags.Ephemeral });
      }
    }
  } else if (interaction.isModalSubmit()) {
    const { customId } = interaction;
    if (customId.startsWith('outcome_modal_')) {
      const parts = customId.split('_');
      const winner = parts[2]; // blue or red
      const assassin = parts[3] === 'assassin';

      try {
        const remainingCardsValue = interaction.fields.getTextInputValue('remaining_cards');
        const remainingCards = parseInt(remainingCardsValue);

        if (isNaN(remainingCards) || remainingCards < 0 || remainingCards > 8) {
          await interaction.reply({ content: 'Invalid number of remaining cards. Must be 0-8.', flags: MessageFlags.Ephemeral });
          return;
        }

        // Find the active match for this thread
        const matchData = tournament.activeMatches.find(m => m.threadId === interaction.channelId);
        if (!matchData) {
          await interaction.reply({ content: 'Could not find an active match for this thread. It may have already been completed.', flags: MessageFlags.Ephemeral });
          return;
        }
        const grouping = matchData.grouping;

        // Calculate scores
        const winPoints = 3;
        const losePoints = assassin ? -1 : (remainingCards <= 3 ? 1 : 0);

        const bluePlayers = [grouping.blue.spymaster, grouping.blue.guesser];
        const redPlayers = [grouping.red.spymaster, grouping.red.guesser];

        if (winner === 'blue') {
          bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) + winPoints));
          redPlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) + losePoints));
        } else {
          redPlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) + winPoints));
          bluePlayers.forEach(id => tournament.scores.set(id, (tournament.scores.get(id) || 0) + losePoints));
        }

        // Remove this match from active matches
        tournament.activeMatches = tournament.activeMatches.filter(m => m.threadId !== interaction.channelId);
        tournament.currentRoundIndex++;

        // Record this match's outcome for the round summary
        tournament.roundResults.push({
          matchNumber: matchData.matchNumber,
          grouping,
          winner,
          assassin,
          remainingCards,
          winPoints,
          losePoints,
        });

        const remainingActive = tournament.activeMatches.length;
        const roundComplete = remainingActive === 0;

        // Reply immediately before any further async work
        let replyText = `Outcome logged. ${winner === 'blue' ? 'Blue' : 'Red'} won with ${remainingCards} cards remaining${assassin ? ' by assassin' : ''}.`;
        if (roundComplete) replyText += ' All matches complete — round advancing.';
        else replyText += ` ${remainingActive} match(es) still active this round.`;
        await interaction.reply(replyText);

        // Archive this thread in background
        interaction.channel.setArchived(true).catch(() => null);

        await saveTournamentData();
        updateScoreboard(interaction.guild).catch(() => null);

        // If all matches in round are done, advance and auto-allocate
        if (roundComplete) {
          tournament.currentRound++;
          tournament.currentRoundIndex = 0;
          await saveTournamentData();

          if (tournament.currentRound <= tournament.rounds.length) {
            allocateRound(interaction).catch(e => console.error('Auto-allocation failed:', e.message));
          }
        }
      } catch (error) {
        console.error('Error processing outcome:', error);
        try {
          await interaction.reply({ content: 'An error occurred while processing the outcome. Please try again.', flags: MessageFlags.Ephemeral });
        } catch {}
      }
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
          description += `Match ${m.matchNumber}: \ud83d\udd35 <@${m.grouping.blue.spymaster}> & <@${m.grouping.blue.guesser}> vs \ud83d\udd34 <@${m.grouping.red.spymaster}> & <@${m.grouping.red.guesser}>\n`;
        });
        description += '\n';
      }
      description += `**Scoreboard:**\n`;
      Array.from(tournament.scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .forEach((entry, idx) => { description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`; });
    }

    const embed = message.embeds[0];
    const updatedEmbed = EmbedBuilder.from(embed).setDescription(description);
    await message.edit({ embeds: [updatedEmbed] });
  } catch (error) {
    console.error('[updateScoreboard] Failed:', error.message);
  }
}

async function allocateRound(interaction) {
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

  // Always use the main tournament channel, not interaction.channel (which may be a thread)
  const mainChannel = await interaction.guild.channels.fetch(tournament.setupChannelId).catch(() => null);
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

      const results = tournament.roundResults.slice().sort((a, b) => a.matchNumber - b.matchNumber);
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
          summaryEmbed.addFields({
            name: `Game ${r.matchNumber} — ${winnerLabel} (${howStr})`,
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
        autoArchiveDuration: 60,
        reason: 'Tournament game thread',
      });

      const threadEmbed = new EmbedBuilder()
        .setTitle(`Round ${tournament.currentRound} \u2014 Match ${matchNumber}`)
        .setDescription(
          `**Blue Team:**\nSpymaster: <@${grouping.blue.spymaster}>\nGuesser: <@${grouping.blue.guesser}>\n\n` +
          `**Red Team:**\nSpymaster: <@${grouping.red.spymaster}>\nGuesser: <@${grouping.red.guesser}>\n\nPlay your game then log the result below.`
        )
        .setColor(0x00ff00);

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId('log_blue_win').setLabel('Blue Wins').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('log_red_win').setLabel('Red Wins').setStyle(ButtonStyle.Danger),
        );

      await thread.send({ embeds: [threadEmbed], components: [row] });
      tournament.activeMatches.push({ grouping, threadId: thread.id, matchNumber });
    } catch (e) {
      console.error(`Failed to create thread for match ${matchNumber}:`, e.message);
    }
  }

  if (tournament.activeMatches.length === 0) {
    return { success: false, message: 'Failed to create any game threads. Check bot permissions.' };
  }

  await saveTournamentData();
  return { success: true, message: `Round ${tournament.currentRound} allocated with ${tournament.activeMatches.length} match(es).` };
}


function getTournamentPrediction(playerCount) {
  if (playerCount < 4) return null;

  // Analytical formula: each player plays every other player in each of the
  // 4 role configs (blue-spy, blue-guess, red-spy, red-guess), so total games
  // = N*(N-1).  floor(N/4) games can run simultaneously per round.
  const totalGames = playerCount * (playerCount - 1);
  const concurrentGames = Math.floor(playerCount / 4);
  const totalRounds = Math.ceil(totalGames / concurrentGames);

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
  const configs = [
    `${assignment.blue.spymaster}-${assignment.blue.guesser}-blue-spymaster`,
    `${assignment.blue.guesser}-${assignment.blue.spymaster}-blue-guesser`,
    `${assignment.red.spymaster}-${assignment.red.guesser}-red-spymaster`,
    `${assignment.red.guesser}-${assignment.red.spymaster}-red-guesser`,
  ];
  
  // Check if all are unplayed
  for (const config of configs) {
    if (playedConfigs.has(config)) {
      return false;
    }
  }
  
  // Mark all as played
  for (const config of configs) {
    playedConfigs.add(config);
  }
  
  return true;
}

client.on('error', (error) => {
  console.error('Client error:', error);
});

console.log('Attempting to login with token:', process.env.BOT_TOKEN ? 'Token found' : 'Token missing');
client.login(process.env.BOT_TOKEN);