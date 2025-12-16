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

// ========= CONFIG =========

// CSV with your addresses at project root: data/addresses.csv
const ADDRESSES_CSV = path.join(__dirname, "..", "data", "addresses.csv");

// Output CSVs per DEX at project root: data/*.csv
const ENOSYS_OUTPUT_CSV = path.join(
  __dirname,
  "..",
  "data",
  "enosys_lp_positions.csv"
);
const SPARKDEX_OUTPUT_CSV = path.join(
  __dirname,
  "..",
  "data",
  "sparkdex_lp_positions.csv"
);

// State file to track lastScannedBlock per DEX
const LP_STATE_PATH = path.join(
  __dirname,
  "..",
  "data",
  "lp_scan_state.json"
);

// RPC (FLR only for now)
const FLR_RPC = process.env.FLR_MAINNET;
if (!FLR_RPC) {
  console.error("Missing FLR_MAINNET in .env");
  process.exit(1);
}

// LP NFT contracts on FLR
const LP_CONTRACTS_FLR = {
  enosys: {
    key: "enosys", // used for CLI filter
    protocol: "ENOSYS_LP",
    address: "0xD9770b1C7A6ccd33C75b5bcB1c0078f46bE46657",
    envStartKey: "ENOSYS_LP_START_BLOCK", // optional bootstrap
    outputCsv: ENOSYS_OUTPUT_CSV,
  },
  sparkdex: {
    key: "sparkdex",
    protocol: "SPARKDEX_LP",
    address: "0xEE5FF5Bc5F852764b5584d92A4d592A53DC527da",
    envStartKey: "SPARKDEX_LP_START_BLOCK", // optional bootstrap
    outputCsv: SPARKDEX_OUTPUT_CSV,
  },
};

// Max block window for eth_getLogs (Ankr limit you found)
const MAX_LOG_RANGE_BLOCKS = 1000;

// Minimal ABI: only need ownerOf for confirmation
const ERC721_MIN_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
];

// Transfer event topic for ERC721
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// ========= CSV HELPERS =========

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
 * Append rows to a CSV, creating it with a header if it doesn't exist.
 * Rows are { chain, protocol, contract, owner, tokenId }.
 */
