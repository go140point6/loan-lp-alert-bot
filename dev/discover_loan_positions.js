const path = require("path");

// Always load .env from project root, even when script is inside /dev/
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});
require("log-timestamp");

const fs = require("fs");
const { parse } = require("csv-parse");
const { ethers } = require("ethers");

// ========= PATHS =========

const ADDRESSES_CSV = path.join(__dirname, "..", "data", "addresses.csv");
const LOAN_CONFIG_PATH = path.join(
  __dirname,
  "..",
  "data",
  "loan_contracts.json"
);
const LOAN_STATE_PATH = path.join(
  __dirname,
  "..",
  "data",
  "loan_scan_state.json"
);

// Max block window for eth_getLogs (Ankr limit)
const MAX_LOG_RANGE_BLOCKS = 1000;

// Minimal ABI: only need ownerOf for confirmation
const ERC721_MIN_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
];

// Transfer event topic for ERC721
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// ========= HELPERS: CONFIG & CSV =========

function loadLoanConfig() {
  if (!fs.existsSync(LOAN_CONFIG_PATH)) {
    console.error(
      "Missing loan contract config:",
      LOAN_CONFIG_PATH,
      "\nCreate it with your loan NFT contracts (e.g. Enosys TroveNFT)."
    );
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(LOAN_CONFIG_PATH, "utf8");
    const config = JSON.parse(raw);

    if (!config.chains || typeof config.chains !== "object") {
      throw new Error("loan_contracts.json must have a 'chains' object");
    }

    return config;
  } catch (err) {
    console.error("Error reading/parsing loan_contracts.json:", err.message);
    process.exit(1);
  }
}

function loadAddressesCsv(filePath) {
  return new Promise((resolve, reject) => {
    const result = [];

    fs.createReadStream(filePath)
      .pipe(parse({ delimiter: ",", from_line: 1 }))
      .on("data", (row) => {
        const [addressRaw, chainRaw] = row;
        if (!addressRaw || !chainRaw) return;

        const address = addressRaw.trim();
        const chain = chainRaw.trim().toUpperCase();

        if (!ethers.isAddress(address)) {
          console.warn(`Skipping invalid address in CSV: ${addressRaw}`);
          return;
        }

        result.push({ address, chain });
      })
      .on("end", () => resolve(result))
      .on("error", (err) => reject(err));
  });
}

/**
 * Append rows to a per-source loans CSV, creating it with a header if it doesn't exist.
 * Rows are { chain, protocol, contract, owner, troveId }.
 */
