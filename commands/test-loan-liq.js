const { SlashCommandBuilder } = require('discord.js');
const {
  handleLiquidationAlert,
} = require('../monitoring/alertEngine');

const MY_DISCORD_ID = process.env.MY_DISCORD_ID;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('test-loan-liq')
    .setDescription('[DEV] Simulate loan liquidation alert tiers'),
  async execute(interaction) {

    if (!MY_DISCORD_ID || interaction.user.id !== MY_DISCORD_ID) {
      return interaction.reply({
        content: 'Not authorized to run this dev command.',
        flags: 64, // EPHEMERAL
      });
    }

    await interaction.reply({
      content:
        'Simulating liquidation alert tiers: MEDIUM → HIGH → CRITICAL (check your DMs).',
      flags: 64, // EPHEMERAL
    });

    const base = {
      protocol: 'TEST_LIQ_PROTOCOL',
      wallet: '0xTEST_WALLET',
      positionId: 'TEST_LIQ_POSITION',
      liquidationPrice: 0.5,
      currentPrice: 1.0,
      liquidationBufferFrac: 0.5,
    };

    // Step 1: MEDIUM
    handleLiquidationAlert({
      ...base,
      isActive: true,
      tier: 'MEDIUM',
      ltvPct: 45.0,
    });

    // Step 2: HIGH
    handleLiquidationAlert({
      ...base,
      isActive: true,
      tier: 'HIGH',
      ltvPct: 60.0,
      currentPrice: 0.8,
      liquidationBufferFrac: 0.375,
    });

    // Step 3: CRITICAL
    handleLiquidationAlert({
      ...base,
      isActive: true,
      tier: 'CRITICAL',
      ltvPct: 75.0,
      currentPrice: 0.7,
      liquidationBufferFrac: 0.285,
    });

    // Optional: simulate resolve (log only)
    handleLiquidationAlert({
      ...base,
      isActive: false,
      tier: 'LOW',
      ltvPct: 30.0,
    });
  },
};
