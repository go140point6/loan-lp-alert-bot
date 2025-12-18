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
const {
  handleLiquidationAlert,
  handleRedemptionAlert,
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
// Global config from .env
// -----------------------------

// Verbose flag
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

// CDP price mode and related config
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
} else if (CDP_PRICE_MODE === 'ENV') {
  CDP_PRICE_USD_ENV = requireNumberEnv('CDP_PRICE_USD');
}

// Alert tier thresholds
const LIQ_TIER_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'];
const REDEMP_TIER_ORDER = ['LOW', 'NEUTRAL', 'MEDIUM', 'HIGH', 'UNKNOWN'];

const LIQ_ALERT_MIN_TIER_RAW = requireEnv('LIQ_ALERT_MIN_TIER');
if (!LIQ_TIER_ORDER.includes(LIQ_ALERT_MIN_TIER_RAW)) {
  console.error(
    `[Config] LIQ_ALERT_MIN_TIER must be one of ${LIQ_TIER_ORDER.join(
      ', '
    )}, got "${LIQ_ALERT_MIN_TIER_RAW}"`
  );
  process.exit(1);
}
const LIQ_ALERT_MIN_TIER = LIQ_ALERT_MIN_TIER_RAW;

const REDEMP_ALERT_MIN_TIER_RAW = requireEnv('REDEMP_ALERT_MIN_TIER');
if (!REDEMP_TIER_ORDER.includes(REDEMP_ALERT_MIN_TIER_RAW)) {
  console.error(
    `[Config] REDEMP_ALERT_MIN_TIER must be one of ${REDEMP_TIER_ORDER.join(
      ', '
    )}, got "${REDEMP_ALERT_MIN_TIER_RAW}"`
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
  // 1) Try fetchPrice()
  try {
    const [price, isValid] = await priceFeedContract.fetchPrice();
    if (isValid && price && price.toString() !== '0') {
      return { rawPrice: price, source: 'fetchPrice()' };
    }
  } catch (_) {}

  // 2) Try lastGoodPrice()
  try {
    const last = await priceFeedContract.lastGoodPrice();
    if (last && last.toString() !== '0') {
      return { rawPrice: last, source: 'lastGoodPrice()' };
    }
  } catch (_) {}

  // 3) Try fetchRedemptionPrice()
  try {
    const [redPrice, isValidRed] =
      await priceFeedContract.fetchRedemptionPrice();
    if (isValidRed && redPrice && redPrice.toString() !== '0') {
      return { rawPrice: redPrice, source: 'fetchRedemptionPrice()' };
    }
  } catch (_) {}

  return { rawPrice: null, source: null };
}

// Reads a "global" reference interest rate (in percent) for a given protocol
// from the environment. For example, for protocol "ENOSYS_LOAN_FXRP":
//   GLOBAL_IR_ENOSYS_LOAN_FXRP=6.12  (meaning 6.12% p.a.)
function getGlobalInterestRatePct(protocol) {
  const key = `GLOBAL_IR_${protocol}`;
  const raw = process.env[key];
  if (!raw) return null;

  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  return v; // in percent, same unit as interestPct
}

// Classify IR vs global reference (for redemption priority heuristic).
// diff = interestPct - globalPct (in percentage points).
//
// Thresholds come from .env (no defaults):
//
//   REDEMP_BELOW_HIGH   => diff <= this  → tier HIGH
//   REDEMP_BELOW_MED    => diff <= this  → tier MEDIUM
//   REDEMP_NEUTRAL_ABS  => |diff| <= this → tier NEUTRAL
//
// Anything else → tier LOW (you are comfortably above global).
function classifyRedemptionTier(interestPct, globalPct) {
  if (globalPct == null) {
    return {
      tier: 'UNKNOWN',
      diffPct: null,
      diffLabel: 'no global IR configured',
    };
  }

  const diff = interestPct - globalPct; // positive => you're above global
  const absDiff = Math.abs(diff);

  const belowHigh = REDEMP_BELOW_HIGH;
  const belowMed = REDEMP_BELOW_MED;
  const neutralAbs = REDEMP_NEUTRAL_ABS;

  let tier;
  if (Number.isFinite(belowHigh) && diff <= belowHigh) {
    // Much lower than global => very high redemption priority
    tier = 'HIGH';
  } else if (Number.isFinite(belowMed) && diff <= belowMed) {
    // Slightly below global
    tier = 'MEDIUM';
  } else if (Number.isFinite(neutralAbs) && absDiff <= neutralAbs) {
    // Roughly in line with global
    tier = 'NEUTRAL';
  } else {
    // Clearly above global => lower redemption priority
    tier = 'LOW';
  }

  return {
    tier,
    diffPct: diff,
    diffLabel:
      (diff >= 0 ? '+' : '') + diff.toFixed(2) + ' pp vs global',
  };
}

// Classify liquidation risk based on how far current price is above the liquidation price.
// bufferFrac = (price - liquidationPrice) / price
//
// Thresholds come from .env as FRACTIONS:
//
//   LIQ_BUFFER_CRIT  => buffer <= this → CRITICAL
//   LIQ_BUFFER_HIGH  => buffer <= this → HIGH
//   LIQ_BUFFER_WARN  => buffer <= this → MEDIUM
//
// Above LIQ_BUFFER_WARN → LOW
function classifyLiquidationRisk(bufferFrac) {
  if (bufferFrac == null || !Number.isFinite(bufferFrac)) {
    return {
      tier: 'UNKNOWN',
      bufferFrac: null,
      bufferLabel: 'no buffer / no price',
    };
  }

  const warn = LIQ_BUFFER_WARN;
  const high = LIQ_BUFFER_HIGH;
  const crit = LIQ_BUFFER_CRIT;

  let tier;
  if (Number.isFinite(crit) && bufferFrac <= crit) {
    tier = 'CRITICAL';
  } else if (Number.isFinite(high) && bufferFrac <= high) {
    tier = 'HIGH';
  } else if (Number.isFinite(warn) && bufferFrac <= warn) {
    tier = 'MEDIUM';
  } else {
    tier = 'LOW';
  }

  const bufferPct = bufferFrac * 100;
  return {
    tier,
    bufferFrac,
    bufferLabel: `${bufferPct.toFixed(2)}% above liquidation`,
  };
}

// Reads CDP price (in USD) from the environment (ENV mode only)
function getCdpPriceFromEnv() {
  if (CDP_PRICE_MODE !== 'ENV') {
    return null;
  }
  return CDP_PRICE_USD_ENV; // already validated as a number
}

// On-chain CDP price from Enosys V3 CDP/USD₮0 pool on Flare (Uniswap v3).
async function getCdpPriceFromPool() {
  if (CDP_PRICE_MODE !== 'POOL') {
    return null;
  }

  const poolAddr = CDP_POOL_ADDR_FLR;

  let provider;
  try {
    provider = getProviderForChain('FLR', loanConfig.chains);
  } catch (err) {
    console.error(
      '[CDP] Failed to get FLR provider for CDP price:',
      err.message
    );
    return null;
  }

  const pool = new ethers.Contract(poolAddr, uniswapV3PoolAbi, provider);

  let token0, token1, slot0;
  try {
    [token0, token1, slot0] = await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.slot0(),
    ]);
  } catch (err) {
    console.error(
      '[CDP] Failed to read pool token0/token1/slot0:',
      err.message
    );
    return null;
  }

  const rawTick = slot0.tick !== undefined ? slot0.tick : slot0[1];
  const tick = Number(rawTick);
  if (!Number.isFinite(tick)) {
    console.error('[CDP] Invalid tick from pool slot0:', rawTick);
    return null;
  }

  // Fetch metadata to infer orientation + decimals
  const token0Contract = new ethers.Contract(
    token0,
    erc20MetadataAbi,
    provider
  );
  const token1Contract = new ethers.Contract(
    token1,
    erc20MetadataAbi,
    provider
  );

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
  } catch (_) {
    // fall back to defaults above
  }

  const sym0U = (sym0 || '').toUpperCase();
  const sym1U = (sym1 || '').toUpperCase();

  // Uniswap v3: price1/0 = 1.0001^tick * 10^(dec0 - dec1)
  const price1Over0NoDecimals = Math.pow(1.0001, tick);
  const decimalFactor = Math.pow(10, Number(dec0) - Number(dec1));
  const price1Over0 = price1Over0NoDecimals * decimalFactor;

  let priceCdpUsdT0 = null;

  if (sym0U.includes('CDP')) {
    // token0 = CDP, token1 = USD₮0 → price1Over0 = USD₮0 per CDP
    priceCdpUsdT0 = price1Over0;
  } else if (sym1U.includes('CDP')) {
    // token1 = CDP, token0 = USD₮0 → price1Over0 = CDP per USD₮0, so invert
    if (price1Over0 === 0) {
      console.error('[CDP] price1Over0 is zero; cannot invert.');
      return null;
    }
    priceCdpUsdT0 = 1 / price1Over0;
  } else {
    console.error(
      `[CDP] Could not identify CDP token by symbol (token0=${sym0}, token1=${sym1}).`
    );
    return null;
  }

  if (!Number.isFinite(priceCdpUsdT0) || priceCdpUsdT0 <= 0) {
    console.error(
      '[CDP] Computed non-finite/negative CDP price:',
      priceCdpUsdT0
    );
    return null;
  }

  return priceCdpUsdT0;
}

