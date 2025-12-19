const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
// const client = require('../index');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('my-lp')
    .setDescription('Show current monitored LP positions.'),
  async execute(interaction) {
    try {
      await interaction.deferReply();

      // Lazy-load to avoid circular dependency issues
      const { getLpSummaries } = require('../monitoring/lpMonitor');

      const summaries = await getLpSummaries();

      if (!summaries || summaries.length === 0) {
        await interaction.editReply(
          'No LP positions are currently being monitored.'
        );
        return;
      }

      // Sort so "interesting" positions show first:
      // 1) OUT_OF_RANGE before IN_RANGE / UNKNOWN
      // 2) Within same rangeStatus, sort by lpRangeTier (CRITICAL > HIGH > MEDIUM > LOW > UNKNOWN)
      // 3) Then by protocol name
      summaries.sort((a, b) => {
        const rangeOrder = { OUT_OF_RANGE: 0, UNKNOWN: 1, IN_RANGE: 2 };
        const tierOrder  = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };

        const ra = rangeOrder[a.rangeStatus] ?? 99;
        const rb = rangeOrder[b.rangeStatus] ?? 99;
        if (ra !== rb) return ra - rb;

        const ta = tierOrder[a.lpRangeTier] ?? 99;
        const tb = tierOrder[b.lpRangeTier] ?? 99;
        if (ta !== tb) return ta - tb;

        return (a.protocol || '').localeCompare(b.protocol || '');
      });

      const descLines = [
        'Current status of monitored LP positions.',
        '_Range status is based on the current pool tick vs your position bounds._',
      ];

      const tierColorEmoji = {
        LOW: '🟩',      // green
        MEDIUM: '🟨',   // yellow
        HIGH: '🟧',     // orange
        CRITICAL: '🟥', // red
        UNKNOWN: '⬜',
      };

      const fields = summaries.map((s) => {
        const header = `${s.protocol} (${s.chainId})`;

        const valueLines = [];

        // Basic status
        valueLines.push(`Status: **${s.status}**, Range: **${s.rangeStatus}**`);

        // Range tier (highlighted in a code block with a color emoji)
        if (s.lpRangeTier) {
          const labelText = s.lpRangeLabel ? ` – ${s.lpRangeLabel}` : '';
          const emoji = tierColorEmoji[s.lpRangeTier] || '⬜';

          valueLines.push(
            '```' + `${emoji} Range tier: ${s.lpRangeTier}${labelText}` + '```'
          );
        }

        // Optional geometry details
        if (typeof s.lpPositionFrac === 'number') {
          valueLines.push(
            `Position in band: **${(s.lpPositionFrac * 100).toFixed(2)}%** from lower bound`
          );
        }
        // if (typeof s.lpDistanceFrac === 'number') {
        //   valueLines.push(
        //     `Distance to edge/out: **${(s.lpDistanceFrac * 100).toFixed(2)}%** of band width`
        //   );
        // }

        // Pair / fee
        if (s.pairLabel) {
          valueLines.push(`Pair: **${s.pairLabel}**`);
        } else if (s.token0 && s.token1) {
          valueLines.push(`Pair: **${s.token0} - ${s.token1}**`);
        }

        // if (typeof s.fee === 'number') {
        //   valueLines.push(`Fee tier: **${s.fee}**`);
        // }

        // Tick info
        if (
          typeof s.tickLower === 'number' &&
          typeof s.tickUpper === 'number'
        ) {
          const tickLineParts = [
            `Tick range: **[${s.tickLower}, ${s.tickUpper})**`,
          ];
          if (typeof s.currentTick === 'number') {
            tickLineParts.push(`current: **${s.currentTick}**`);
          }
          valueLines.push(tickLineParts.join(' '));
        }

        // Liquidity
        // if (s.liquidity) {
        //   valueLines.push(`Liquidity: \`${s.liquidity}\``);
        // }

        // NFT / pool info (best-effort, mostly for debugging)
        // valueLines.push(`NFT: \`${s.nftContract}\` #\`${s.tokenId}\``);
        // if (s.poolAddr) {
        //   valueLines.push(`Pool: \`${s.poolAddr}\``);
        // }

        return {
          name: header,
          value: valueLines.join('\n'),
        };
      });

      const embed = new EmbedBuilder()
        .setColor('DarkRed')
        .setTitle('My LP Positions')
        //.setDescription(descLines.join('\n'))
        .setThumbnail(interaction.client.user.avatarURL())
        .addFields(fields)
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('Error in /my-lp:', error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(
          'An error occurred while processing `/my-lp`.'
        );
      } else {
        await interaction.reply(
          'An error occurred while processing `/my-lp`.'
        );
      }
    }
  },
};
