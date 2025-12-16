const path = require('path');
const { ethers } = require('ethers');

const positionManagerAbi = require('../abi/positionManager.json');
const uniswapV3FactoryAbi = require('../abi/uniswapV3Factory.json');
const uniswapV3PoolAbi = require('../abi/uniswapV3Pool.json');
const erc20MetadataAbi = require('../abi/erc20Metadata.json');

const lpConfig = require('../data/lp_contracts.json');
const lpIgnoreConfig = require('../data/lp_ignore.json'); // <-- NEW

const { getProviderForChain } = require('../utils/providers');
const { readCsvRows } = require('../utils/csv');

// Simple in-memory cache for token symbols to avoid repeated RPC calls
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
// Core LP description
// -----------------------------

async function describeLPPosition(provider, chainId, protocol, row, options = {}) {
  const { verbose = process.env.MONITOR_VERBOSE === '1' } = options;
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

  if (verbose) {
    console.log('');
    console.log('  --- Range Status ---');
    if (poolAddr && currentTick != null) {
      console.log(`  pool:          ${poolAddr}`);
      console.log(`  currentTick:   ${currentTick}`);
    }
    console.log(`  range:         ${rangeStatus}`);
    console.log('========================================');
    console.log('');
  }

  // === Compact summary log ===
  const humanRange =
    rangeStatus === '(not computed)' ? 'with unknown range' : `and ${rangeStatus}`;
  console.log(
    `${protocol} ${pairLabel || 'UNKNOWN_PAIR'} is ACTIVE ${humanRange}.`
  );
}

// -----------------------------
// Public API: monitorLPs
// -----------------------------

async function monitorLPs(options = {}) {
  const verbose = options.verbose ?? (process.env.MONITOR_VERBOSE === '1');

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
          await describeLPPosition(
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
};