// Wrapper: choose source (POOL or ENV).
async function getCdpPrice() {
  if (CDP_PRICE_MODE === 'ENV') {
    return getCdpPriceFromEnv();
  }
  if (CDP_PRICE_MODE === 'POOL') {
    return getCdpPriceFromPool();
  }
  // Should not happen due to validation
  return null;
}

// Classify whether redemption is "economically live" based on CDP price.
// If CDP < trigger, redemptions become attractive.
function classifyCdpRedemptionState(cdpPrice) {
  const trigger = CDP_REDEMPTION_TRIGGER;

  if (cdpPrice == null) {
    return {
      state: 'UNKNOWN',
      trigger,
      diff: null,
      label: 'no CDP price available',
    };
  }

  const diff = cdpPrice - trigger;
  let state;

  if (cdpPrice < trigger) {
    state = 'ACTIVE'; // profitable / attractive for arbitrage
  } else {
    state = 'DORMANT'; // not profitable; redemptions unlikely
  }

  const label =
    diff >= 0
      ? `above trigger by ${diff.toFixed(4)}`
      : `below trigger by ${Math.abs(diff).toFixed(4)}`;

  return {
    state, // ACTIVE / DORMANT / UNKNOWN
    trigger, // threshold used
    diff, // raw difference
    label, // human string
  };
}

