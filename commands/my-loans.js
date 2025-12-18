const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const client = require('../index');
const {
  getLoanSummaries,
  getCdpPrice,
  classifyCdpRedemptionState,
} = require('../monitoring/loanMonitor');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('my-loans')
    .setDescription('Show current monitored loan positions.'),
  async execute(interaction) {
    try {
      await interaction.deferReply();

      const summaries = await getLoanSummaries();

      if (!summaries || summaries.length === 0) {
        await interaction.editReply(
          'No loan positions are currently being monitored.'
        );
        return;
      }

      // Sort by LTV descending (most risky first)
      summaries.sort((a, b) => {
        const av = a.ltvPct || 0;
        const bv = b.ltvPct || 0;
        return bv - av;
      });

      // --- CDP context using the same logic as monitorLoans ---
      const cdpPrice = await getCdpPrice();
      const cdpState = classifyCdpRedemptionState(cdpPrice);

      const descLines = ['Current status of monitored loan positions.'];

      if (cdpPrice == null) {
        descLines.push(
          'CDP price: *(unknown; CDP price source unavailable)*'
        );
      } else {
        descLines.push(
          `CDP: **${cdpPrice.toFixed(
            4
          )} USD**, redemption state **${cdpState.state}** (trigger **${cdpState.trigger.toFixed(
            4
          )}**, ${cdpState.label}).`
        );
      }

      const fields = summaries.map((s) => {
        const header = `${s.protocol} (${s.chainId})`;

        const valueLines = [];

        // Status
        valueLines.push(`Status: **${s.status}**`);

        // Price-dependent metrics
        if (s.hasPrice && s.price != null && s.liquidationPrice != null) {
          const ltvText =
            typeof s.ltvPct === 'number'
              ? `${s.ltvPct.toFixed(2)}%`
              : 'n/a';

          const liqBufferText =
            typeof s.liquidationBufferFrac === 'number'
              ? `${(s.liquidationBufferFrac * 100).toFixed(2)}%`
              : 'n/a';

          valueLines.push(`LTV: **${ltvText}**`);
          valueLines.push(
            `Price / Liq: **${s.price.toFixed(5)} / ${s.liquidationPrice.toFixed(
              5
            )}**`
          );
          valueLines.push(
            `Liq buffer: **${liqBufferText}** (tier **${
              s.liquidationTier || 'UNKNOWN'
            }**)`
          );
        } else {
          valueLines.push(
            'Price / liquidation: *(unavailable; cannot compute LTV / buffer)*'
          );
        }

        // Collateral & debt
        if (typeof s.collAmount === 'number') {
          valueLines.push(
            `Collateral: **${s.collAmount.toFixed(4)} ${s.collSymbol}**`
          );
        }
        if (typeof s.debtAmount === 'number') {
          valueLines.push(`Debt: **${s.debtAmount.toFixed(4)}**`);
        }

        // Interest rate / redemption profile
        if (typeof s.interestPct === 'number') {
          let irLine = `IR: **${s.interestPct.toFixed(2)}% p.a.**`;

          if (typeof s.globalIrPct === 'number') {
            irLine += ` vs global **${s.globalIrPct.toFixed(2)}%**`;
          }

          valueLines.push(irLine);

          if (s.redemptionTier) {
            valueLines.push(
              `Redemption tier (IR-based): **${
                s.redemptionTier
              }**${
                typeof s.redemptionDiffPct === 'number'
                  ? ` (Δ ${
                      s.redemptionDiffPct >= 0 ? '+' : ''
                    }${s.redemptionDiffPct.toFixed(2)} pp vs global)`
                  : ''
              }`
            );
          }
        }

        return {
          name: header,
          value: valueLines.join('\n'),
        };
      });

      const embed = new EmbedBuilder()
        .setColor('DarkBlue')
        .setTitle('My Loan Positions')
        .setDescription(descLines.join('\n'))
        .setThumbnail(client.user.avatarURL())
        .addFields(fields)
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('Error in /my-loans:', error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(
          'An error occurred while processing `/my-loans`.'
        );
      } else {
        await interaction.reply(
          'An error occurred while processing `/my-loans`.'
        );
      }
    }
  },
};
