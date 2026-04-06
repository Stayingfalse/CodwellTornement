# Codenames Tournament Bot

A Discord bot for organizing and managing Codenames tournaments with round robin pairings.

## Features

- Interactive sign-up via buttons
- Automatic allocation of pairings with embeds
- Thread creation for each game round
- Outcome logging via buttons in threads
- Score tracking with embeds
- Round progression

## Setup

1. Create a Discord bot at https://discord.com/developers/applications
2. Get the bot token, guild ID, and admin role ID
3. Copy `.env.example` to `.env` and fill in the values
4. Install dependencies: `npm install`
5. Run the bot: `npm start`

### Docker Setup

1. Ensure Docker and Docker Compose are installed
2. Copy `.env.example` to `.env` and fill in the values
3. Run with Docker Compose: `docker-compose up -d`
4. Or build and run manually: `docker build -t codenames-bot .` then `docker run --env-file .env codenames-bot`

## Commands

- `/tournament`: Post the tournament setup embed with sign-up and admin buttons

## Scoring

- Winning team: 3 points per player
- Losing team: 
  - 1 point per player if 3 or fewer cards remaining
  - 0 points if more than 3 cards remaining
  - -1 point per player if lost by hitting the assassin (regardless of cards remaining)

## Usage

Invite the bot to your server with permissions to manage threads and send messages. Use `/tournament` to start the setup. Players sign up via button, admins access controls via the Admin button (requires specific role). The bot creates threads for each game round to keep discussions organized.