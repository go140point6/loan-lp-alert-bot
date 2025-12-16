require("dotenv").config({ quiet: true });
require("log-timestamp");

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { ethers } = require("ethers");

// -----------------------------
// Load ABIs
// -----------------------------

const troveNftAbi = require("./abi/troveNFT.json");
const troveManagerAbi = require("./abi/troveManager.json");
const priceFeedAbi = require("./abi/priceFeed.json");
const erc20MetadataAbi = require("./abi/erc20Metadata.json");

const positionManagerAbi = require("./abi/positionManager.json");     // has factory()
const uniswapV3FactoryAbi = require("./abi/uniswapV3Factory.json");
const uniswapV3PoolAbi = require("./abi/uniswapV3Pool.json");

// -----------------------------
// Load configs
// -----------------------------

const loanConfig = require("./data/loan_contracts.json");
const lpConfig = require("./data/lp_contracts.json");

// -----------------------------
// Helpers
// -----------------------------

function getProviderForChain(chainId, chainsConfig) {
  const chainCfg = chainsConfig[chainId];
  if (!chainCfg) {
    throw new Error(`No config for chain ${chainId}`);
  }

  const rpcKey = chainCfg.rpcEnvKey;
  const rpcUrl = process.env[rpcKey];
  if (!rpcUrl) {
    throw new Error(
      `Missing RPC URL in .env for chain ${chainId}: expected ${rpcKey}`
    );
  }

  return new ethers.JsonRpcProvider(rpcUrl);
}

function readCsvRows(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.warn(`[WARN] CSV file not found: ${csvPath}`);
    return [];
  }

  const content = fs.readFileSync(csvPath, "utf8");
  if (!content.trim()) {
    return [];
  }

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return records;
}

function troveStatusToString(code) {
  const n = Number(code);
  switch (n) {
    case 1:
      return "ACTIVE";
    case 2:
      return "CLOSED_BY_OWNER";
    case 3:
      return "CLOSED_BY_LIQUIDATION";
    case 4:
      return "CLOSED_BY_REDEMPTION";
    default:
      return `UNKNOWN(${n})`;
  }
}

// price helper for loans (same logic we used in the standalone test script)
async function getOraclePrice(priceFeedContract) {
  // 1) Try fetchPrice()
  try {
    const [price, isValid] = await priceFeedContract.fetchPrice();
    if (isValid && price && price.toString() !== "0") {
      return { rawPrice: price, source: "fetchPrice()" };
    }
  } catch (_) {}

  // 2) Try lastGoodPrice()
  try {
    const last = await priceFeedContract.lastGoodPrice();
    if (last && last.toString() !== "0") {
      return { rawPrice: last, source: "lastGoodPrice()" };
    }
  } catch (_) {}

  // 3) Try fetchRedemptionPrice()
  try {
    const [redPrice, isValidRed] =
      await priceFeedContract.fetchRedemptionPrice();
    if (isValidRed && redPrice && redPrice.toString() !== "0") {
      return { rawPrice: redPrice, source: "fetchRedemptionPrice()" };
    }
  } catch (_) {}

  return { rawPrice: null, source: null };
}

// -----------------------------
// Loan Monitoring
// -----------------------------

