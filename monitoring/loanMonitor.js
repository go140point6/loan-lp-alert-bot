const path = require('path');
const { ethers } = require('ethers');

const troveNftAbi = require('../abi/troveNFT.json');
const troveManagerAbi = require('../abi/troveManager.json');
const priceFeedAbi = require('../abi/priceFeed.json');
const erc20MetadataAbi = require('../abi/erc20Metadata.json');
const uniswapV3PoolAbi = require('../abi/uniswapV3Pool.json');

const loanConfig = require('../data/loan_contracts.json');

const { getProviderForChain } = require('../utils/providers');
const { readCsvRows } = require('../utils/csv');
const { handleLiquidationAlert, handleRedemptionAlert } = require('./alertEngine');

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
    console.error(`[Config] Env var ${name} must be a finite number, got "${raw}"`);
    process.exit(1);
  }
  return v;
}

// -----------------------------
// Global config from .env (strict)
// -----------------------------

// Verbose flag (strict)
const MONITOR_VERBOSE_ENV = requireEnv('MONITOR_VERBOSE'); // '1' or '0'
const MONITOR_VERBOSE_DEFAULT = MONITOR_VERBOSE_ENV === '1';

// Liquidation buffer thresholds (fractions)
const LIQ_BUFFER_WARN = requireNumberEnv('LIQ_BUFFER_WARN');
const LIQ_BUFFER_HIGH = requireNumberEnv('LIQ_BUFFER_HIGH');
const LIQ_BUFFER_CRIT = requireNumberEnv('LIQ_BUFFER_CRIT');

// Redemption IR thresholds (percentage points)
const REDEMP_BELOW_HIGH = requireNumberEnv('REDEMP_BELOW_HIGH');
const REDEMP_BELOW_MED = requireNumberEnv('REDEMP_BELOW_MED');
const REDEMP_NEUTRAL_ABS = requireNumberEnv('REDEMP_NEUTRAL_ABS');

// CDP redemption trigger (USD)
const CDP_REDEMPTION_TRIGGER = requireNumberEnv('CDP_REDEMPTION_TRIGGER');

// CDP price mode and related config (strict)
const CDP_PRICE_MODE_RAW = requireEnv('CDP_PRICE_MODE'); // 'POOL' or 'ENV'
const CDP_PRICE_MODE = CDP_PRICE_MODE_RAW.toUpperCase();

if (!['POOL', 'ENV'].includes(CDP_PRICE_MODE)) {
  console.error(
    `[Config] CDP_PRICE_MODE must be "POOL" or "ENV", got "${CDP_PRICE_MODE_RAW}"`
  );
  process.exit(1);
}

let CDP_POOL_ADDR_FLR = null;
let CDP_PRICE_USD_ENV = null;

if (CDP_PRICE_MODE === 'POOL') {
  CDP_POOL_ADDR_FLR = requireEnv('CDP_POOL_ADDR_FLR');
} else {
  CDP_PRICE_USD_ENV = requireNumberEnv('CDP_PRICE_USD');
}

// Global IR JSON source (strict, no defaults)
const GLOBAL_IR_URL = requireEnv('GLOBAL_IR_URL');
// Comma-separated branch keys, e.g. "FXRP,WFLR"
const GLOBAL_IR_BRANCHES_RAW = requireEnv('GLOBAL_IR_BRANCHES');
const GLOBAL_IR_BRANCHES = GLOBAL_IR_BRANCHES_RAW.split(',').map((s) => s.trim()).filter(Boolean);
if (GLOBAL_IR_BRANCHES.length === 0) {
  console.error('[Config] GLOBAL_IR_BRANCHES must contain at least one branch, e.g. "FXRP,WFLR"');
  process.exit(1);
}

// Alert tier thresholds (strict)
const LIQ_TIER_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'];
const REDEMP_TIER_ORDER = ['LOW', 'NEUTRAL', 'MEDIUM', 'HIGH', 'UNKNOWN'];

const LIQ_ALERT_MIN_TIER_RAW = requireEnv('LIQ_ALERT_MIN_TIER');
if (!LIQ_TIER_ORDER.includes(LIQ_ALERT_MIN_TIER_RAW)) {
  console.error(
    `[Config] LIQ_ALERT_MIN_TIER must be one of ${LIQ_TIER_ORDER.join(', ')}, got "${LIQ_ALERT_MIN_TIER_RAW}"`
  );
  process.exit(1);
}
const LIQ_ALERT_MIN_TIER = LIQ_ALERT_MIN_TIER_RAW;

