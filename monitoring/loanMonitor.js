const path = require('path');
const { ethers } = require('ethers');

const troveNftAbi = require('../abi/troveNFT.json');
const troveManagerAbi = require('../abi/troveManager.json');
const priceFeedAbi = require('../abi/priceFeed.json');
const erc20MetadataAbi = require('../abi/erc20Metadata.json');

const loanConfig = require('../data/loan_contracts.json');

const { getProviderForChain } = require('../utils/providers');
const { readCsvRows } = require('../utils/csv');

// -----------------------------
// Helpers
// -----------------------------

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

// -----------------------------
// Core loan description
// -----------------------------

async function describeLoanPosition(provider, chainId, protocol, row, options = {}) {
  const { verbose = process.env.MONITOR_VERBOSE === '1' } = options;
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
      console.log('  ⚠️  No price available; cannot compute LTV/liquidation price.');
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
}

// -----------------------------
// Public API: monitorLoans
// -----------------------------

async function monitorLoans(options = {}) {
  const verbose = options.verbose ?? (process.env.MONITOR_VERBOSE === '1');

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
            { verbose }
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

module.exports = {
  monitorLoans,
};
