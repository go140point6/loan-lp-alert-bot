const { getLoanSummaries } = require('./loanMonitor');
const { getLpSummaries } = require('./lpMonitor');

// Build a concise human-readable summary line for a single loan
function formatLoanLine(s) {
  const parts = [];

  parts.push(
    `• **${s.protocol}** (${s.chainId}) — status **${s.status}**`
  );

  if (s.hasPrice && typeof s.price === 'number' && typeof s.liquidationPrice === 'number') {
    const ltvText =
      typeof s.ltvPct === 'number' ? `${s.ltvPct.toFixed(2)}%` : 'n/a';
    const bufferText =
      typeof s.liquidationBufferFrac === 'number'
        ? `${(s.liquidationBufferFrac * 100).toFixed(2)}%`
        : 'n/a';

    parts.push(
      `   LTV **${ltvText}**, price **${s.price.toFixed(
        5
      )}**, liq **${s.liquidationPrice.toFixed(5)}**, buffer **${bufferText}** (tier **${
        s.liquidationTier || 'UNKNOWN'
      }**)`
    );
  } else {
    parts.push(
      '   Price / liq: *(unavailable; cannot compute LTV / buffer)*'
    );
  }

  if (typeof s.interestPct === 'number') {
    let irLine = `   IR **${s.interestPct.toFixed(2)}% p.a.**`;
    if (typeof s.globalIrPct === 'number') {
      irLine += ` vs global **${s.globalIrPct.toFixed(2)}%**`;
    }
    if (s.redemptionTier) {
      irLine += `, redemption tier **${s.redemptionTier}**`;
    }
    parts.push(irLine);
  }

  return parts.join('\n');
}

// Build a concise summary line for a single LP
function formatLpLine(s) {
  const parts = [];

  const pair = s.pairLabel || `${s.token0Symbol || s.token0}-${s.token1Symbol || s.token1}`;

  parts.push(
    `• **${s.protocol}** ${pair} (${s.chainId}) — status **${s.status}**, range **${s.rangeStatus}**`
  );

  if (s.lpRangeTier && s.lpRangeTier !== 'UNKNOWN') {
    parts.push(`   Range tier **${s.lpRangeTier}**${s.lpRangeLabel ? ` (${s.lpRangeLabel})` : ''}`);
  }

  if (
    typeof s.tickLower === 'number' &&
    typeof s.tickUpper === 'number' &&
    typeof s.currentTick === 'number'
  ) {
    parts.push(
      `   Tick [${s.tickLower}, ${s.tickUpper}) current **${s.currentTick}**`
    );
  }

  if (s.liquidity) {
    parts.push(`   Liquidity \`${s.liquidity}\``);
  }

  return parts.join('\n');
}

async function sendDailyHeartbeat(client) {
  const userId = process.env.MY_DISCORD_ID;
  if (!userId) {
    console.error(
      '[Heartbeat] MY_DISCORD_ID not set; cannot send daily heartbeat DM.'
    );
    return;
  }

  let user;
  try {
    user = await client.users.fetch(userId);
  } catch (err) {
    console.error('[Heartbeat] Failed to fetch user for heartbeat:', err.message);
    return;
  }

  // Fetch current state
  let loanSummaries = [];
  let lpSummaries = [];

  try {
    [loanSummaries, lpSummaries] = await Promise.all([
      getLoanSummaries(),
      getLpSummaries(),
    ]);
  } catch (err) {
    console.error('[Heartbeat] Failed to fetch summaries:', err.message);
    return;
  }

  const now = new Date();
  const nowIso = now.toISOString();

  const lines = [];
  lines.push('📊 **24h DeFi Heartbeat**');
  lines.push(`as of \`${nowIso}\``);
  lines.push('');

  // ---- Loans ----
  lines.push('**Loans**');
  if (!loanSummaries || loanSummaries.length === 0) {
    lines.push('*(no monitored loans)*');
  } else {
    // Sort by LTV descending so riskiest are on top
    loanSummaries
      .slice()
      .sort((a, b) => (b.ltvPct || 0) - (a.ltvPct || 0))
      .forEach((s) => {
        lines.push(formatLoanLine(s));
      });
  }

  lines.push('');
  // ---- LPs ----
  lines.push('**LP Positions**');
  if (!lpSummaries || lpSummaries.length === 0) {
    lines.push('*(no monitored LP positions)*');
  } else {
    // OUT_OF_RANGE first, then by protocol
    const order = { OUT_OF_RANGE: 0, UNKNOWN: 1, IN_RANGE: 2 };
    lpSummaries
      .slice()
      .sort((a, b) => {
        const ra = order[a.rangeStatus] ?? 99;
        const rb = order[b.rangeStatus] ?? 99;
        if (ra !== rb) return ra - rb;
        return (a.protocol || '').localeCompare(b.protocol || '');
      })
      .forEach((s) => {
        lines.push(formatLpLine(s));
      });
  }

  const msg = lines.join('\n');

  try {
    await user.send(msg);
    console.log('[Heartbeat] Sent daily heartbeat DM.');
  } catch (err) {
    console.error('[Heartbeat] Failed to send daily heartbeat DM:', err.message);
  }
}

module.exports = {
  sendDailyHeartbeat,
};