const REDEMP_ALERT_MIN_TIER_RAW = requireEnv('REDEMP_ALERT_MIN_TIER');
if (!REDEMP_TIER_ORDER.includes(REDEMP_ALERT_MIN_TIER_RAW)) {
  console.error(
    `[Config] REDEMP_ALERT_MIN_TIER must be one of ${REDEMP_TIER_ORDER.join(', ')}, got "${REDEMP_ALERT_MIN_TIER_RAW}"`
  );
  process.exit(1);
}
const REDEMP_ALERT_MIN_TIER = REDEMP_ALERT_MIN_TIER_RAW;

// -----------------------------
// Helpers
// -----------------------------

function isTierAtLeast(tier, minTier, order) {
  const idx = order.indexOf(tier || 'UNKNOWN');
  const minIdx = order.indexOf(minTier || 'UNKNOWN');
  if (idx === -1 || minIdx === -1) return false;
  return idx >= minIdx;
}

function troveStatusToString(code) {
  const n = Number(code);
  switch (n) {
    case 1:
      return 'ACTIVE';
    case 2:
      return 'CLOSED_BY_OWNER';
    case 3:
      return 'CLOSED_BY_LIQUIDATION';
    case 4:
      return 'CLOSED_BY_REDEMPTION';
    default:
      return `UNKNOWN(${n})`;
  }
}

// price helper for loans
async function getOraclePrice(priceFeedContract) {
  try {
    const [price, isValid] = await priceFeedContract.fetchPrice();
    if (isValid && price && price.toString() !== '0') {
      return { rawPrice: price, source: 'fetchPrice()' };
    }
  } catch (_) {}

  try {
    const last = await priceFeedContract.lastGoodPrice();
    if (last && last.toString() !== '0') {
      return { rawPrice: last, source: 'lastGoodPrice()' };
    }
  } catch (_) {}

  try {
    const [redPrice, isValidRed] = await priceFeedContract.fetchRedemptionPrice();
    if (isValidRed && redPrice && redPrice.toString() !== '0') {
      return { rawPrice: redPrice, source: 'fetchRedemptionPrice()' };
    }
  } catch (_) {}

  return { rawPrice: null, source: null };
}

// -----------------------------
// Global IR (JSON) - fetched every run
// -----------------------------

async function fetchGlobalIrPctMap() {
  // Node 18+ has global fetch; if you’re on older node, this will throw.
  let res;
  try {
    res = await fetch(GLOBAL_IR_URL, {
      method: 'GET',
      headers: { 'accept': 'application/json' },
    });
  } catch (err) {
    console.error(`[GlobalIR] Failed to fetch JSON from ${GLOBAL_IR_URL}:`, err.message);
    return null;
  }

  if (!res.ok) {
    console.error(`[GlobalIR] HTTP ${res.status} fetching ${GLOBAL_IR_URL}`);
    return null;
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error('[GlobalIR] Failed to parse JSON:', err.message);
    return null;
  }

  const branch = json && json.branch ? json.branch : null;
  if (!branch || typeof branch !== 'object') {
    console.error('[GlobalIR] JSON missing "branch" object; cannot read interest_rate_avg');
    return null;
  }

  const out = {};
  for (const key of GLOBAL_IR_BRANCHES) {
    const node = branch[key];
    const raw = node && node.interest_rate_avg != null ? node.interest_rate_avg : null;
    if (raw == null) {
      console.error(`[GlobalIR] Missing branch.${key}.interest_rate_avg in JSON`);
      continue;
    }

    const v = Number(raw);
    if (!Number.isFinite(v)) {
      console.error(`[GlobalIR] Non-numeric interest_rate_avg for ${key}:`, raw);
      continue;
    }

    // JSON provides 0.047... meaning 4.7% p.a.
    out[key.toUpperCase()] = v * 100.0;
  }

  return out;
}

// Determine which branch applies to a loan protocol string.
// This is intentionally simple and explicit for your current setup.
function inferBranchKeyFromProtocol(protocol) {
  const p = (protocol || '').toUpperCase();
  if (p.includes('FXRP')) return 'FXRP';
  if (p.includes('WFLR')) return 'WFLR';
  return null;
}

