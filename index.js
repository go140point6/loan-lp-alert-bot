require('dotenv').config({ quiet: true });
require('log-timestamp');

const { Client, Events } = require('discord.js');
const { GatewayIntentBits } = require('./config/GatewayIntentBits');
const { onReady } = require('./events/onReady');
const { onInteraction } = require('./events/onInteraction');
const { onMessage } = require('./events/onMessage');
const { validateEnv } = require('./utils/validateEnv');

(async () => {
  // Validate required env vars (BOT_TOKEN, RPC URLs, etc.)
  validateEnv();

  const client = new Client({ intents: GatewayIntentBits });
  module.exports = client;

  client.once(Events.ClientReady, async () => {
    await onReady(client);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    await onInteraction(interaction);
  });

  client.on(Events.MessageCreate, async (message) => {
    await onMessage(message);
  });

  await client.login(process.env.BOT_TOKEN);
})();