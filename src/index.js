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
  playedGroupings: new Set(),
  scores: new Map(),
  currentGrouping: null,
  currentThread: null,
  setupMessage: null,
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
    tournament.currentGrouping = parsed.currentGrouping;
    tournament.currentThread = parsed.currentThread;
    tournament.setupMessage = parsed.setupMessage;
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
      currentGrouping: tournament.currentGrouping,
      currentThread: tournament.currentThread,
      setupMessage: tournament.setupMessage,
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
      const embed = new EmbedBuilder()
        .setTitle('Codenames Tournament')
        .setDescription('Sign up for the tournament and manage it with the buttons below.\n\n**Signed Up Players:**\n' + (tournament.players.size > 0 ? Array.from(tournament.players).map(id => `<@${id}>`).join('\n') : 'None yet'))
        .setColor(0x0099ff);

      const row = new ActionRowBuilder()
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

      const message = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
      tournament.setupMessage = message.id;
      await saveTournamentData();
    }
  } else if (interaction.isButton()) {
    const { customId } = interaction;

    if (customId === 'signup') {
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
              const updatedEmbed = EmbedBuilder.from(embed).setDescription('Sign up for the tournament and manage it with the buttons below.\n\n**Signed Up Players:**\n' + (tournament.players.size > 0 ? Array.from(tournament.players).map(id => `<@${id}>`).join('\n') : 'None yet'));
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
            .setCustomId('admin_reset')
            .setLabel('Reset Tournament')
            .setStyle(ButtonStyle.Danger),
        );

      await interaction.reply({ embeds: [adminEmbed], components: [adminRow], flags: MessageFlags.Ephemeral });
    } else if (customId === 'admin_start') {
      if (tournament.players.size !== 4) {
        await interaction.reply({ content: 'Need exactly 4 players to start.', flags: MessageFlags.Ephemeral });
        return;
      }
      tournament.currentRound = 1;
      tournament.scores = new Map([...tournament.players].map(id => [id, 0]));
      await saveTournamentData();
      await interaction.reply({ content: 'Tournament started!', flags: MessageFlags.Ephemeral });
    } else if (customId === 'admin_allocate') {
      if (tournament.players.size !== 4) {
        await interaction.reply({ content: 'Tournament not set up for 4 players.', flags: MessageFlags.Ephemeral });
        return;
      }
      const players = Array.from(tournament.players);
      // Generate a new grouping
      let grouping = generateGrouping(players);
      while (tournament.playedGroupings.has(JSON.stringify(grouping))) {
        grouping = generateGrouping(players);
      }
      tournament.playedGroupings.add(JSON.stringify(grouping));
      tournament.currentGrouping = grouping;

      await saveTournamentData();

      const embed = new EmbedBuilder()
        .setTitle(`Round ${tournament.currentRound} Allocation`)
        .setDescription(`**Blue Team:**\nSpymaster: <@${grouping.blue.spymaster}>\nGuesser: <@${grouping.blue.guesser}>\n\n**Red Team:**\nSpymaster: <@${grouping.red.spymaster}>\nGuesser: <@${grouping.red.guesser}>`)
        .setColor(0x0099ff);

      await interaction.reply({ embeds: [embed] });

      try {
        // Create thread
        const channel = interaction.channel;
        const thread = await channel.threads.create({
          name: `Round ${tournament.currentRound} Game`,
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
    } else if (customId === 'admin_reset') {
      tournament = {
        players: new Set(),
        currentRound: 0,
        playedGroupings: new Set(),
        scores: new Map(),
        currentGrouping: null,
        currentThread: null,
        setupMessage: null,
      };
      await saveTournamentData();
      await interaction.reply({ content: 'Tournament reset.', flags: MessageFlags.Ephemeral });
    } else if (customId.startsWith('log_')) {
      if (!tournament.currentGrouping) {
        await interaction.reply({ content: 'No current game to log.', flags: MessageFlags.Ephemeral });
        return;
      }
      const winner = customId === 'log_blue_win' ? 'blue' : 'red';

      const modal = new ModalBuilder()
        .setCustomId(`outcome_modal_${winner}`)
        .setTitle(`${winner === 'blue' ? 'Blue' : 'Red'} Won - Game Details`);

      const remainingCardsInput = new TextInputBuilder()
        .setCustomId('remaining_cards')
        .setLabel('How many cards did the losing team have remaining? (0-8)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('e.g. 3');

      const assassinInput = new TextInputBuilder()
        .setCustomId('assassin')
        .setLabel('Was the win by hitting the assassin? (yes/no)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('yes or no');

      const firstActionRow = new ActionRowBuilder().addComponents(remainingCardsInput);
      const secondActionRow = new ActionRowBuilder().addComponents(assassinInput);

      modal.addComponents(firstActionRow, secondActionRow);

      await interaction.showModal(modal);
    }
  } else if (interaction.isModalSubmit()) {
    const { customId } = interaction;
    if (customId.startsWith('outcome_modal_')) {
      const winner = customId.split('_')[2]; // blue or red
      const remainingCards = parseInt(interaction.fields.getTextInputValue('remaining_cards'));
      const assassin = interaction.fields.getTextInputValue('assassin').toLowerCase() === 'yes';

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

      tournament.currentRound++;
      tournament.currentGrouping = null;
      try {
        const thread = interaction.guild.channels.cache.get(tournament.currentThread);
        if (thread) await thread.setArchived(true);
      } catch (error) {
        console.error('Failed to archive thread:', error);
      }
      tournament.currentThread = null;
      await saveTournamentData();

      await interaction.reply(`Outcome logged. ${winner === 'blue' ? 'Blue' : 'Red'} won with ${remainingCards} cards remaining${assassin ? ' by assassin' : ''}. Round completed.`);
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
              const updatedEmbed = EmbedBuilder.from(embed).setDescription('Sign up for the tournament and manage it with the buttons below.\n\n**Signed Up Players:**\n' + (tournament.players.size > 0 ? Array.from(tournament.players).map(id => `<@${id}>`).join('\n') : 'None yet'));
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
  }
});

function generateGrouping(players) {
  // Shuffle players
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  return {
    blue: { spymaster: shuffled[0], guesser: shuffled[1] },
    red: { spymaster: shuffled[2], guesser: shuffled[3] },
  };
}

client.on('error', (error) => {
  console.error('Client error:', error);
});

console.log('Attempting to login with token:', process.env.BOT_TOKEN ? 'Token found' : 'Token missing');
client.login(process.env.BOT_TOKEN);