function getGlobalInterestRatePctFromMap(protocol, globalIrMap) {
  if (!globalIrMap) return null;
  const branchKey = inferBranchKeyFromProtocol(protocol);
  if (!branchKey) return null;
  const v = globalIrMap[branchKey];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// -----------------------------
// Tier classifiers
// -----------------------------

function classifyRedemptionTier(interestPct, globalPct) {
  if (globalPct == null) {
    return {
      tier: 'UNKNOWN',
      diffPct: null,
      diffLabel: 'no global IR available',
    };
  }

  const diff = interestPct - globalPct;
  const absDiff = Math.abs(diff);

  let tier;
  if (diff <= REDEMP_BELOW_HIGH) {
    tier = 'HIGH';
  } else if (diff <= REDEMP_BELOW_MED) {
    tier = 'MEDIUM';
  } else if (absDiff <= REDEMP_NEUTRAL_ABS) {
    tier = 'NEUTRAL';
  } else {
    tier = 'LOW';
  }

  return {
    tier,
    diffPct: diff,
    diffLabel: (diff >= 0 ? '+' : '') + diff.toFixed(2) + ' pp vs global',
  };
}

function classifyLiquidationRisk(bufferFrac) {
  if (bufferFrac == null || !Number.isFinite(bufferFrac)) {
    return {
      tier: 'UNKNOWN',
      bufferFrac: null,
      bufferLabel: 'no buffer / no price',
    };
  }

  let tier;
  if (bufferFrac <= LIQ_BUFFER_CRIT) tier = 'CRITICAL';
  else if (bufferFrac <= LIQ_BUFFER_HIGH) tier = 'HIGH';
  else if (bufferFrac <= LIQ_BUFFER_WARN) tier = 'MEDIUM';
  else tier = 'LOW';

  return {
    tier,
    bufferFrac,
    bufferLabel: `${(bufferFrac * 100).toFixed(2)}% above liquidation`,
  };
}

// -----------------------------
// CDP price (POOL or ENV, strict)
// -----------------------------

function getCdpPriceFromEnv() {
  if (CDP_PRICE_MODE !== 'ENV') return null;
  return CDP_PRICE_USD_ENV;
}

async function getCdpPriceFromPool() {
  if (CDP_PRICE_MODE !== 'POOL') return null;

  let provider;
  try {
    provider = getProviderForChain('FLR', loanConfig.chains);
  } catch (err) {
    console.error('[CDP] Failed to get FLR provider for CDP price:', err.message);
    return null;
  }

  const pool = new ethers.Contract(CDP_POOL_ADDR_FLR, uniswapV3PoolAbi, provider);

  let token0, token1, slot0;
  try {
    [token0, token1, slot0] = await Promise.all([pool.token0(), pool.token1(), pool.slot0()]);
  } catch (err) {
    console.error('[CDP] Failed to read pool token0/token1/slot0:', err.message);
    return null;
  }

  const rawTick = slot0.tick !== undefined ? slot0.tick : slot0[1];
  const tick = Number(rawTick);
  if (!Number.isFinite(tick)) {
    console.error('[CDP] Invalid tick from pool slot0:', rawTick);
    return null;
  }

  const token0Contract = new ethers.Contract(token0, erc20MetadataAbi, provider);
  const token1Contract = new ethers.Contract(token1, erc20MetadataAbi, provider);

  let sym0 = 'TOKEN0';
  let sym1 = 'TOKEN1';
  let dec0 = 18;
  let dec1 = 18;

  try {
    [sym0, sym1, dec0, dec1] = await Promise.all([
      token0Contract.symbol().catch(() => 'TOKEN0'),
      token1Contract.symbol().catch(() => 'TOKEN1'),
      token0Contract.decimals().catch(() => 18),
      token1Contract.decimals().catch(() => 18),
    ]);
  } catch (_) {}

  const sym0U = (sym0 || '').toUpperCase();
  const sym1U = (sym1 || '').toUpperCase();

  const price1Over0NoDecimals = Math.pow(1.0001, tick);
  const decimalFactor = Math.pow(10, Number(dec0) - Number(dec1));
  const price1Over0 = price1Over0NoDecimals * decimalFactor;

  let priceCdpUsd = null;

  if (sym0U.includes('CDP')) {
    priceCdpUsd = price1Over0;
  } else if (sym1U.includes('CDP')) {
    if (price1Over0 === 0) {
      console.error('[CDP] price1Over0 is zero; cannot invert.');
      return null;
    }
    priceCdpUsd = 1 / price1Over0;
  } else {
    console.error(`[CDP] Could not identify CDP token by symbol (token0=${sym0}, token1=${sym1}).`);
    return null;
  }

  if (!Number.isFinite(priceCdpUsd) || priceCdpUsd <= 0) {
    console.error('[CDP] Computed non-finite/negative CDP price:', priceCdpUsd);
    return null;
  }

  return priceCdpUsd;
}

async function getCdpPrice() {
  return CDP_PRICE_MODE === 'POOL' ? getCdpPriceFromPool() : getCdpPriceFromEnv();
}

function classifyCdpRedemptionState(cdpPrice) {
  const trigger = CDP_REDEMPTION_TRIGGER;

  if (cdpPrice == null) {
    return { state: 'UNKNOWN', trigger, diff: null, label: 'no CDP price available' };
  }

  const diff = cdpPrice - trigger;
  const state = cdpPrice < trigger ? 'ACTIVE' : 'DORMANT';

  const label =
    diff >= 0 ? `above trigger by ${diff.toFixed(4)}` : `below trigger by ${Math.abs(diff).toFixed(4)}`;

  return { state, trigger, diff, label };
}

// -----------------------------
// Build a single loan summary object (no logging)
// -----------------------------

async function summarizeLoanPosition(provider, chainId, protocol, row, globalIrMap) {
  const { contract, owner, troveId } = row;

  const troveNFT = new ethers.Contract(contract, troveNftAbi, provider);
  const troveManagerAddr = await troveNFT.troveManager();
  const collTokenAddr = await troveNFT.collToken();

  const troveManager = new ethers.Contract(troveManagerAddr, troveManagerAbi, provider);
  const collToken = new ethers.Contract(collTokenAddr, erc20MetadataAbi, provider);

  const collDecimals = await collToken.decimals();
  const collSymbol = await collToken.symbol();

  const latest = await troveManager.getLatestTroveData(troveId);
  const statusCode = await troveManager.getTroveStatus(troveId);

  const entireDebt = latest.entireDebt;
  const entireColl = latest.entireColl;
  const accruedInterest = latest.accruedInterest;
  const annualInterestRate = latest.annualInterestRate;

  const debtNorm = Number(ethers.formatUnits(entireDebt, 18));
  const collNorm = Number(ethers.formatUnits(entireColl, collDecimals));
  const accruedInterestNorm = Number(ethers.formatUnits(accruedInterest, 18));
  const interestPct = Number(ethers.formatUnits(annualInterestRate, 18)) * 100.0;
  const statusStr = troveStatusToString(statusCode);

  const globalIrPct = getGlobalInterestRatePctFromMap(protocol, globalIrMap);
  const redClass = classifyRedemptionTier(interestPct, globalIrPct);

  const priceFeedAddr = await troveManager.priceFeed();
  const priceFeed = new ethers.Contract(priceFeedAddr, priceFeedAbi, provider);

  const { rawPrice, source } = await getOraclePrice(priceFeed);

  const base = {
    protocol,
    chainId,
    owner,
    troveId,
    nftContract: contract,
    collToken: collTokenAddr,
    collSymbol,
    collAmount: collNorm,
    debtAmount: debtNorm,
    accruedInterest: accruedInterestNorm,

    interestPct,
    globalIrPct,
    redemptionTier: redClass.tier,
    redemptionDiffPct: redClass.diffPct,

    status: statusStr,
    priceSource: source || null,
    hasPrice: false,
    price: null,
    ltv: null,
    ltvPct: null,
    liquidationPrice: null,
    icr: null,
    mcr: null,
  };

  if (!rawPrice) return base;

  const priceNorm = Number(ethers.formatUnits(rawPrice, 18));
  const MCR = await troveManager.MCR();
  const mcrNorm = Number(ethers.formatUnits(MCR, 18));

  const collValue = collNorm * priceNorm;
  const ltv = collValue > 0 ? debtNorm / collValue : 0;
  const liquidationPrice = collNorm > 0 ? (debtNorm * mcrNorm) / collNorm : 0;

  let icrRaw;
  try {
    icrRaw = await troveManager.getCurrentICR(troveId, rawPrice);
  } catch {
    icrRaw = null;
  }
  const icrNorm = icrRaw != null ? Number(ethers.formatUnits(icrRaw, 18)) : null;

  const bufferFrac = priceNorm > 0 ? (priceNorm - liquidationPrice) / priceNorm : null;
  const liqClass = classifyLiquidationRisk(bufferFrac);

  return {
    ...base,
    hasPrice: true,
    price: priceNorm,
    ltv,
    ltvPct: ltv * 100,
    liquidationPrice,
    icr: icrNorm,
    mcr: mcrNorm,
    liquidationBufferFrac: bufferFrac,
    liquidationTier: liqClass.tier,
  };
}

// -----------------------------
// Core loan description (logging)
// -----------------------------

async function describeLoanPosition(provider, chainId, protocol, row, options = {}) {
  const { verbose = MONITOR_VERBOSE_DEFAULT, cdpState = null, globalIrMap = null } = options;
  const { contract, owner, troveId } = row;

  const troveNFT = new ethers.Contract(contract, troveNftAbi, provider);
  const troveManagerAddr = await troveNFT.troveManager();
  const collTokenAddr = await troveNFT.collToken();

  const troveManager = new ethers.Contract(troveManagerAddr, troveManagerAbi, provider);
  const collToken = new ethers.Contract(collTokenAddr, erc20MetadataAbi, provider);

  const collDecimals = await collToken.decimals();
  const collSymbol = await collToken.symbol();

  const latest = await troveManager.getLatestTroveData(troveId);
  const statusCode = await troveManager.getTroveStatus(troveId);

  const debtNorm = Number(ethers.formatUnits(latest.entireDebt, 18));
  const collNorm = Number(ethers.formatUnits(latest.entireColl, collDecimals));
  const accruedInterestNorm = Number(ethers.formatUnits(latest.accruedInterest, 18));
  const interestPct = Number(ethers.formatUnits(latest.annualInterestRate, 18)) * 100.0;
  const statusStr = troveStatusToString(statusCode);

  const globalIrPct = getGlobalInterestRatePctFromMap(protocol, globalIrMap);
  const redClass = classifyRedemptionTier(interestPct, globalIrPct);

  if (verbose) {
    console.log('========================================');
    console.log(`LOAN POSITION (${protocol})`);
    console.log('----------------------------------------');
    console.log(`Owner:    ${owner}`);
    console.log(`Chain:    ${chainId}`);
    console.log(`NFT:      ${contract}`);
    console.log(`Trove ID: ${troveId}`);
    console.log(`TroveManager:  ${troveManagerAddr}`);
    console.log(`Collateral:    ${collTokenAddr}`);
    console.log('');
    console.log('  --- Core Trove Data ---');
    console.log(`  Collateral:        ${collNorm.toFixed(6)} ${collSymbol}`);
    console.log(`  Debt (entire):     ${debtNorm.toFixed(6)} (loan token)`);
    console.log(`  Accrued interest:  ${accruedInterestNorm.toFixed(6)}`);
    console.log(`  Annual rate:       ${interestPct.toFixed(2)}%`);
    console.log(`  Status:            ${statusStr}`);
  }

  const priceFeedAddr = await troveManager.priceFeed();
  const priceFeed = new ethers.Contract(priceFeedAddr, priceFeedAbi, provider);
  const { rawPrice, source } = await getOraclePrice(priceFeed);

  if (!rawPrice) {
    console.log(`${protocol} is ${statusStr} but no price is available to compute LTV / liquidation price.`);
    return;
  }

  const priceNorm = Number(ethers.formatUnits(rawPrice, 18));
  const MCR = await troveManager.MCR();
  const mcrNorm = Number(ethers.formatUnits(MCR, 18));

  const collValue = collNorm * priceNorm;
  const ltv = collValue > 0 ? debtNorm / collValue : 0;
  const liquidationPrice = collNorm > 0 ? (debtNorm * mcrNorm) / collNorm : 0;
  const bufferFrac = priceNorm > 0 ? (priceNorm - liquidationPrice) / priceNorm : null;

  const liqClass = classifyLiquidationRisk(bufferFrac);

  // Compact summary log
  const ltvPct = ltv * 100;
  console.log(
    `${protocol} is ${statusStr} with LTV of ${ltvPct.toFixed(2)}%. Current price ${priceNorm.toFixed(5)} with liquidation price ${liquidationPrice.toFixed(5)}.`
  );

  // Alerts
  const liqAlertActive = isTierAtLeast(liqClass.tier, LIQ_ALERT_MIN_TIER, LIQ_TIER_ORDER);

  handleLiquidationAlert({
    protocol,
    wallet: owner,
    positionId: troveId,
    isActive: liqAlertActive,
    tier: liqClass.tier,
    ltvPct,
    liquidationPrice,
    currentPrice: priceNorm,
    liquidationBufferFrac: bufferFrac,
  });

  const cdpIsActive = cdpState && cdpState.state === 'ACTIVE';
  const redAlertActive =
    cdpIsActive && isTierAtLeast(redClass.tier, REDEMP_ALERT_MIN_TIER, REDEMP_TIER_ORDER);

  handleRedemptionAlert({
    protocol,
    wallet: owner,
    positionId: troveId,
    isActive: redAlertActive,
    tier: redClass.tier,
    cdpIR: interestPct,
    globalIR: globalIrPct,
    isCDPActive: cdpIsActive,
  });

  if (!verbose) {
    if (bufferFrac != null) {
      console.log(
        `${protocol} liquidation buffer ${(bufferFrac * 100).toFixed(2)}% (tier ${liqClass.tier}).`
      );
    } else {
      console.log(`${protocol} liquidation buffer unknown (no price / liq data).`);
    }

    if (globalIrPct != null) {
      console.log(
        `${protocol} IR ${interestPct.toFixed(2)}% vs global ${globalIrPct.toFixed(2)}% (${redClass.diffLabel}, tier ${redClass.tier}).`
      );
    } else {
      console.log(`${protocol} IR ${interestPct.toFixed(2)}% (global IR unavailable).`);
    }
  } else {
    console.log('');
    console.log('  --- Redemption Profile (IR-based) ---');
    console.log(`  Interest rate:     ${interestPct.toFixed(2)} % p.a.`);
    if (globalIrPct != null) {
      console.log(`  Global IR (json):  ${globalIrPct.toFixed(2)} % p.a.`);
      console.log(`  Delta:             ${redClass.diffLabel}`);
      console.log(`  Est. tier:         ${redClass.tier} redemption priority`);
    } else {
      console.log('  Global IR (json):  (unavailable)');
    }

    console.log('');
    console.log('  --- Liquidation Profile ---');
    console.log(`  Price source:     ${source}`);
    console.log(`  Price:            ${priceNorm.toFixed(5)}`);
    console.log(`  Liq. price:       ${liquidationPrice.toFixed(5)}`);
    if (bufferFrac != null) {
      console.log(`  Buffer:           ${(bufferFrac * 100).toFixed(2)}% above liq.`);
      console.log(`  Liq. tier:        ${liqClass.tier}`);
    } else {
      console.log('  Buffer:           (not available)');
    }
    console.log('========================================');
    console.log('');
  }
}

// -----------------------------
// Public API: monitorLoans
// -----------------------------

async function monitorLoans(options = {}) {
  const verbose = options.verbose ?? MONITOR_VERBOSE_DEFAULT;

  // Fetch CDP context
  const cdpPrice = await getCdpPrice();
  const cdpState = classifyCdpRedemptionState(cdpPrice);

  // Fetch global IR map EVERY RUN
  const globalIrMap = await fetchGlobalIrPctMap();

  // --- Log CDP + Global IR under it (both verbose and non-verbose) ---
  if (verbose) {
    console.log('');
    console.log('=== CDP + Global IR Context ===');
    if (cdpPrice == null) {
      console.log('  CDP price:        (not available)');
      console.log(`  Trigger:          ${cdpState.trigger.toFixed(4)} USD (CDP_REDEMPTION_TRIGGER)`);
      console.log('  State:            UNKNOWN (no CDP price available)');
    } else {
      console.log(`  CDP price:        ${cdpPrice.toFixed(4)} USD`);
      console.log(`  Trigger:          ${cdpState.trigger.toFixed(4)} USD (CDP_REDEMPTION_TRIGGER)`);
      console.log(`  State:            ${cdpState.state} (${cdpState.label})`);
    }

    if (!globalIrMap) {
      console.log(`  Global IR (json):  (FAILED to fetch/parse: ${GLOBAL_IR_URL})`);
    } else {
      for (const k of GLOBAL_IR_BRANCHES) {
        const v = globalIrMap[k.toUpperCase()];
        if (typeof v === 'number') {
          console.log(`  Global IR ${k}:     ${v.toFixed(4)} % p.a.`);
        } else {
          console.log(`  Global IR ${k}:     (missing/invalid in JSON)`);
        }
      }
    }

    console.log('===============================');
    console.log('');
  } else {
    // Compact single-line version
    const cdpLine =
      cdpPrice == null
        ? `CDP price unknown; redemption state UNKNOWN (trigger ${cdpState.trigger.toFixed(4)}).`
        : `CDP price ${cdpPrice.toFixed(4)} USD; redemption state ${cdpState.state} (trigger ${cdpState.trigger.toFixed(4)}, ${cdpState.label}).`;

    let irLine = '';
    if (!globalIrMap) {
      irLine = ` Global IR: FAILED (${GLOBAL_IR_URL}).`;
    } else {
      const parts = [];
      for (const k of GLOBAL_IR_BRANCHES) {
        const v = globalIrMap[k.toUpperCase()];
        parts.push(typeof v === 'number' ? `${k}=${v.toFixed(4)}%` : `${k}=n/a`);
      }
      irLine = ` Global IR: ${parts.join(', ')}.`;
    }

    console.log(cdpLine + irLine);
  }

  console.log(''); // spacer before per-loan logs

  for (const [chainId, chainCfg] of Object.entries(loanConfig.chains || {})) {
    let provider;
    try {
      provider = getProviderForChain(chainId, loanConfig.chains);
    } catch (err) {
      console.error(`[Loans] Skipping chain ${chainId}: ${err.message}`);
      continue;
    }

    for (const c of chainCfg.contracts || []) {
      const csvPath = path.join(__dirname, '..', 'data', c.csvFile);

      const rows = readCsvRows(csvPath);
      for (const row of rows) {
        const chain = (row.chain || '').toUpperCase();
        const owner = row.owner;
        const contract = row.contract;
        const troveId = row.troveId;

        if (!chain || !owner || !contract || !troveId) {
          console.log('  Skipping loan row with missing fields:', row);
          continue;
        }

        if (chain !== chainId) continue;

        try {
          await describeLoanPosition(
            provider,
            chainId,
            c.protocol || c.key || 'UNKNOWN_PROTOCOL',
            row,
            { verbose, cdpState, globalIrMap }
          );
        } catch (err) {
          console.error(
            `  [ERROR] Failed to describe loan position troveId=${troveId} on ${chainId}:`,
            err.message
          );
        }
      }
    }
  }
}

// -----------------------------
// Public API: getLoanSummaries
// -----------------------------

async function getLoanSummaries() {
  const summaries = [];

  // Fetch global IR map once for the summaries call (no logging here)
  const globalIrMap = await fetchGlobalIrPctMap();

  for (const [chainId, chainCfg] of Object.entries(loanConfig.chains || {})) {
    let provider;
    try {
      provider = getProviderForChain(chainId, loanConfig.chains);
    } catch (err) {
      console.error(`[Loans] Skipping chain ${chainId} in getLoanSummaries: ${err.message}`);
      continue;
    }

    for (const c of chainCfg.contracts || []) {
      const csvPath = path.join(__dirname, '..', 'data', c.csvFile);

      const rows = readCsvRows(csvPath);
      for (const row of rows) {
        const chain = (row.chain || '').toUpperCase();
        const owner = row.owner;
        const contract = row.contract;
        const troveId = row.troveId;

        if (!chain || !owner || !contract || !troveId) {
          console.log('  Skipping loan row with missing fields:', row);
          continue;
        }

        if (chain !== chainId) continue;

        const protocol = c.protocol || c.key || 'UNKNOWN_PROTOCOL';

        try {
          const summary = await summarizeLoanPosition(provider, chainId, protocol, row, globalIrMap);
          if (summary) summaries.push(summary);
        } catch (err) {
          console.error(`[Loans] Failed to build summary for troveId=${troveId} on ${chainId}:`, err.message);
        }
      }
    }
  }

  return summaries;
}

module.exports = {
  monitorLoans,
  getLoanSummaries,
  getCdpPrice,
  classifyCdpRedemptionState,
};