async function describeLoanPosition(provider, chainId, protocol, row) {
  const { contract, owner, troveId } = row;

  console.log("========================================");
  console.log(`LOAN POSITION (${protocol})`);
  console.log("----------------------------------------");
  console.log(`Owner:    ${owner}`);
  console.log(`Chain:    ${chainId}`);
  console.log(`NFT:      ${contract}`);
  console.log(`Trove ID: ${troveId}`);

  const troveNFT = new ethers.Contract(contract, troveNftAbi, provider);

  const troveManagerAddr = await troveNFT.troveManager();
  const collTokenAddr = await troveNFT.collToken();

  console.log(`TroveManager:  ${troveManagerAddr}`);
  console.log(`Collateral:    ${collTokenAddr}`);

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

  console.log("");
  console.log("  --- Core Trove Data ---");
  console.log(`  Collateral:        ${collNorm.toFixed(6)} ${collSymbol}`);
  console.log(
    `  Debt (entire):     ${debtNorm.toFixed(6)} (loan token)`
  );
  console.log(
    `  Accrued interest:  ${accruedInterestNorm.toFixed(6)}`
  );
  console.log(`  Annual rate:       ${interestPct.toFixed(2)}%`);
  console.log(`  Status:            ${statusStr}`);

  // Price feed + risk metrics
  const priceFeedAddr = await troveManager.priceFeed();
  console.log("");
  console.log(`  PriceFeed:         ${priceFeedAddr}`);

  const priceFeed = new ethers.Contract(
    priceFeedAddr,
    priceFeedAbi,
    provider
  );

  const { rawPrice, source } = await getOraclePrice(priceFeed);

  console.log("");
  console.log("  --- Risk Metrics ---");

  if (!rawPrice) {
    console.log("  ⚠️  No price available; cannot compute LTV/liquidation price.");
    console.log("========================================");
    console.log("");
    return;
  }

  const priceNorm = Number(ethers.formatUnits(rawPrice, PRICE_DECIMALS));
  console.log(`  Price source:      ${source}`);
  console.log(`  Raw price:         ${rawPrice.toString()}`);
  console.log(`  Price (normalized):${priceNorm}`);

  const MCR = await troveManager.MCR();
  const mcrNorm = Number(ethers.formatUnits(MCR, 18)); // ~1.1 etc.

  // Collateral value and LTV
  const collValue = collNorm * priceNorm; // in "price units" (e.g. USD-ish)
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

  console.log(
    `  Collateral value:  ${collValue.toFixed(6)} (price units)`
  );
  console.log(
    `  MCR (approx):      ${(mcrNorm * 100).toFixed(2)} %`
  );
  if (icrNorm != null) {
    console.log(
      `  Current ICR:       ${(icrNorm * 100).toFixed(2)} %`
    );
  } else {
    console.log("  Current ICR:       (could not fetch)");
  }
  console.log(
    `  LTV (approx):      ${(ltv * 100).toFixed(2)} %`
  );
  console.log(
    `  Liquidation price: ${liquidationPrice.toFixed(
      8
    )} (same units as price)`
  );

  console.log("========================================");
  console.log("");
}

