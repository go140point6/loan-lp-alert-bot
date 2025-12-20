// monitoring/globalIrSource.js
const https = require('https');

function requireEnv(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing ${key} in .env`);
    process.exit(1);
  }
  return v;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`HTTP ${res.statusCode} when fetching ${url}`)
            );
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

let cache = {
  atMs: 0,
  mapPct: null, // { FXRP: 5.97, WFLR: 4.76, ... }
};

async function getGlobalIrPctMap() {
  const url = requireEnv('GLOBAL_IR_URL');
  const ttlSecRaw = requireEnv('GLOBAL_IR_TTL_SEC');

  const ttlSec = Number(ttlSecRaw);
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    console.error(`GLOBAL_IR_TTL_SEC must be a positive number (got ${ttlSecRaw})`);
    process.exit(1);
  }

  const now = Date.now();
  if (cache.mapPct && now - cache.atMs < ttlSec * 1000) {
    return cache.mapPct;
  }

  const json = await fetchJson(url);

  if (!json || typeof json !== 'object' || !json.branch || typeof json.branch !== 'object') {
    throw new Error(`GLOBAL_IR_URL JSON missing expected "branch" object`);
  }

  const mapPct = {};
  for (const [branchKey, branchVal] of Object.entries(json.branch)) {
    const raw = branchVal && branchVal.interest_rate_avg;
    if (raw == null) continue;

    const n = Number(raw);
    if (!Number.isFinite(n)) continue;

    // interest_rate_avg appears to be a fraction (0.0597 => 5.97%).
    mapPct[branchKey.toUpperCase()] = n * 100.0;
  }

  cache = { atMs: now, mapPct };
  return mapPct;
}

module.exports = {
  getGlobalIrPctMap,
};
