const { SlashCommandBuilder } = require('discord.js');
const {
  handleRedemptionAlert,
} = require('../monitoring/alertEngine');

const MY_DISCORD_ID = process.env.MY_DISCORD_ID;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('test-loan-redemption')
    .setDescription('[DEV] Simulate loan redemption alert tiers'),
  async execute(interaction) {

    if (!MY_DISCORD_ID || interaction.user.id !== MY_DISCORD_ID) {
      return interaction.reply({
        content: 'Not authorized to run this dev command.',
        flags: 64, // EPHEMERAL
      });
    }

    await interaction.reply({
      content:
        'Simulating redemption alert tiers: LOW → MEDIUM → HIGH. Check your DMs.',
      flags: 64, // EPHEMERAL
    });

    const base = {
      protocol: 'TEST_REDEMP_PROTOCOL',
      wallet: '0xTEST_WALLET',
      positionId: 'TEST_REDEMP_POSITION',
      isCDPActive: true,
      cdpIR: 3.5,
      globalIR: 5.0,
    };

    // Step 1: LOW
    handleRedemptionAlert({
      ...base,
      isActive: true,
      tier: 'LOW',
    });

    // Step 2: MEDIUM
    handleRedemptionAlert({
      ...base,
      isActive: true,
      tier: 'MEDIUM',
      cdpIR: 3.0,
    });

    // Step 3: HIGH
    handleRedemptionAlert({
      ...base,
      isActive: true,
      tier: 'HIGH',
      cdpIR: 2.5,
    });

    // Optional: simulate resolved w/ CDP inactive
    handleRedemptionAlert({
      ...base,
      isActive: false,
      tier: 'LOW',
      isCDPActive: false,
    });
  },
};