// -----------------------------
// Build a single loan summary object (no logging)
// -----------------------------

async function summarizeLoanPosition(provider, chainId, protocol, row) {
  const { contract, owner, troveId } = row;

  const troveNFT = new ethers.Contract(contract, troveNftAbi, provider);

  const troveManagerAddr = await troveNFT.troveManager();
  const collTokenAddr = await troveNFT.collToken();

  const troveManager = new ethers.Contract(
    troveManagerAddr,
    troveManagerAbi,
    provider
  );
  const collToken = new ethers.Contract(
    collTokenAddr,
    erc20MetadataAbi,
    provider
  );

  const collDecimals = await collToken.decimals();
  const collSymbol = await collToken.symbol();

  const latest = await troveManager.getLatestTroveData(troveId);
  const statusCode = await troveManager.getTroveStatus(troveId);

  const entireDebt = latest.entireDebt;
  const entireColl = latest.entireColl;
  const accruedInterest = latest.accruedInterest;
  const annualInterestRate = latest.annualInterestRate;

  const DEBT_DECIMALS = 18;
  const PRICE_DECIMALS = 18;

  const debtNorm = Number(ethers.formatUnits(entireDebt, DEBT_DECIMALS));
  const collNorm = Number(ethers.formatUnits(entireColl, collDecimals));
  const accruedInterestNorm = Number(
    ethers.formatUnits(accruedInterest, DEBT_DECIMALS)
  );
  const interestPct =
    Number(ethers.formatUnits(annualInterestRate, 18)) * 100.0;
  const statusStr = troveStatusToString(statusCode);

  // Redemption-related (IR-based) against an .env "global" reference
  const globalIrPct = getGlobalInterestRatePct(protocol);
  const redClass = classifyRedemptionTier(interestPct, globalIrPct);

  // Price + risk metrics
  const priceFeedAddr = await troveManager.priceFeed();
  const priceFeed = new ethers.Contract(priceFeedAddr, priceFeedAbi, provider);

  const { rawPrice, source } = await getOraclePrice(priceFeed);

  // Base summary object
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

    // Interest rate (borrow cost)
    interestPct, // your trove's interest %
    globalIrPct, // pulled from .env via getGlobalInterestRatePct()
    redemptionTier: redClass.tier, // LOW / MEDIUM / HIGH / UNKNOWN
    redemptionDiffPct: redClass.diffPct, // how far you are from global IR

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

  if (!rawPrice) {
    // No price => can't compute LTV / liquidation
    return base;
  }

  const priceNorm = Number(ethers.formatUnits(rawPrice, PRICE_DECIMALS));
  const MCR = await troveManager.MCR();
  const mcrNorm = Number(ethers.formatUnits(MCR, 18));

  const collValue = collNorm * priceNorm;
  const ltv = collValue > 0 ? debtNorm / collValue : 0;
  const liquidationPrice =
    collNorm > 0 ? (debtNorm * mcrNorm) / collNorm : 0;

  let icrRaw;
  try {
    icrRaw = await troveManager.getCurrentICR(troveId, rawPrice);
  } catch {
    icrRaw = null;
  }
  const icrNorm =
    icrRaw != null ? Number(ethers.formatUnits(icrRaw, 18)) : null;

  const bufferFrac =
    priceNorm > 0 ? (priceNorm - liquidationPrice) / priceNorm : null;
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

async function describeLoanPosition(
  provider,
  chainId,
  protocol,
  row,
  options = {}
) {
  const {
    verbose = MONITOR_VERBOSE_DEFAULT,
    cdpState = null,
  } = options;
  const { contract, owner, troveId } = row;

  if (verbose) {
    console.log('========================================');
    console.log(`LOAN POSITION (${protocol})`);
    console.log('----------------------------------------');
    console.log(`Owner:    ${owner}`);
    console.log(`Chain:    ${chainId}`);
    console.log(`NFT:      ${contract}`);
    console.log(`Trove ID: ${troveId}`);
  }

  const troveNFT = new ethers.Contract(contract, troveNftAbi, provider);

  const troveManagerAddr = await troveNFT.troveManager();
  const collTokenAddr = await troveNFT.collToken();

  if (verbose) {
    console.log(`TroveManager:  ${troveManagerAddr}`);
    console.log(`Collateral:    ${collTokenAddr}`);
  }

  const troveManager = new ethers.Contract(
    troveManagerAddr,
    troveManagerAbi,
    provider
  );
  const collToken = new ethers.Contract(
    collTokenAddr,
    erc20MetadataAbi,
    provider
  );

  const collDecimals = await collToken.decimals();
  const collSymbol = await collToken.symbol();

  const latest = await troveManager.getLatestTroveData(troveId);
  const statusCode = await troveManager.getTroveStatus(troveId);

  const entireDebt = latest.entireDebt;
  const entireColl = latest.entireColl;
  const accruedInterest = latest.accruedInterest;
  const annualInterestRate = latest.annualInterestRate;

  const DEBT_DECIMALS = 18;
  const PRICE_DECIMALS = 18;

  const debtNorm = Number(ethers.formatUnits(entireDebt, DEBT_DECIMALS));
  const collNorm = Number(ethers.formatUnits(entireColl, collDecimals));
  const accruedInterestNorm = Number(
    ethers.formatUnits(accruedInterest, DEBT_DECIMALS)
  );
  const interestPct =
    Number(ethers.formatUnits(annualInterestRate, 18)) * 100.0;
  const statusStr = troveStatusToString(statusCode);

  // --- Redemption-related metrics (based on IR vs a global reference) ---
  const globalIrPct = getGlobalInterestRatePct(protocol);
  const redClass = classifyRedemptionTier(interestPct, globalIrPct);

  if (verbose) {
    console.log('');
    console.log('  --- Core Trove Data ---');
    console.log(`  Collateral:        ${collNorm.toFixed(6)} ${collSymbol}`);
    console.log(`  Debt (entire):     ${debtNorm.toFixed(6)} (loan token)`);
    console.log(`  Accrued interest:  ${accruedInterestNorm.toFixed(6)}`);
    console.log(`  Annual rate:       ${interestPct.toFixed(2)}%`);
    console.log(`  Status:            ${statusStr}`);
  }

  // Price feed + risk metrics
  const priceFeedAddr = await troveManager.priceFeed();
  if (verbose) {
    console.log('');
    console.log(`  PriceFeed:         ${priceFeedAddr}`);
  }

  const priceFeed = new ethers.Contract(priceFeedAddr, priceFeedAbi, provider);

  const { rawPrice, source } = await getOraclePrice(priceFeed);

  if (verbose) {
    console.log('');
    console.log('  --- Risk Metrics ---');
  }

  if (!rawPrice) {
    if (verbose) {
      console.log(
        '  ⚠️  No price available; cannot compute LTV/liquidation price.'
      );
      console.log('========================================');
      console.log('');
    }
    // Summary log even if we have no price
    console.log(
      `${protocol} is ${statusStr} but no price is available to compute LTV / liquidation price.`
    );
    return;
  }

  const priceNorm = Number(ethers.formatUnits(rawPrice, PRICE_DECIMALS));

  if (verbose) {
    console.log(`  Price source:      ${source}`);
    console.log(`  Raw price:         ${rawPrice.toString()}`);
    console.log(`  Price (normalized):${priceNorm}`);
  }

  const MCR = await troveManager.MCR();
  const mcrNorm = Number(ethers.formatUnits(MCR, 18)); // ~1.1 etc.

  // Collateral value and LTV
  const collValue = collNorm * priceNorm; // in "price units"
  const ltv = collValue > 0 ? debtNorm / collValue : 0;

  const liquidationPrice =
    collNorm > 0 ? (debtNorm * mcrNorm) / collNorm : 0;

  const bufferFrac =
    priceNorm > 0 ? (priceNorm - liquidationPrice) / priceNorm : null;

  const liqClass = classifyLiquidationRisk(bufferFrac);

  let icrRaw;
  try {
    icrRaw = await troveManager.getCurrentICR(troveId, rawPrice);
  } catch {
    icrRaw = null;
  }
  const icrNorm =
    icrRaw != null ? Number(ethers.formatUnits(icrRaw, 18)) : null;

  if (verbose) {
    console.log(`  Collateral value:  ${collValue.toFixed(6)} (price units)`);
    console.log(`  MCR (approx):      ${(mcrNorm * 100).toFixed(2)} %`);
    if (icrNorm != null) {
      console.log(`  Current ICR:       ${(icrNorm * 100).toFixed(2)} %`);
    } else {
      console.log('  Current ICR:       (could not fetch)');
    }
    console.log(`  LTV (approx):      ${(ltv * 100).toFixed(2)} %`);
    console.log(
      `  Liquidation price: ${liquidationPrice.toFixed(
        8
      )} (same units as price)`
    );

    console.log('');
    console.log('  --- Redemption Profile (IR-based) ---');
    console.log(`  Interest rate:     ${interestPct.toFixed(2)} % p.a.`);
    if (globalIrPct != null) {
      console.log(`  Global IR (env):   ${globalIrPct.toFixed(2)} % p.a.`);
      console.log(`  Delta:             ${redClass.diffLabel}`);
      console.log(
        `  Est. tier:         ${redClass.tier} redemption priority`
      );
    } else {
      console.log(
        '  Global IR (env):   not set (GLOBAL_IR_' + protocol + ' not found)'
      );
    }

    console.log('');
    console.log('  --- Liquidation Profile ---');
    console.log(`  Price:            ${priceNorm.toFixed(5)}`);
    console.log(`  Liq. price:       ${liquidationPrice.toFixed(5)}`);
    if (bufferFrac != null) {
      const bufferPct = bufferFrac * 100;
      console.log(`  Buffer:           ${bufferPct.toFixed(2)}% above liq.`);
      console.log(`  Liq. tier:        ${liqClass.tier}`);
    } else {
      console.log('  Buffer:           (not available)');
    }

    console.log('========================================');
    console.log('');
  }

  // === Compact summary log ===
  const ltvPct = ltv * 100;
  console.log(
    `${protocol} is ${statusStr} with LTV of ${ltvPct.toFixed(
      2
    )}%. Current price ${priceNorm.toFixed(
      5
    )} with liquidation price ${liquidationPrice.toFixed(5)}.`
  );

  // -----------------------------
  // Alert engine hooks
  // -----------------------------

  // Liquidation alert (based on liq tier)
  const liqAlertActive = isTierAtLeast(
    liqClass.tier,
    LIQ_ALERT_MIN_TIER,
    LIQ_TIER_ORDER
  );

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

  // Redemption alert (IR tier + CDP ACTIVE)
  const cdpIsActive = cdpState && cdpState.state === 'ACTIVE';

  const redAlertActive =
    cdpIsActive &&
    isTierAtLeast(
      redClass.tier,
      REDEMP_ALERT_MIN_TIER,
      REDEMP_TIER_ORDER
    );

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
        `${protocol} liquidation buffer ${(
          bufferFrac * 100
        ).toFixed(2)}% (tier ${liqClass.tier}).`
      );
    } else {
      console.log(
        `${protocol} liquidation buffer unknown (no price / liq data).`
      );
    }

    if (globalIrPct != null) {
      console.log(
        `${protocol} IR ${interestPct.toFixed(
          2
        )}% vs global ${globalIrPct.toFixed(
          2
        )}% (${redClass.diffLabel}, tier ${redClass.tier}).`
      );
    } else {
      console.log(
        `${protocol} IR ${interestPct.toFixed(
          2
        )}% (no GLOBAL_IR_${protocol} set).`
      );
    }
  }
}

