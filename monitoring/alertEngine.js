// monitoring/alertEngine.js
// In-memory alert state + logging + Discord DM alerts

const crypto = require('crypto');

// Your personal Discord user ID (string)
const DM_USER_ID = process.env.MY_DISCORD_ID;
if (!DM_USER_ID) {
  console.error("Missing MY_DISCORD_ID in .env");
  process.exit(1);
}

/**
 * Load bot client from the main index.js file.
 * This matches what your slash commands already do.
 */
function getDiscordClient() {
  try {
    return require('../index');
  } catch {
    return null;
  }
}

const alertState = new Map();

function buildAlertKey({ type, protocol, wallet, positionId }) {
  return `${type}:${protocol}:${wallet}:${positionId}`;
}

function makeSignature(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * Send a Discord DM for an alert.
 */
async function sendDm({ phase, alertType, logPrefix, message, meta }) {
  if (!DM_USER_ID) return;

  const client = getDiscordClient();
  if (!client || !client.users) return;

  let user;
  try {
    user = await client.users.fetch(DM_USER_ID);
  } catch (err) {
    console.error(`${logPrefix} [DM] Cannot fetch user:`, err.message);
    return;
  }

  if (!user) return;

  const lines = [];
  lines.push(`${logPrefix} ${phase} ${alertType} ALERT`);
  lines.push(message);

  if (meta && Object.keys(meta).length > 0) {
    lines.push('');
    lines.push('Details:');
    for (const [k, v] of Object.entries(meta)) {
      lines.push(`• ${k}: ${v}`);
    }
  }

  try {
    await user.send(lines.join('\n'));
  } catch (err) {
    console.error(`${logPrefix} [DM] Failed to send DM:`, err.message);
  }
}

/**
 * Core dedupe + alert engine
 */
function processAlert({
  key,
  isActive,
  signaturePayload,
  logPrefix,
  message,
  meta = {},
  logResolved = true,
  alertType = 'GENERIC'
}) {
  const signature = makeSignature(signaturePayload);

  const prev = alertState.get(key) || {
    isActive: false,
    signature: null
  };

  // NEW ALERT: DM + log
  if (isActive && !prev.isActive) {
    console.warn(`${logPrefix} NEW ALERT: ${message}`, { ...meta });

    // ✅ DM ONLY ON NEW
    sendDm({
      phase: 'NEW',
      alertType,
      logPrefix,
      message,
      meta
    });

    alertState.set(key, { isActive: true, signature });
    return;
  }

  // UPDATED ALERT: tier changed (e.g. MEDIUM → HIGH → CRITICAL)
  if (isActive && prev.isActive && prev.signature !== signature) {
    console.warn(`${logPrefix} ALERT UPDATED: ${message}`, { ...meta });

    // ✅ DM on tier change
    sendDm({
      phase: 'UPDATED',
      alertType,
      logPrefix,
      message,
      meta,
    });

    alertState.set(key, { isActive: true, signature });
    return;
  }

  // NOOP on unchanged active → active
  if (isActive && prev.isActive && prev.signature === signature) {
    return;
  }

  // RESOLVED: log only, NO DM (for now)
  if (!isActive && prev.isActive) {
    console.log(`${logPrefix} RESOLVED: ${message}`, { ...meta });

    // If you ever want resolution DMs, uncomment:
    // if (logResolved) {
    //   sendDm({
    //     phase: 'RESOLVED',
    //     alertType,
    //     logPrefix,
    //     message,
    //     meta
    //   });
    // }

    alertState.set(key, { isActive: false, signature: null });
  }
}

/* ---------------------------
 * Public alert handlers
 * -------------------------- */

function handleLiquidationAlert(data) {
  const {
    protocol, wallet, positionId,
    isActive, tier, ltvPct,
    liquidationPrice, currentPrice, liquidationBufferFrac
  } = data;

  const key = buildAlertKey({
    type: 'LIQUIDATION',
    protocol,
    wallet,
    positionId
  });

  const message = `Loan at risk of liquidation (${protocol}, wallet=${wallet}, position=${positionId}, tier=${tier})`;

  // 🚨 Only tier matters for change detection now
  const signaturePayload = {
    tier,
  };

  const meta = {
    tier,
    ltvPct,
    liquidationPrice,
    currentPrice,
    liquidationBufferFrac
  };

  processAlert({
    key,
    isActive,
    signaturePayload,
    logPrefix: '[LIQ]',
    message,
    meta,
    alertType: 'LIQUIDATION'
  });
}

function handleRedemptionAlert(data) {
  const {
    protocol,
    wallet,
    positionId,
    isActive,
    tier,
    cdpIR,
    globalIR,
    isCDPActive,
  } = data;

  const key = buildAlertKey({
    type: 'REDEMPTION',
    protocol,
    wallet,
    positionId,
  });

  const message = `CDP redemption candidate (${protocol}, wallet=${wallet}, position=${positionId}, tier=${tier}, CDP_ACTIVE=${isCDPActive})`;

  // 🚨 Only tier matters for dedupe (just like liquidation)
  const signaturePayload = {
    tier,
  };

  const meta = {
    tier,
    cdpIR,
    globalIR,
    isCDPActive,
  };

  processAlert({
    key,
    isActive,
    signaturePayload,
    logPrefix: '[REDEMP]',
    message,
    meta,
    alertType: 'REDEMPTION',
  });
}


function handleLpRangeAlert(data) {
  const {
    protocol, wallet, positionId,
    prevStatus, currentStatus,
    isActive, lpRangeTier,
    tickLower, tickUpper, currentTick
  } = data;

  const key = buildAlertKey({
    type: 'LP_RANGE',
    protocol,
    wallet,
    positionId
  });

  const message =
    `LP range change (${protocol}, wallet=${wallet}, position=${positionId}): ${prevStatus} → ${currentStatus} (tier=${lpRangeTier})`;

  const signaturePayload = {
    currentStatus,
    lpRangeTier
  };

  const meta = {
    prevStatus,
    currentStatus,
    lpRangeTier,
    tickLower,
    tickUpper,
    currentTick
  };

  processAlert({
    key,
    isActive,
    signaturePayload,
    logPrefix: '[LP]',
    message,
    meta,
    alertType: 'LP_RANGE'
  });
}

function _getAlertStateSnapshot() {
  return Array.from(alertState.entries());
}

module.exports = {
  handleLiquidationAlert,
  handleRedemptionAlert,
  handleLpRangeAlert,
  _getAlertStateSnapshot,
};
