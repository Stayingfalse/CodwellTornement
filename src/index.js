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
  currentGrouping: null,
  currentThread: null,
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
    console.log('Commands registered');
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
    tournament.currentGrouping = parsed.currentGrouping;
    tournament.currentThread = parsed.currentThread;
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
      currentGrouping: tournament.currentGrouping,
      currentThread: tournament.currentThread,
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

client.on('interactionCreate', async (interaction) => {
  if (interaction.isCommand()) {
    const { commandName } = interaction;

    if (commandName === 'tournament') {
      let embed;
      let row;

      if (tournament.started) {
        // Tournament is live - show current status and scores
        let description = `**Tournament Live - Round ${tournament.currentRound}**\n`;
        description += `Match ${tournament.currentRoundIndex}/${tournament.rounds[tournament.currentRound - 1]?.length || 0}\n\n`;
        
        if (tournament.currentGrouping) {
          description += `**Current Match:**\n`;
          description += `🔵 Blue: <@${tournament.currentGrouping.blue.spymaster}> (SM) vs <@${tournament.currentGrouping.blue.guesser}> (G)\n`;
          description += `🔴 Red: <@${tournament.currentGrouping.red.spymaster}> (SM) vs <@${tournament.currentGrouping.red.guesser}> (G)\n\n`;
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
        let description = 'Sign up for the tournament and manage it with the buttons below.\n\n**Signed Up Players:**\n' + (tournament.players.size > 0 ? Array.from(tournament.players).map(id => `<@${id}>`).join('\n') : 'None yet');
        
        // Add prediction if 4+ players
        if (tournament.players.size >= 4) {
          const prediction = getTournamentPrediction(tournament.players.size);
          if (prediction) {
            description += `\n\n**Tournament Prediction:**\n${prediction.rounds} Rounds • ${prediction.totalGames} Total Games`;
          }
        }

        embed = new EmbedBuilder()
          .setTitle('Codenames Tournament')
          .setDescription(description)
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
        try {
          // Only edit message if we have a valid message ID and can access the channel
          if (tournament.setupMessage) {
            const channel = interaction.channel;
            const message = await channel.messages.fetch(tournament.setupMessage).catch(() => null);
            if (message) {
              const embed = message.embeds[0];
              let description = 'Sign up for the tournament and manage it with the buttons below.\n\n**Signed Up Players:**\n' + (tournament.players.size > 0 ? Array.from(tournament.players).map(id => `<@${id}>`).join('\n') : 'None yet');
              
              // Add prediction if 4+ players
              if (tournament.players.size >= 4) {
                const prediction = getTournamentPrediction(tournament.players.size);
                if (prediction) {
                  description += `\n\n**Tournament Prediction:**\n${prediction.rounds} Rounds • ${prediction.totalGames} Total Games`;
                }
              }
              
              const updatedEmbed = EmbedBuilder.from(embed).setDescription(description);
              await message.edit({ embeds: [updatedEmbed] });
            }
          }
        } catch (error) {
          console.error('Failed to edit setup message:', error.message);
        }
        await interaction.reply({ content: 'You have signed up!', flags: MessageFlags.Ephemeral });
        await saveTournamentData();
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

      const adminRow = new ActionRowBuilder()
        .addComponents(
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
        );

      await interaction.reply({ embeds: [adminEmbed], components: [adminRow], flags: MessageFlags.Ephemeral });
    } else if (customId === 'admin_start') {
      if (tournament.players.size < 4) {
        await interaction.reply({ content: 'Need at least 4 players to start.', flags: MessageFlags.Ephemeral });
        return;
      }
      tournament.currentRound = 1;
      tournament.currentRoundIndex = 0;
      tournament.started = true;
      tournament.scores = new Map([...tournament.players].map(id => [id, 0]));
      tournament.rounds = generateRounds(Array.from(tournament.players));
      
      // Update the setup message to show tournament live
      try {
        if (tournament.setupMessage) {
          const channel = interaction.channel;
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
      await interaction.reply({ content: `Tournament started with ${tournament.players.size} players! Generated ${tournament.rounds.length} rounds.`, flags: MessageFlags.Ephemeral });
    } else if (customId === 'admin_allocate') {
      if (tournament.players.size < 4) {
        await interaction.reply({ content: 'Tournament needs at least 4 players.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (tournament.rounds.length === 0) {
        await interaction.reply({ content: 'Tournament has not been started. Use the Start button first.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (tournament.currentRound > tournament.rounds.length) {
        await interaction.reply({ content: `All ${tournament.rounds.length} rounds have been completed!`, flags: MessageFlags.Ephemeral });
        return;
      }
      
      // Check if we're starting a new round (not the first round)
      if (tournament.currentRoundIndex === 0 && tournament.currentRound > 1) {
        try {
          const channel = interaction.channel;
          // Delete all messages except the setup message
          const messages = await channel.messages.fetch({ limit: 100 });
          const toDelete = messages.filter(msg => msg.id !== tournament.setupMessage);
          
          for (const msg of toDelete.values()) {
            await msg.delete().catch(() => null);
          }
          
          // Post round summary
          const summaryEmbed = new EmbedBuilder()
            .setTitle(`📊 Round ${tournament.currentRound - 1} Complete!`)
            .setColor(0x0099ff);
          
          let summaryDescription = `**Scores after Round ${tournament.currentRound - 1}:**\n`;
          const sortedScores = Array.from(tournament.scores.entries())
            .sort((a, b) => b[1] - a[1]);
          
          sortedScores.forEach((entry, idx) => {
            summaryDescription += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`;
          });
          
          summaryEmbed.setDescription(summaryDescription);
          await channel.send({ embeds: [summaryEmbed] });
        } catch (error) {
          console.error('Failed to cleanup channel or post summary:', error.message);
        }
      }
      
      let currentRoundMatches = tournament.rounds[tournament.currentRound - 1];
      
      // Check if all matches in current round have been allocated
      if (tournament.currentRoundIndex >= currentRoundMatches.length) {
        const forceEndRow = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('force_end_round')
              .setLabel('Force End Remaining')
              .setStyle(ButtonStyle.Danger),
          );
        await interaction.reply({ content: `All matches in Round ${tournament.currentRound} have been allocated. Wait for outcomes to complete, then allocate the next round.`, components: [forceEndRow] });
        return;
      }
      
      const grouping = currentRoundMatches[tournament.currentRoundIndex];
      tournament.currentGrouping = grouping;
      tournament.currentRoundIndex++;

      await saveTournamentData();

      const embed = new EmbedBuilder()
        .setTitle(`Round ${tournament.currentRound} - Match ${tournament.currentRoundIndex}/${currentRoundMatches.length}`)
        .setDescription(`**Blue Team:**\nSpymaster: <@${grouping.blue.spymaster}>\nGuesser: <@${grouping.blue.guesser}>\n\n**Red Team:**\nSpymaster: <@${grouping.red.spymaster}>\nGuesser: <@${grouping.red.guesser}>`)
        .setColor(0x0099ff);

      await interaction.reply({ embeds: [embed] });

      try {
        // Create thread
        const channel = interaction.channel;
        const thread = await channel.threads.create({
          name: `R${tournament.currentRound}M${tournament.currentRoundIndex} Game`,
          autoArchiveDuration: 60,
          reason: 'Tournament game thread',
        });
        tournament.currentThread = thread.id;

        const threadEmbed = new EmbedBuilder()
          .setTitle('Game Thread')
          .setDescription('Please play your game and select the outcome below.')
          .setColor(0x00ff00);

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('log_blue_win')
              .setLabel('Blue Wins')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId('log_red_win')
              .setLabel('Red Wins')
              .setStyle(ButtonStyle.Danger),
          );

        await thread.send({ embeds: [threadEmbed], components: [row] });
      } catch (error) {
        console.error('Failed to create thread:', error);
        await interaction.followUp({ content: 'Failed to create game thread. Please check bot permissions.', flags: MessageFlags.Ephemeral });
      }
    } else if (customId === 'admin_scores') {
      const scoreList = Array.from(tournament.scores.entries()).map(([id, score]) => `<@${id}>: ${score}`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle('Current Scores')
        .setDescription(scoreList || 'No scores yet.')
        .setColor(0xff9900);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } else if (customId === 'admin_force_end') {
      if (!tournament.currentGrouping) {
        await interaction.reply({ content: 'No match currently active to force end.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Force end with 0 points for all players
      const bluePlayers = [tournament.currentGrouping.blue.spymaster, tournament.currentGrouping.blue.guesser];
      const redPlayers = [tournament.currentGrouping.red.spymaster, tournament.currentGrouping.red.guesser];
      
      // All players get 0 points (no change)
      tournament.currentGrouping = null;
      
      // Increment match index and check if round is done
      tournament.currentRoundIndex++;
      const currentRound = tournament.rounds[tournament.currentRound - 1];
      const currentRoundMatches = currentRound || [];
      
      if (tournament.currentRoundIndex >= currentRoundMatches.length) {
        // All matches in this round are complete, advance to next round
        tournament.currentRound++;
        tournament.currentRoundIndex = 0;
      }
      
      // Update the scoreboard
      try {
        if (tournament.setupMessage && tournament.setupChannelId) {
          const channel = interaction.guild.channels.cache.get(tournament.setupChannelId);
          if (channel) {
            const message = await channel.messages.fetch(tournament.setupMessage).catch(() => null);
            if (message) {
              let description = `**Tournament Live - Round ${tournament.currentRound}**\n`;
              
              if (tournament.currentRound > tournament.rounds.length) {
                description = `**Tournament Complete!**\n\n`;
                description += `**Final Scoreboard:**\n`;
                const sortedScores = Array.from(tournament.scores.entries())
                  .sort((a, b) => b[1] - a[1]);
                sortedScores.forEach((entry, idx) => {
                  description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`;
                });
              } else {
                const matchesCompleted = tournament.currentRoundIndex;
                const totalMatches = currentRoundMatches?.length || 0;
                description += `Match ${matchesCompleted}/${totalMatches}\n\n`;
                
                if (matchesCompleted < totalMatches) {
                  description += `**Round in progress**\n`;
                } else {
                  description += `**Round Complete!** Click Allocate to start Round ${tournament.currentRound + 1}\n`;
                }
                description += '\n';

                description += `**Scoreboard:**\n`;
                const sortedScores = Array.from(tournament.scores.entries())
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 10);
                sortedScores.forEach((entry, idx) => {
                  description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`;
                });
              }
              
              const embed = message.embeds[0];
              const updatedEmbed = EmbedBuilder.from(embed).setDescription(description);
              await message.edit({ embeds: [updatedEmbed] }).catch(err => {
                console.error('Failed to edit message:', err.message);
              });
            }
          }
        }
      } catch (error) {
        console.error('Failed to update scoreboard:', error.message);
      }
      
      await saveTournamentData();
      
      // Archive the thread if it exists
      try {
        const thread = interaction.guild.channels.cache.get(tournament.currentThread);
        if (thread) {
          thread.setArchived(true).catch(() => null);
        }
      } catch (error) {
        console.error('Failed to archive thread:', error.message);
      }
      
      await interaction.reply({ content: 'Match force ended. 0 points awarded to all players.', flags: MessageFlags.Ephemeral });
    } else if (customId === 'force_end_round') {
      // Force end all remaining matches in the round
      const currentRound = tournament.rounds[tournament.currentRound - 1];
      const remainingMatches = currentRound.length - tournament.currentRoundIndex;
      
      // Advance to next round
      tournament.currentRound++;
      tournament.currentRoundIndex = 0;
      tournament.currentGrouping = null;
      
      // Update the scoreboard
      try {
        if (tournament.setupMessage && tournament.setupChannelId) {
          const channel = interaction.guild.channels.cache.get(tournament.setupChannelId);
          if (channel) {
            const message = await channel.messages.fetch(tournament.setupMessage).catch(() => null);
            if (message) {
              let description = `**Tournament Live - Round ${tournament.currentRound}**\n`;
              
              if (tournament.currentRound > tournament.rounds.length) {
                description = `**Tournament Complete!**\n\n`;
                description += `**Final Scoreboard:**\n`;
                const sortedScores = Array.from(tournament.scores.entries())
                  .sort((a, b) => b[1] - a[1]);
                sortedScores.forEach((entry, idx) => {
                  description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`;
                });
              } else {
                const nextRoundMatches = tournament.rounds[tournament.currentRound - 1];
                const totalMatches = nextRoundMatches?.length || 0;
                description += `Match 0/${totalMatches}\n\n`;
                description += `**Round in progress**\n`;
                description += '\n';

                description += `**Scoreboard:**\n`;
                const sortedScores = Array.from(tournament.scores.entries())
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 10);
                sortedScores.forEach((entry, idx) => {
                  description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`;
                });
              }
              
              const embed = message.embeds[0];
              const updatedEmbed = EmbedBuilder.from(embed).setDescription(description);
              await message.edit({ embeds: [updatedEmbed] }).catch(err => {
                console.error('Failed to edit message:', err.message);
              });
            }
          }
        }
      } catch (error) {
        console.error('Failed to update scoreboard:', error.message);
      }
      
      await saveTournamentData();
      await interaction.reply({ content: `Round ${tournament.currentRound - 1} force ended. ${remainingMatches} match(es) skipped with 0 points. Ready for next round.`, flags: MessageFlags.Ephemeral });
    } else if (customId === 'admin_reset') {
      tournament = {
        players: new Set(),
        currentRound: 0,
        currentRoundIndex: 0,
        playedGroupings: new Set(),
        scores: new Map(),
        currentGrouping: null,
        currentThread: null,
        setupMessage: null,
        setupChannelId: null,
        rounds: [],
        started: false,
      };
      await saveTournamentData();
      await interaction.reply({ content: 'Tournament reset.', flags: MessageFlags.Ephemeral });
    } else if (customId.startsWith('log_')) {
      if (!tournament.currentGrouping) {
        await interaction.reply({ content: 'No current game to log.', flags: MessageFlags.Ephemeral });
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
        try {
          // Update the setup message if it exists
          if (tournament.setupMessage) {
            const channel = interaction.channel;
            const message = await channel.messages.fetch(tournament.setupMessage).catch(() => null);
            if (message) {
              const embed = message.embeds[0];
              let description = 'Sign up for the tournament and manage it with the buttons below.\n\n**Signed Up Players:**\n' + (tournament.players.size > 0 ? Array.from(tournament.players).map(id => `<@${id}>`).join('\n') : 'None yet');
              
              // Add prediction if 4+ players
              if (tournament.players.size >= 4) {
                const prediction = getTournamentPrediction(tournament.players.size);
                if (prediction) {
                  description += `\n\n**Tournament Prediction:**\n${prediction.rounds} Rounds • ${prediction.totalGames} Total Games`;
                }
              }
              
              const updatedEmbed = EmbedBuilder.from(embed).setDescription(description);
              await message.edit({ embeds: [updatedEmbed] });
            }
          }
        } catch (error) {
          console.error('Failed to edit setup message:', error.message);
        }
        await interaction.reply({ content: 'You have been removed from the tournament.', flags: MessageFlags.Ephemeral });
        await saveTournamentData();
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
      const assassin = parts[3] === 'assassin'; // true if assassin, false if normal
      
      try {
        const remainingCardsValue = interaction.fields.getTextInputValue('remaining_cards');
        const remainingCards = parseInt(remainingCardsValue);

        if (isNaN(remainingCards) || remainingCards < 0 || remainingCards > 8) {
          await interaction.reply({ content: 'Invalid number of remaining cards. Must be 0-8.', flags: MessageFlags.Ephemeral });
          return;
        }

        // Calculate scores
        const winPoints = 3;
        let losePoints;
        if (assassin) {
          losePoints = -1;
        } else {
          losePoints = remainingCards <= 3 ? 1 : 0;
        }

        const bluePlayers = [tournament.currentGrouping.blue.spymaster, tournament.currentGrouping.blue.guesser];
        const redPlayers = [tournament.currentGrouping.red.spymaster, tournament.currentGrouping.red.guesser];

        if (winner === 'blue') {
          bluePlayers.forEach(id => tournament.scores.set(id, tournament.scores.get(id) + winPoints));
          redPlayers.forEach(id => tournament.scores.set(id, tournament.scores.get(id) + losePoints));
        } else {
          redPlayers.forEach(id => tournament.scores.set(id, tournament.scores.get(id) + winPoints));
          bluePlayers.forEach(id => tournament.scores.set(id, tournament.scores.get(id) + losePoints));
        }

        tournament.currentGrouping = null;
        
        // Increment match index and check if we need to advance to next round
        tournament.currentRoundIndex++;
        const currentRound = tournament.rounds[tournament.currentRound - 1];
        const currentRoundMatches = currentRound || [];
        
        if (tournament.currentRoundIndex >= currentRoundMatches.length) {
          // All matches in this round are complete, advance to next round
          tournament.currentRound++;
          tournament.currentRoundIndex = 0;
        }
        
        // Update the main scoreboard embed BEFORE archiving thread
        try {
          if (tournament.setupMessage && tournament.setupChannelId) {
            const channel = interaction.guild.channels.cache.get(tournament.setupChannelId);
            if (channel) {
              const message = await channel.messages.fetch(tournament.setupMessage).catch(() => null);
              if (message) {
                let description = `**Tournament Live - Round ${tournament.currentRound}**\n`;
                
                // Check if we've finished all rounds
                if (tournament.currentRound > tournament.rounds.length) {
                  description = `**Tournament Complete!**\n\n`;
                  description += `**Final Scoreboard:**\n`;
                  const sortedScores = Array.from(tournament.scores.entries())
                    .sort((a, b) => b[1] - a[1]);
                  sortedScores.forEach((entry, idx) => {
                    description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`;
                  });
                } else {
                  const currentRound = tournament.rounds[tournament.currentRound - 1];
                  const matchesCompleted = tournament.currentRoundIndex;
                  const totalMatches = currentRound?.length || 0;
                  description += `Match ${matchesCompleted}/${totalMatches}\n\n`;
                  
                  if (matchesCompleted < totalMatches) {
                    description += `**Round in progress**\n`;
                  } else {
                    description += `**Round Complete!** Click Allocate to start Round ${tournament.currentRound + 1}\n`;
                  }
                  description += '\n';

                  description += `**Scoreboard:**\n`;
                  const sortedScores = Array.from(tournament.scores.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10);
                  sortedScores.forEach((entry, idx) => {
                    description += `${idx + 1}. <@${entry[0]}> - ${entry[1]} pts\n`;
                  });
                }
                
                const embed = message.embeds[0];
                const updatedEmbed = EmbedBuilder.from(embed).setDescription(description);
                await message.edit({ embeds: [updatedEmbed] }).catch(err => {
                  console.error('Failed to edit message:', err.message);
                });
              }
            }
          }
        } catch (error) {
          console.error('Failed to update scoreboard:', error.message);
        }
      
        await saveTournamentData();

        // Send reply to user BEFORE archiving thread to avoid "thread is archived" error
        await interaction.reply(`Outcome logged. ${winner === 'blue' ? 'Blue' : 'Red'} won with ${remainingCards} cards remaining${assassin ? ' by assassin' : ''}. Round completed.`);
        
        // Archive thread in background after reply is sent
        try {
          const thread = interaction.guild.channels.cache.get(tournament.currentThread);
          if (thread) {
            thread.setArchived(true).catch(err => {
              console.error('Failed to archive thread:', err.message);
            });
          }
        } catch (error) {
          console.error('Error archiving thread:', error);
        }
        tournament.currentThread = null;
      } catch (error) {
        console.error('Error processing outcome:', error);
        try {
          await interaction.reply({ content: 'An error occurred while processing the outcome. Please try again.', flags: MessageFlags.Ephemeral });
        } catch (replyError) {
          console.error('Failed to send error reply:', replyError.message);
        }
      }
    }
  }
});

function getTournamentPrediction(playerCount) {
  if (playerCount < 4) {
    return null;
  }
  
  // Generate the rounds to get exact count
  const rounds = generateRounds(Array.from({length: playerCount}, (_, i) => `player${i}`));
  
  let totalGames = 0;
  const gamesPerRound = rounds.map(round => {
    totalGames += round.length;
    return round.length;
  });
  
  return {
    rounds: rounds.length,
    gamesPerRound: gamesPerRound,
    totalGames: totalGames,
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
  let roundNum = 0;
  
  while (playedConfigs.size < pairs.size * 4) {
    const round = [];
    const playersUsedThisRound = new Set();
    let foundMatch = false;
    
    // Try to find matches that haven't been played yet
    for (let i = 0; i < players.length; i++) {
      if (playersUsedThisRound.has(players[i])) continue;
      
      for (let j = i + 1; j < players.length; j++) {
        if (playersUsedThisRound.has(players[j])) continue;
        
        // Try to find two more players
        for (let k = 0; k < players.length; k++) {
          if (k === i || k === j || playersUsedThisRound.has(players[k])) continue;
          
          for (let l = k + 1; l < players.length; l++) {
            if (l === i || l === j || playersUsedThisRound.has(players[l])) continue;
            
            // We have 4 players: i, j, k, l
            // Try different pairings
            const pairings = [
              { blue: [players[i], players[j]], red: [players[k], players[l]] },
              { blue: [players[i], players[k]], red: [players[j], players[l]] },
              { blue: [players[i], players[l]], red: [players[j], players[k]] },
            ];
            
            for (const pairing of pairings) {
              // Try both role assignments for this pairing
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
                // Check if all 4 player-pair configurations exist and haven't been played
                const allUnplayed = checkAndMarkConfigs(assignment, playedConfigs);
                
                if (allUnplayed) {
                  round.push(assignment);
                  playersUsedThisRound.add(pairing.blue[0]);
                  playersUsedThisRound.add(pairing.blue[1]);
                  playersUsedThisRound.add(pairing.red[0]);
                  playersUsedThisRound.add(pairing.red[1]);
                  foundMatch = true;
                  break;
                }
              }
              if (foundMatch) break;
            }
            if (foundMatch) break;
          }
          if (foundMatch) break;
        }
        if (foundMatch) break;
      }
      if (foundMatch) break;
    }
    
    if (round.length > 0) {
      rounds.push(round);
      roundNum++;
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