// -----------------------------
// Public API: monitorLoans
// -----------------------------

async function monitorLoans(options = {}) {
  const verbose = options.verbose ?? MONITOR_VERBOSE_DEFAULT;

  const cdpPrice = await getCdpPrice();
  const cdpState = classifyCdpRedemptionState(cdpPrice);

  if (verbose) {
    console.log('');
    console.log('=== CDP Redemption Context ===');
    if (cdpPrice == null) {
      console.log('  CDP price:        (not available)');
      console.log(
        `  Trigger:          ${cdpState.trigger.toFixed(
          4
        )} USD (CDP_REDEMPTION_TRIGGER)`
      );
      console.log('  State:            UNKNOWN (no CDP price available)');
    } else {
      console.log(`  CDP price:        ${cdpPrice.toFixed(4)} USD`);
      console.log(
        `  Trigger:          ${cdpState.trigger.toFixed(
          4
        )} USD (CDP_REDEMPTION_TRIGGER)`
      );
      console.log(
        `  State:            ${cdpState.state} (${cdpState.label})`
      );
    }
    console.log('==============================');
    console.log('');
  } else {
    // Compact, single-line version for normal runs
    if (cdpPrice == null) {
      console.log(
        `CDP price unknown; redemption state UNKNOWN (trigger ${cdpState.trigger.toFixed(
          4
        )}).`
      );
    } else {
      console.log(
        `CDP price ${cdpPrice.toFixed(
          4
        )} USD; redemption state ${cdpState.state} (trigger ${cdpState.trigger.toFixed(
          4
        )}, ${cdpState.label}).`
      );
    }
  }

  console.log(''); // keep a small spacer before the per-loan logs

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

        if (chain !== chainId) {
          continue;
        }

        try {
          await describeLoanPosition(
            provider,
            chainId,
            c.protocol || c.key || 'UNKNOWN_PROTOCOL',
            row,
            { verbose, cdpState }
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

// Return structured summaries for all monitored loans (no logging)
async function getLoanSummaries() {
  const summaries = [];

  for (const [chainId, chainCfg] of Object.entries(loanConfig.chains || {})) {
    let provider;
    try {
      provider = getProviderForChain(chainId, loanConfig.chains);
    } catch (err) {
      console.error(
        `[Loans] Skipping chain ${chainId} in getLoanSummaries: ${err.message}`
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
        const troveId = row.troveId;

        if (!chain || !owner || !contract || !troveId) {
          console.log('  Skipping loan row with missing fields:', row);
          continue;
        }

        if (chain !== chainId) {
          continue;
        }

        const protocol = c.protocol || c.key || 'UNKNOWN_PROTOCOL';

        try {
          const summary = await summarizeLoanPosition(
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
            `[Loans] Failed to build summary for troveId=${troveId} on ${chainId}:`,
            err.message
          );
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