function appendPositionsCsv(outputPath, rows) {
  if (!rows || rows.length === 0) {
    console.log(`No new rows for ${outputPath}, skipping append.`);
    return;
  }

  const header = "chain,protocol,contract,owner,tokenId\n";
  const body =
    rows
      .map(
        (r) =>
          `${r.chain},${r.protocol},${r.contract},${r.owner},${r.tokenId}`
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

// ========= LP STATE HELPERS =========

function loadLpState() {
  if (!fs.existsSync(LP_STATE_PATH)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(LP_STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error reading lp_scan_state.json, starting fresh:", err.message);
    return {};
  }
}

function saveLpState(state) {
  fs.mkdirSync(path.dirname(LP_STATE_PATH), { recursive: true });
  fs.writeFileSync(LP_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Get startBlock for a given chain+protocol.
 * Priority:
 *   1. lp_state.json: chain.protocol.lastScannedBlock
 *   2. env var: envStartKey
 *   3. 0
 */
function getStartBlock(lpState, chain, protocol, envStartKey) {
  const chainState = lpState[chain];
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
 * Update lpState with new lastScannedBlock for chain+protocol.
 */
function setLastScannedBlock(lpState, chain, protocol, blockNumber) {
  if (!lpState[chain]) {
    lpState[chain] = {};
  }
  lpState[chain][protocol] = {
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
 * Returns: array of tokenId strings currently owned by `owner`.
 */
async function discoverTokenIdsForOwner({
  provider,
  nftAddress,
  owner,
  startBlock,
  latestBlock,
}) {
  const ownerTopic = topicForAddress(owner);
  const normalizedOwner = ethers.getAddress(owner);
  const candidateTokenIds = new Set();

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
    `  [${nftAddress}] discovering for owner ${owner}, blocks ${startBlock} -> ${latestBlock} (step ${MAX_LOG_RANGE_BLOCKS})`
  );

  // Page over the block range
  for (
    let fromBlock = startBlock;
    fromBlock <= latestBlock;
    fromBlock += MAX_LOG_RANGE_BLOCKS + 1
  ) {
    const toBlock = Math.min(fromBlock + MAX_LOG_RANGE_BLOCKS, latestBlock);

    console.log(`    scanning blocks ${fromBlock} -> ${toBlock} for owner ${owner}`);

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
        const tokenId = BigInt(tokenIdHex).toString();
        candidateTokenIds.add(tokenId);
      }
    } catch (err) {
      console.error(
        `      getLogs error for ${nftAddress} [${fromBlock}–${toBlock}] owner ${owner}: ${err.message}`
      );
    }
  }

  // Confirm current ownership
  const ownedNow = [];
  for (const tokenId of candidateTokenIds) {
    try {
      const actualOwner = await ownerOfContract.ownerOf(tokenId);
      if (ethers.getAddress(actualOwner) === normalizedOwner) {
        ownedNow.push(tokenId);
      }
    } catch (err) {
      // If ownerOf fails (burned, etc.), ignore
      console.error(
        `      ownerOf(${tokenId}) failed on ${nftAddress} (owner ${owner}): ${err.message}`
      );
    }
  }

  return ownedNow;
}

/**
 * For a given LP contract on FLR, discover all tokenIds currently owned
 * by any of the provided FLR addresses, starting from lp_state/env startBlock.
 *
 * Returns: array of { chain, protocol, contract, owner, tokenId }.
 */
async function discoverForLpContract(provider, lpConfig, flrAddresses, lpState) {
  const { protocol, address: nftAddress, envStartKey } = lpConfig;

  if (!nftAddress || !nftAddress.startsWith("0x")) {
    console.warn(`  Skipping LP with invalid address: ${nftAddress}`);
    return [];
  }

  const chain = "FLR";
  const latestBlock = await provider.getBlockNumber();
  const startBlock = getStartBlock(lpState, chain, protocol, envStartKey);

  console.log(
    `\n=== Discovering positions for ${protocol} (${nftAddress}) ===`
  );
  console.log(
    `  Using start block: ${startBlock} (from state/env), latest block: ${latestBlock}`
  );

  const results = [];

  for (const { address: owner } of flrAddresses) {
    const tokenIds = await discoverTokenIdsForOwner({
      provider,
      nftAddress,
      owner,
      startBlock,
      latestBlock,
    });

    if (tokenIds.length === 0) {
      console.log(`  No tokenIds currently owned by ${owner} for ${protocol}`);
      continue;
    }

    for (const tokenId of tokenIds) {
      results.push({
        chain,
        protocol,
        contract: nftAddress,
        owner,
        tokenId,
      });
    }
  }

  // Update lpState with the latest block we scanned
  setLastScannedBlock(lpState, chain, protocol, latestBlock);

  console.log(
    `  >>> Found ${results.length} positions for ${protocol} across ${flrAddresses.length} owner(s).`
  );

  return results;
}

// ========= MAIN =========

async function main() {
  // CLI filter: node dev/discover_lp_positions.js enosys sparkdex
  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const allConfigs = Object.values(LP_CONTRACTS_FLR);
  const enabledConfigs =
    args.length === 0
      ? allConfigs
      : allConfigs.filter((cfg) => args.includes(cfg.key));

  if (enabledConfigs.length === 0) {
    console.log(
      "No matching LP configs for arguments:",
      args,
      "\nValid keys are:",
      allConfigs.map((c) => c.key).join(", ")
    );
    return;
  }

  console.log("Enabled LP configs:", enabledConfigs.map((c) => c.key));

  console.log("Loading addresses CSV:", ADDRESSES_CSV);
  const allAddresses = await loadAddressesCsv(ADDRESSES_CSV);

  const flrAddresses = allAddresses.filter((r) => r.chain === "FLR");

  if (flrAddresses.length === 0) {
    console.log("No FLR addresses found in CSV. Nothing to do.");
    return;
  }

  console.log("FLR addresses to scan:");
  console.log(flrAddresses);

  const provider = new ethers.JsonRpcProvider(FLR_RPC);

  // Load existing LP state
  const lpState = loadLpState();

  for (const cfg of enabledConfigs) {
    const rows = await discoverForLpContract(provider, cfg, flrAddresses, lpState);
    console.log(`Writing/Appending positions for ${cfg.protocol} to ${cfg.outputCsv}`);
    appendPositionsCsv(cfg.outputCsv, rows);
  }

  // Save updated state (lastScannedBlock per protocol)
  saveLpState(lpState);

  console.log("\nDiscovery complete.");
}

main().catch((err) => {
  console.error("Fatal error in discovery script:", err);
  process.exit(1);
});