async function monitorLoans() {
  console.log("");
  for (const [chainId, chainCfg] of Object.entries(loanConfig.chains || {})) {
    let provider;
    try {
      provider = getProviderForChain(chainId, loanConfig.chains);
    } catch (err) {
      console.error(`[Loans] Skipping chain ${chainId}: ${err.message}`);
      continue;
    }

    for (const c of chainCfg.contracts || []) {
      const csvPath = path.join(__dirname, "data", c.csvFile);
      console.log(
        `--- Processing loan positions from ${csvPath} ---`
      );

      const rows = readCsvRows(csvPath);
      for (const row of rows) {
        const chain = (row.chain || "").toUpperCase();
        const owner = row.owner;
        const contract = row.contract;
        const troveId = row.troveId;

        if (!chain || !owner || !contract || !troveId) {
          console.log(
            "  Skipping loan row with missing fields:",
            row
          );
          continue;
        }

        if (chain !== chainId) {
          continue;
        }

        try {
          await describeLoanPosition(
            provider,
            chainId,
            c.protocol || c.key || "UNKNOWN_PROTOCOL",
            row
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
// LP Monitoring (dynamic factory)
// -----------------------------

async function describeLPPosition(provider, chainId, protocol, row) {
  const { contract, owner, tokenId } = row;
  const tokenIdBN = BigInt(tokenId);

  const pm = new ethers.Contract(contract, positionManagerAbi, provider);
  const pos = await pm.positions(tokenIdBN);

  const liquidity = BigInt(pos.liquidity.toString());

  // Ignore inactive LPs (liquidity == 0)
  if (liquidity === 0n) {
    return;
  }

  const token0 = pos.token0;
  const token1 = pos.token1;
  const fee = Number(pos.fee);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);

  console.log("========================================");
  console.log(`LP POSITION (${protocol})`);
  console.log("----------------------------------------");
  console.log(`Owner:    ${owner}`);
  console.log(`Chain:    ${chainId}`);
  console.log(`NFT:      ${contract}`);
  console.log(`tokenId:  ${tokenId}`);
  console.log("");
  console.log("  --- Basic Position Data ---");
  console.log(`  token0:        ${token0}`);
  console.log(`  token1:        ${token1}`);
  console.log(`  fee:           ${fee}`);
  console.log(`  tickLower:     ${tickLower}`);
  console.log(`  tickUpper:     ${tickUpper}`);
  console.log(`  liquidity:     ${liquidity.toString()}`);
  console.log(`  status:        ACTIVE`);

  // --- Dynamic factory detection + range status ---
  let rangeStatus = "(not computed)";
  let poolAddr = null;
  let currentTick = null;

  try {
    // 1) Ask the positionManager for its factory()
    const factoryAddr = await pm.factory();

    if (factoryAddr && factoryAddr !== ethers.ZeroAddress) {
      const factory = new ethers.Contract(
        factoryAddr,
        uniswapV3FactoryAbi,
        provider
      );

      // 2) Get the pool for (token0, token1, fee)
      poolAddr = await factory.getPool(token0, token1, fee);

      if (poolAddr && poolAddr !== ethers.ZeroAddress) {
        const pool = new ethers.Contract(
          poolAddr,
          uniswapV3PoolAbi,
          provider
        );

        const slot0 = await pool.slot0();

        // slot0.tick may be named or indexed depending on ABI file
        const tick =
          slot0.tick !== undefined ? slot0.tick : slot0[1];

        currentTick = Number(tick);

        if (
          currentTick >= tickLower &&
          currentTick < tickUpper
        ) {
          rangeStatus = "IN RANGE";
        } else {
          rangeStatus = "OUT OF RANGE";
        }
      }
    }
  } catch (err) {
    console.error(
      `  Could not compute range for LP token ${tokenId} (${protocol}):`,
      err.message
    );
  }

  if (poolAddr && currentTick != null) {
    console.log("");
    console.log("  --- Range Status ---");
    console.log(`  pool:          ${poolAddr}`);
    console.log(`  currentTick:   ${currentTick}`);
    console.log(`  range:         ${rangeStatus}`);
  } else {
    console.log("");
    console.log("  --- Range Status ---");
    console.log(`  range:         ${rangeStatus}`);
  }

  console.log("========================================");
  console.log("");
}

async function monitorLPs() {
  console.log("");
  for (const [chainId, chainCfg] of Object.entries(lpConfig.chains || {})) {
    let provider;
    try {
      provider = getProviderForChain(chainId, lpConfig.chains);
    } catch (err) {
      console.error(`[LP] Skipping chain ${chainId}: ${err.message}`);
      continue;
    }

    for (const c of chainCfg.contracts || []) {
      const csvPath = path.join(__dirname, "data", c.csvFile);
      console.log(
        `--- Processing LP positions from ${csvPath} (${c.protocol || c.key}) ---`
      );

      const rows = readCsvRows(csvPath);
      for (const row of rows) {
        const chain = (row.chain || "").toUpperCase();
        const owner = row.owner;
        const contract = row.contract;
        const tokenId = row.tokenId;

        if (!chain || !owner || !contract || !tokenId) {
          console.log(
            "  Skipping LP row with missing fields:",
            row
          );
          continue;
        }

        if (chain !== chainId) {
          continue;
        }

        try {
          await describeLPPosition(
            provider,
            chainId,
            c.protocol || c.key || "UNKNOWN_PROTOCOL",
            row
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

// -----------------------------
// Main
// -----------------------------

async function main() {
  console.log("Starting monitor index.js ...");

  await monitorLoans();
  await monitorLPs();

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error in index.js:", err);
});