function appendLoansCsv(outputPath, rows) {
  if (!rows || rows.length === 0) {
    console.log(`No new rows for ${outputPath}, skipping append.`);
    return;
  }

  const header = "chain,protocol,contract,owner,troveId\n";
  const body =
    rows
      .map(
        (r) =>
          `${r.chain},${r.protocol},${r.contract},${r.owner},${r.troveId}`
      )
      .join("\n") + "\n";

  const exists = fs.existsSync(outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (!exists) {
    fs.writeFileSync(outputPath, header + body, "utf8");
  } else {
    fs.appendFileSync(outputPath, body, "utf8");
  }
}

// ========= LOAN STATE HELPERS =========

function loadLoanState() {
  if (!fs.existsSync(LOAN_STATE_PATH)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(LOAN_STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(
      "Error reading loan_scan_state.json, starting fresh:",
      err.message
    );
    return {};
  }
}

function saveLoanState(state) {
  fs.mkdirSync(path.dirname(LOAN_STATE_PATH), { recursive: true });
  fs.writeFileSync(LOAN_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Get startBlock for a given chain+protocol.
 * Priority:
 *   1. loan_scan_state.json: chain.protocol.lastScannedBlock
 *   2. env var: envStartKey
 *   3. 0
 */
function getStartBlock(loanState, chain, protocol, envStartKey) {
  const chainState = loanState[chain];
  if (
    chainState &&
    chainState[protocol] &&
    typeof chainState[protocol].lastScannedBlock === "number"
  ) {
    return chainState[protocol].lastScannedBlock;
  }

  if (envStartKey && process.env[envStartKey]) {
    return Number(process.env[envStartKey]);
  }

  return 0;
}

/**
 * Update loanState with new lastScannedBlock for chain+protocol.
 */
function setLastScannedBlock(loanState, chain, protocol, blockNumber) {
  if (!loanState[chain]) {
    loanState[chain] = {};
  }
  loanState[chain][protocol] = {
    lastScannedBlock: blockNumber,
  };
}

// ========= LOG SCAN HELPERS =========

function topicForAddress(addr) {
  return ethers.zeroPadValue(addr, 32);
}

/**
 * Scan ERC721 Transfer logs for tokenIds that were ever sent TO `owner`
 * between `startBlock` and `latestBlock`, in chunks of MAX_LOG_RANGE_BLOCKS.
 * Then confirm which ones are still owned via ownerOf().
 *
 * Returns: array of troveId strings currently owned by `owner`.
 */
async function discoverTroveIdsForOwner({
  provider,
  nftAddress,
  owner,
  startBlock,
  latestBlock,
}) {
  const ownerTopic = topicForAddress(owner);
  const normalizedOwner = ethers.getAddress(owner);
  const candidateTroveIds = new Set();

  const ownerOfContract = new ethers.Contract(
    nftAddress,
    ERC721_MIN_ABI,
    provider
  );

  if (startBlock == null || startBlock < 0) startBlock = 0;
  if (startBlock > latestBlock) {
    console.log(
      `  [${nftAddress}] startBlock ${startBlock} > latestBlock ${latestBlock}, skipping ${owner}`
    );
    return [];
  }

  console.log(
    `  [${nftAddress}] discovering troves for owner ${owner}, blocks ${startBlock} -> ${latestBlock} (step ${MAX_LOG_RANGE_BLOCKS})`
  );

  for (
    let fromBlock = startBlock;
    fromBlock <= latestBlock;
    fromBlock += MAX_LOG_RANGE_BLOCKS + 1
  ) {
    const toBlock = Math.min(fromBlock + MAX_LOG_RANGE_BLOCKS, latestBlock);

    console.log(
      `    scanning blocks ${fromBlock} -> ${toBlock} for owner ${owner}`
    );

    try {
      const logsIn = await provider.getLogs({
        address: nftAddress,
        fromBlock,
        toBlock,
        topics: [TRANSFER_TOPIC, null, ownerTopic], // Transfer(from, to, tokenId) where to == owner
      });

      for (const log of logsIn) {
        if (log.topics.length < 4) continue;
        const tokenIdHex = log.topics[3];
        const troveId = BigInt(tokenIdHex).toString();

        if (!candidateTroveIds.has(troveId)) {
          console.log(
            `      ↳ Found candidate troveId ${troveId} in Transfer log (to ${owner})`
          );
        }

        candidateTroveIds.add(troveId);
      }
    } catch (err) {
      console.error(
        `      getLogs error for ${nftAddress} [${fromBlock}–${toBlock}] owner ${owner}: ${err.message}`
      );
    }
  }

  // Confirm current ownership (open loans)
  const ownedNow = [];
  for (const troveId of candidateTroveIds) {
    try {
      const actualOwner = await ownerOfContract.ownerOf(troveId);
      if (ethers.getAddress(actualOwner) === normalizedOwner) {
        console.log(
          `      ✅ troveId ${troveId} is currently owned by ${owner} (OPEN loan)`
        );
        ownedNow.push(troveId);
      } else {
        console.log(
          `      ✋ troveId ${troveId} now belongs to ${actualOwner}, not ${owner}`
        );
      }
    } catch (err) {
      console.error(
        `      ownerOf(${troveId}) failed on ${nftAddress} (owner ${owner}): ${err.message}`
      );
      // closed/burned or invalid, ignore
    }
  }

  return ownedNow;
}

/**
 * For a given loan NFT contract on a given chain, discover all troveIds currently owned
 * by any of the provided addresses, starting from loan_state/env startBlock.
 *
 * Returns: array of { chain, protocol, contract, owner, troveId }.
 */
async function discoverForLoanContract({
  provider,
  chain,
  loanConfig,
  addressesForChain,
  loanState,
}) {
  const { protocol, address: nftAddress, envStartKey } = loanConfig;

  if (!nftAddress || !nftAddress.startsWith("0x")) {
    console.warn(`  Skipping loan contract with invalid address: ${nftAddress}`);
    return [];
  }

  const latestBlock = await provider.getBlockNumber();
  const startBlock = getStartBlock(loanState, chain, protocol, envStartKey);

  console.log(
    `\n=== Discovering loans for ${protocol} on ${chain} (${nftAddress}) ===`
  );
  console.log(
    `  Using start block: ${startBlock} (from state/env), latest block: ${latestBlock}`
  );

  const results = [];

  for (const { address: owner } of addressesForChain) {
    const troveIds = await discoverTroveIdsForOwner({
      provider,
      nftAddress,
      owner,
      startBlock,
      latestBlock,
    });

    if (troveIds.length === 0) {
      console.log(
        `  No open troves currently owned by ${owner} for ${protocol} on ${chain}`
      );
      continue;
    }

    console.log(
      `  >>> Owner ${owner} has ${troveIds.length} open trove(s) for ${protocol} on ${chain}: ${troveIds.join(
        ", "
      )}`
    );

    for (const troveId of troveIds) {
      results.push({
        chain,
        protocol,
        contract: nftAddress,
        owner,
        troveId,
      });
    }
  }

  setLastScannedBlock(loanState, chain, protocol, latestBlock);

  console.log(
    `  >>> Total ${results.length} open troves for ${protocol} across ${addressesForChain.length} owner(s) on ${chain}.`
  );

  return results;
}

// ========= MAIN =========

async function main() {
  // CLI filter: node dev/discover_loan_positions.js enosys_fxrp
  const args = process.argv.slice(2).map((a) => a.toLowerCase());

  // Load config
  const loanConfig = loadLoanConfig();

  // Flatten contracts: [{ chain, rpcEnvKey, key, protocol, address, envStartKey, csvFile }, ...]
  const flatContracts = [];
  for (const [chain, chainCfg] of Object.entries(loanConfig.chains || {})) {
    const rpcEnvKey = chainCfg.rpcEnvKey;
    const contracts = chainCfg.contracts || [];

    for (const c of contracts) {
      flatContracts.push({
        chain,
        rpcEnvKey,
        key: c.key,
        protocol: c.protocol,
        address: c.address,
        envStartKey: c.envStartKey,
        csvFile: c.csvFile,
      });
    }
  }

  if (flatContracts.length === 0) {
    console.log("No loan contracts defined in loan_contracts.json. Nothing to do.");
    return;
  }

  const allKeys = flatContracts.map((c) => c.key);
  const enabledContracts =
    args.length === 0
      ? flatContracts
      : flatContracts.filter((cfg) => args.includes(cfg.key.toLowerCase()));

  if (enabledContracts.length === 0) {
    console.log(
      "No matching loan configs for arguments:",
      args,
      "\nValid keys are:",
      allKeys.join(", ")
    );
    return;
  }

  console.log("Enabled loan configs:", enabledContracts.map((c) => c.key));

  console.log("Loading addresses CSV:", ADDRESSES_CSV);
  const allAddresses = await loadAddressesCsv(ADDRESSES_CSV);

  if (allAddresses.length === 0) {
    console.log("No addresses found in CSV. Nothing to do.");
    return;
  }

  console.log("Addresses from CSV:");
  console.log(allAddresses);

  // Create provider per chain
  const providerByChain = {};
  for (const cfg of enabledContracts) {
    if (providerByChain[cfg.chain]) continue;

    const rpcUrl = process.env[cfg.rpcEnvKey];
    if (!rpcUrl) {
      console.error(
        `Missing RPC env var ${cfg.rpcEnvKey} for chain ${cfg.chain}. Skipping that chain.`
      );
      continue;
    }

    providerByChain[cfg.chain] = new ethers.JsonRpcProvider(rpcUrl);
  }

  // Load existing loan state
  const loanState = loadLoanState();

  for (const cfg of enabledContracts) {
    const provider = providerByChain[cfg.chain];
    if (!provider) {
      console.warn(
        `No provider for chain ${cfg.chain} (rpcEnvKey ${cfg.rpcEnvKey}). Skipping ${cfg.protocol}.`
      );
      continue;
    }

    const addressesForChain = allAddresses.filter(
      (r) => r.chain === cfg.chain
    );
    if (addressesForChain.length === 0) {
      console.log(
        `No addresses for chain ${cfg.chain} in CSV. Skipping ${cfg.protocol}.`
      );
      continue;
    }

    const rows = await discoverForLoanContract({
      provider,
      chain: cfg.chain,
      loanConfig: cfg,
      addressesForChain,
      loanState,
    });

    const outputCsvPath = path.join(
      __dirname,
      "..",
      "data",
      cfg.csvFile || `${cfg.key}_loans_positions.csv`
    );

    console.log(
      `Writing/Appending loan positions for ${cfg.protocol} to ${outputCsvPath}`
    );
    appendLoansCsv(outputCsvPath, rows);
  }

  saveLoanState(loanState);
  console.log("\nLoan discovery complete.");
}

main().catch((err) => {
  console.error("Fatal error in loan discovery script:", err);
  process.exit(1);
});
