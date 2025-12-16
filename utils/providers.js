const { ethers } = require('ethers');

/**
 * Returns an ethers provider for a given chain based on chainsConfig.
 * Expects chainsConfig[chainId] to have an `rpcEnvKey` (e.g. "RPC_ARBITRUM").
 */
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

module.exports = {
  getProviderForChain,
};