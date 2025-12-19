const path = require('path');
const { ethers } = require('ethers');

const positionManagerAbi = require('../abi/positionManager.json');
const uniswapV3FactoryAbi = require('../abi/uniswapV3Factory.json');
const uniswapV3PoolAbi = require('../abi/uniswapV3Pool.json');
const erc20MetadataAbi = require('../abi/erc20Metadata.json');

const lpConfig = require('../data/lp_contracts.json');
const lpIgnoreConfig = require('../data/lp_ignore.json');

const { getProviderForChain } = require('../utils/providers');
const { readCsvRows } = require('../utils/csv');

const {
  handleLpRangeAlert,
} = require('./alertEngine');

// -----------------------------
// Env helpers (strict)
// -----------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') {
    console.error(`[Config] Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

function requireNumberEnv(name) {
  const raw = requireEnv(name);
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    console.error(
      `[Config] Env var ${name} must be a finite number, got "${raw}"`
    );
    process.exit(1);
  }
  return v;
}

// -----------------------------
// LP alert thresholds & state
// -----------------------------

const LP_TIER_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'];

const LP_ALERT_MIN_TIER_RAW = requireEnv('LP_ALERT_MIN_TIER'); // e.g. MEDIUM
if (!LP_TIER_ORDER.includes(LP_ALERT_MIN_TIER_RAW)) {
  console.error(
    `[Config] LP_ALERT_MIN_TIER must be one of ${LP_TIER_ORDER.join(
      ', '
    )}, got "${LP_ALERT_MIN_TIER_RAW}"`
  );
  process.exit(1);
}
const LP_ALERT_MIN_TIER = LP_ALERT_MIN_TIER_RAW;

// Fractions for tiering (all required)
const LP_EDGE_WARN_FRAC = requireNumberEnv('LP_EDGE_WARN_FRAC');
const LP_EDGE_HIGH_FRAC = requireNumberEnv('LP_EDGE_HIGH_FRAC');
const LP_OUT_WARN_FRAC = requireNumberEnv('LP_OUT_WARN_FRAC');
const LP_OUT_HIGH_FRAC = requireNumberEnv('LP_OUT_HIGH_FRAC');

// Verbose flag (required)
const MONITOR_VERBOSE_ENV = requireEnv('MONITOR_VERBOSE');
const MONITOR_VERBOSE_DEFAULT = MONITOR_VERBOSE_ENV === '1';

function isLpTierAtLeast(tier, minTier) {
  const idx = LP_TIER_ORDER.indexOf(tier || 'UNKNOWN');
  const minIdx = LP_TIER_ORDER.indexOf(minTier || 'UNKNOWN');
  if (idx === -1 || minIdx === -1) return false;
  return idx >= minIdx;
}

// Track previous range status per LP position so we can see transitions
// key = `${protocol}:${chainId}:${owner}:${tokenId}`
const lpPrevStatus = new Map();

// -----------------------------
// Token symbol cache
// -----------------------------

const tokenSymbolCache = new Map();

async function getTokenSymbol(provider, address) {
  const key = address.toLowerCase();
  if (tokenSymbolCache.has(key)) {
    return tokenSymbolCache.get(key);
  }

  const token = new ethers.Contract(address, erc20MetadataAbi, provider);
  const symbol = await token.symbol();
  tokenSymbolCache.set(key, symbol);
  return symbol;
}

// -----------------------------
// Ignore helpers
// -----------------------------

function isIgnoredLpPosition(protocol, row) {
  const cfg = lpIgnoreConfig[protocol];
  if (!cfg) return false;

  const tokenIdStr = String(row.tokenId);

  if (Array.isArray(cfg.tokenIds) && cfg.tokenIds.includes(tokenIdStr)) {
    return true;
  }

  return false;
}

// -----------------------------
// LP range tier classification
// -----------------------------

/**
 * Classify LP "range risk" based on:
 * - rangeStatus: IN_RANGE / OUT_OF_RANGE / UNKNOWN / etc.
 * - tickLower, tickUpper, currentTick
 *
 * Env-based knobs (all are FRACTIONS of total tick width):
 *   LP_EDGE_WARN_FRAC  → in-range: near edge → MEDIUM
 *   LP_EDGE_HIGH_FRAC  → in-range: very near edge → HIGH
 *
 *   LP_OUT_WARN_FRAC   → out-of-range but <= this × width away → MEDIUM
 *   LP_OUT_HIGH_FRAC   → out-of-range but <= this × width away → HIGH
 *   > LP_OUT_HIGH_FRAC → CRITICAL
 */
function classifyLpRangeTier(rangeStatus, tickLower, tickUpper, currentTick) {
  const normStatus = (rangeStatus || '')
    .toString()
    .toUpperCase()
    .replace(/\s+/g, '_'); // handles "IN RANGE" vs "IN_RANGE"

  const width = tickUpper - tickLower;
  const hasTicks =
    Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(tickLower) &&
    Number.isFinite(tickUpper) &&
    Number.isFinite(currentTick);

  const edgeWarn = LP_EDGE_WARN_FRAC;
  const edgeHigh = LP_EDGE_HIGH_FRAC;
  const outWarn = LP_OUT_WARN_FRAC;
  const outHigh = LP_OUT_HIGH_FRAC;

  // In-range → LOW / MEDIUM / HIGH depending how close we are to the edge
  if (normStatus === 'IN_RANGE' && hasTicks) {
    const positionFrac = (currentTick - tickLower) / width; // 0..1 inside the band
    const centerDist = Math.min(positionFrac, 1 - positionFrac); // distance to nearest edge

    if (!Number.isFinite(centerDist) || centerDist < 0) {
      return {
        tier: 'UNKNOWN',
        positionFrac: null,
        distanceFrac: null,
        label: 'invalid in-range tick geometry',
      };
    }

    let tier = 'LOW';
    if (Number.isFinite(edgeHigh) && centerDist <= edgeHigh) {
      tier = 'HIGH'; // hugging the edge
    } else if (Number.isFinite(edgeWarn) && centerDist <= edgeWarn) {
      tier = 'MEDIUM'; // somewhat close to edge
    }

    let label;
    if (tier === 'LOW') {
      label = 'comfortably in range';
    } else if (tier === 'MEDIUM') {
      label = 'in range but near edge';
    } else if (tier === 'HIGH') {
      label = 'in range and very close to edge';
    }

    return {
      tier,
      positionFrac,
      distanceFrac: centerDist,
      label,
    };
  }

  // Out-of-range → MEDIUM / HIGH / CRITICAL depending how far we drifted
  if (normStatus === 'OUT_OF_RANGE' && hasTicks) {
    let distanceFrac = null;

    if (currentTick < tickLower) {
      distanceFrac = (tickLower - currentTick) / width;
    } else if (currentTick >= tickUpper) {
      distanceFrac = (currentTick - tickUpper) / width;
    }

    if (!Number.isFinite(distanceFrac) || distanceFrac < 0) {
      return {
        tier: 'HIGH', // conservative default
        positionFrac: null,
        distanceFrac: null,
        label: 'out of range (distance unknown)',
      };
    }

    let tier;
    if (Number.isFinite(outWarn) && distanceFrac <= outWarn) {
      tier = 'MEDIUM'; // just slipped out
    } else if (Number.isFinite(outHigh) && distanceFrac <= outHigh) {
      tier = 'HIGH'; // significantly out
    } else {
      tier = 'CRITICAL'; // way out
    }

    let label;
    if (tier === 'MEDIUM') {
      label = 'slightly out of range';
    } else if (tier === 'HIGH') {
      label = 'far out of range';
    } else {
      label = 'deeply out of range';
    }

    return {
      tier,
      positionFrac: null, // not meaningful when out-of-range
      distanceFrac,
      label,
    };
  }

  // Unknown / not computed / no tick info
  return {
    tier: normStatus === 'IN_RANGE' ? 'LOW' : 'UNKNOWN',
    positionFrac: null,
    distanceFrac: null,
    label:
      normStatus === 'IN_RANGE'
        ? 'in range (no detailed geometry)'
        : 'range not computed',
  };
}

// -----------------------------
// LP summary builder (no logging)
// -----------------------------

async function summarizeLpPosition(provider, chainId, protocol, row) {
  const { contract, owner, tokenId } = row;
  const tokenIdBN = BigInt(tokenId);

  const pm = new ethers.Contract(contract, positionManagerAbi, provider);
  const pos = await pm.positions(tokenIdBN);

  const liquidity = BigInt(pos.liquidity.toString());
  if (liquidity === 0n) {
    // Inactive position; ignore it in summaries
    return null;
  }

  const token0 = pos.token0;
  const token1 = pos.token1;
  const fee = Number(pos.fee);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);

  // Try to get token symbols (best-effort, using cache)
  let token0Symbol = token0;
  let token1Symbol = token1;

  try {
    token0Symbol = await getTokenSymbol(provider, token0);
  } catch (_) {}

  try {
    token1Symbol = await getTokenSymbol(provider, token1);
  } catch (_) {}

  const pairLabel = `${token0Symbol}-${token1Symbol}`;

  // --- Dynamic factory detection + range status ---
  let poolAddr = null;
  let currentTick = null;
  let rangeStatus = 'UNKNOWN';

  try {
    const factoryAddr = await pm.factory();
    if (factoryAddr && factoryAddr !== ethers.ZeroAddress) {
      const factory = new ethers.Contract(
        factoryAddr,
        uniswapV3FactoryAbi,
        provider
      );

      poolAddr = await factory.getPool(token0, token1, fee);
      if (poolAddr && poolAddr !== ethers.ZeroAddress) {
        const pool = new ethers.Contract(poolAddr, uniswapV3PoolAbi, provider);
        const slot0 = await pool.slot0();

        const tick = slot0.tick !== undefined ? slot0.tick : slot0[1];
        currentTick = Number(tick);

        if (currentTick >= tickLower && currentTick < tickUpper) {
          rangeStatus = 'IN_RANGE';
        } else {
          rangeStatus = 'OUT_OF_RANGE';
        }
      }
    }
  } catch (_) {
    // best-effort only; leave status as UNKNOWN on failure
  }

  // Classify range tier (uses ticks + currentTick + rangeStatus)
  const lpClass = classifyLpRangeTier(
    rangeStatus,
    tickLower,
    tickUpper,
    currentTick
  );

  return {
    protocol,
    chainId,
    owner,
    tokenId,
    nftContract: contract,

    // Pair info
    token0,
    token1,
    token0Symbol,
    token1Symbol,
    pairLabel,

    // Position params
    fee,
    tickLower,
    tickUpper,
    currentTick,
    liquidity: liquidity.toString(),
    status: 'ACTIVE',
    rangeStatus,
    poolAddr,

    // LP range tiering
    lpRangeTier: lpClass.tier,            // LOW / MEDIUM / HIGH / CRITICAL / UNKNOWN
    lpRangeLabel: lpClass.label,          // human-readable
    lpPositionFrac: lpClass.positionFrac, // 0..1 inside band when in-range
    lpDistanceFrac: lpClass.distanceFrac, // distance to edge (in-range) or out-of-range distance
  };
}

// Return structured summaries for all monitored LP positions (no logging)
async function getLpSummaries() {
  const summaries = [];

  for (const [chainId, chainCfg] of Object.entries(lpConfig.chains || {})) {
    let provider;
    try {
      provider = getProviderForChain(chainId, lpConfig.chains);
    } catch (err) {
      console.error(
        `[LP] Skipping chain ${chainId} in getLpSummaries: ${err.message}`
      );
      continue;
    }

    for (const c of chainCfg.contracts || []) {
      const csvPath = path.join(__dirname, '..', 'data', c.csvFile);

      const rows = readCsvRows(csvPath);
      for (const row of rows) {
        const chain = (row.chain || '').toUpperCase();
        const owner = row.owner;
        const contract = row.contract;
        const tokenId = row.tokenId;

        if (!chain || !owner || !contract || !tokenId) {
          console.log('  [LP] Skipping row with missing fields:', row);
          continue;
        }

        if (chain !== chainId) {
          continue;
        }

        const protocol = c.protocol || c.key || 'UNKNOWN_PROTOCOL';

        // Respect lp_ignore.json (tokenId-level)
        if (isIgnoredLpPosition(protocol, row)) {
          continue;
        }

        try {
          const summary = await summarizeLpPosition(
            provider,
            chainId,
            protocol,
            row
          );
          if (summary) {
            summaries.push(summary);
          }
        } catch (err) {
          console.error(
            `[LP] Failed to build LP summary tokenId=${tokenId} on ${chainId}:`,
            err.message
          );
        }
      }
    }
  }

  return summaries;
}

// -----------------------------
// Core LP description (logging)
// -----------------------------

async function describeLpPosition(
  provider,
  chainId,
  protocol,
  row,
  options = {}
) {
  const { verbose = MONITOR_VERBOSE_DEFAULT } = options;
  const { contract, owner, tokenId } = row;
  const tokenIdBN = BigInt(tokenId);

  const pm = new ethers.Contract(contract, positionManagerAbi, provider);
  const pos = await pm.positions(tokenIdBN);

  const liquidity = BigInt(pos.liquidity.toString());

  // Ignore inactive LPs (liquidity == 0)
  if (liquidity === 0n) {
    if (verbose) {
      console.log(
        `${protocol} tokenId=${tokenId} on ${chainId} has zero liquidity; treating as INACTIVE.`
      );
    }
    return;
  }

  const token0 = pos.token0;
  const token1 = pos.token1;
  const fee = Number(pos.fee);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);

  // Optional: if your CSV has a "pairLabel" or similar, use it.
  const csvPairLabel =
    row.pairLabel || row.tokenPair || row.pair || '';

  let token0Symbol = '';
  let token1Symbol = '';
  let pairLabel = csvPairLabel;

  try {
    if (!pairLabel) {
      // Resolve from chain if not provided in CSV
      [token0Symbol, token1Symbol] = await Promise.all([
        getTokenSymbol(provider, token0),
        getTokenSymbol(provider, token1),
      ]);
      pairLabel = `${token0Symbol}-${token1Symbol}`;
    }
  } catch (e) {
    // If symbol resolution fails, fall back to addresses in the verbose block
    if (verbose) {
      console.warn(
        `  ⚠️  Could not resolve token symbols for LP token ${tokenId} (${protocol}):`,
        e.message
      );
    }
    // Minimal fallback
    pairLabel = pairLabel || `${token0}-${token1}`;
  }

  if (verbose) {
    console.log('========================================');
    console.log(`LP POSITION (${protocol})`);
    console.log('----------------------------------------');
    console.log(`Owner:    ${owner}`);
    console.log(`Chain:    ${chainId}`);
    console.log(`NFT:      ${contract}`);
    console.log(`tokenId:  ${tokenId}`);
    console.log('');
    console.log('  --- Basic Position Data ---');
    console.log(`  token0:        ${token0}`);
    console.log(`  token1:        ${token1}`);
    console.log(`  fee:           ${fee}`);
    console.log(`  tickLower:     ${tickLower}`);
    console.log(`  tickUpper:     ${tickUpper}`);
    console.log(`  liquidity:     ${liquidity.toString()}`);
    console.log(`  status:        ACTIVE`);
    if (pairLabel) {
      console.log(`  pairLabel:     ${pairLabel}`);
    }
  }

  // --- Dynamic factory detection + range status ---
  let rangeStatus = '(not computed)';
  let poolAddr = null;
  let currentTick = null;

  try {
    const factoryAddr = await pm.factory();

    if (factoryAddr && factoryAddr !== ethers.ZeroAddress) {
      const factory = new ethers.Contract(
        factoryAddr,
        uniswapV3FactoryAbi,
        provider
      );

      poolAddr = await factory.getPool(token0, token1, fee);

      if (poolAddr && poolAddr !== ethers.ZeroAddress) {
        const pool = new ethers.Contract(
          poolAddr,
          uniswapV3PoolAbi,
          provider
        );

        const slot0 = await pool.slot0();

        const tick = slot0.tick !== undefined ? slot0.tick : slot0[1];

        currentTick = Number(tick);

        if (currentTick >= tickLower && currentTick < tickUpper) {
          rangeStatus = 'IN RANGE';
        } else {
          rangeStatus = 'OUT OF RANGE';
        }
      }
    }
  } catch (err) {
    console.error(
      `  Could not compute range for LP token ${tokenId} (${protocol}):`,
      err.message
    );
  }

  // Normalize status for classification & alerting
  const normCurrentStatus =
    rangeStatus === '(not computed)'
      ? 'UNKNOWN'
      : (rangeStatus || '')
          .toString()
          .toUpperCase()
          .replace(/\s+/g, '_'); // "IN RANGE" -> "IN_RANGE"

  // Range tiering based on ticks + currentTick + status
  const lpClass = classifyLpRangeTier(
    normCurrentStatus,
    tickLower,
    tickUpper,
    currentTick
  );

  // --- LP alert engine integration (range-status based) ---
  const lpKey = `${protocol}:${chainId}:${owner}:${tokenId}`;
  const prevStatus = lpPrevStatus.get(lpKey) || 'UNKNOWN';

  // LP alerts only considered "active" when OUT_OF_RANGE and tier >= LP_ALERT_MIN_TIER
  const isActive =
    normCurrentStatus === 'OUT_OF_RANGE' &&
    isLpTierAtLeast(lpClass.tier, LP_ALERT_MIN_TIER);

  handleLpRangeAlert({
    protocol,
    wallet: owner,
    positionId: tokenId,
    prevStatus,
    currentStatus: normCurrentStatus,
    isActive,
    lpRangeTier: lpClass.tier,
    tickLower,
    tickUpper,
    currentTick,
  });

  // Update previous status for next run
  lpPrevStatus.set(lpKey, normCurrentStatus);

  if (verbose) {
    console.log('');
    console.log('  --- Range Status ---');
    if (poolAddr && currentTick != null) {
      console.log(`  pool:          ${poolAddr}`);
      console.log(`  currentTick:   ${currentTick}`);
    }
    console.log(`  range:         ${rangeStatus}`);
    console.log(
      `  range tier:    ${lpClass.tier} (${lpClass.label})`
    );

    if (lpClass.positionFrac != null) {
      console.log(
        `  position:      ${(lpClass.positionFrac * 100).toFixed(
          2
        )}% from lower bound`
      );
    }
    if (lpClass.distanceFrac != null) {
      console.log(
        `  edge/dist:     ${(lpClass.distanceFrac * 100).toFixed(
          2
        )}% of width`
      );
    }

    console.log('========================================');
    console.log('');
  }

  // === Compact summary log ===
  const humanRange =
    rangeStatus === '(not computed)'
      ? 'with unknown range'
      : `and ${rangeStatus}`;

  const tierPart =
    lpClass.tier && lpClass.tier !== 'UNKNOWN'
      ? ` (tier ${lpClass.tier})`
      : '';

  console.log(
    `${protocol} ${pairLabel || 'UNKNOWN_PAIR'} is ACTIVE ${humanRange}${tierPart}.`
  );
}

// -----------------------------
// Public API: monitorLPs
// -----------------------------

async function monitorLPs(options = {}) {
  const verbose = options.verbose ?? MONITOR_VERBOSE_DEFAULT;

  // Single blank line between loans and the first LP block
  console.log('');

  let firstGroup = true;

  for (const [chainId, chainCfg] of Object.entries(lpConfig.chains || {})) {
    let provider;
    try {
      provider = getProviderForChain(chainId, lpConfig.chains);
    } catch (err) {
      console.error(`[LP] Skipping chain ${chainId}: ${err.message}`);
      continue;
    }

    for (const c of chainCfg.contracts || []) {
      const csvPath = path.join(__dirname, '..', 'data', c.csvFile);

      // Blank line between protocol groups (ENOSYS_LP vs SPARKDEX_LP, etc.)
      if (!firstGroup) {
        console.log('');
      }
      firstGroup = false;

      const rows = readCsvRows(csvPath);
      for (const row of rows) {
        const chain = (row.chain || '').toUpperCase();
        const owner = row.owner;
        const contract = row.contract;
        const tokenId = row.tokenId;

        if (!chain || !owner || !contract || !tokenId) {
          console.log('  Skipping LP row with missing fields:', row);
          continue;
        }

        if (chain !== chainId) {
          continue;
        }

        const protocol = c.protocol || c.key || 'UNKNOWN_PROTOCOL';

        // Check ignore list BEFORE we do any RPC work for this row
        if (isIgnoredLpPosition(protocol, row)) {
          continue;
        }

        try {
          await describeLpPosition(
            provider,
            chainId,
            protocol,
            row,
            { verbose }
          );
        } catch (err) {
          console.error(
            `  [ERROR] Failed to describe LP position tokenId=${tokenId} on ${chainId}:`,
            err.message
          );
        }
      }
    }
  }
}

module.exports = {
  monitorLPs,
  getLpSummaries,
  getLpSummaries,
};