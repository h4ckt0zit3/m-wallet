import { AppError, CODES } from './errors.js';

/**
 * BlockchainProvider config. Adding a new EVM chain = one entry here.
 * RPC urls come from env (comma separated for failover) and fall back to
 * public endpoints so the app runs with zero configuration.
 */
export const CHAINS = {
  ethereum: {
    key: 'ethereum', id: 1, name: 'Ethereum', symbol: 'ETH',
    env: 'RPC_ETHEREUM',
    fallbackRpc: ['https://eth.llamarpc.com', 'https://ethereum-rpc.publicnode.com', 'https://rpc.ankr.com/eth'],
    explorer: 'https://etherscan.io',
  },
  base: {
    key: 'base', id: 8453, name: 'Base', symbol: 'ETH',
    env: 'RPC_BASE',
    fallbackRpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorer: 'https://basescan.org',
  },
  polygon: {
    key: 'polygon', id: 137, name: 'Polygon', symbol: 'POL',
    env: 'RPC_POLYGON',
    fallbackRpc: ['https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'],
    explorer: 'https://polygonscan.com',
  },
  arbitrum: {
    key: 'arbitrum', id: 42161, name: 'Arbitrum One', symbol: 'ETH',
    env: 'RPC_ARBITRUM',
    fallbackRpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorer: 'https://arbiscan.io',
  },
  optimism: {
    key: 'optimism', id: 10, name: 'OP Mainnet', symbol: 'ETH',
    env: 'RPC_OPTIMISM',
    fallbackRpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
    explorer: 'https://optimistic.etherscan.io',
  },
  sepolia: {
    key: 'sepolia', id: 11155111, name: 'Sepolia', symbol: 'ETH',
    env: 'RPC_SEPOLIA',
    fallbackRpc: ['https://ethereum-sepolia-rpc.publicnode.com'],
    explorer: 'https://sepolia.etherscan.io',
  },
};

// Aliases used by the various mint platforms in their URLs / API payloads.
const ALIASES = {
  eth: 'ethereum', mainnet: 'ethereum', 'eth-mainnet': 'ethereum', homestead: 'ethereum', '1': 'ethereum',
  matic: 'polygon', 'matic-mainnet': 'polygon', '137': 'polygon',
  'base-mainnet': 'base', '8453': 'base',
  'arbitrum-one': 'arbitrum', arb: 'arbitrum', '42161': 'arbitrum',
  op: 'optimism', 'optimism-mainnet': 'optimism', '10': 'optimism',
  '11155111': 'sepolia',
};

export function resolveChain(input) {
  if (input == null) return null;
  const k = String(input).trim().toLowerCase();
  const key = CHAINS[k] ? k : ALIASES[k];
  return key ? CHAINS[key] : null;
}

export function requireChain(input) {
  const chain = resolveChain(input);
  if (!chain) {
    throw new AppError(CODES.UNSUPPORTED_CHAIN, `Unsupported blockchain: "${input}"`, {
      detail: `This build supports: ${Object.keys(CHAINS).join(', ')}. Add an entry to lib/chains.js to support another EVM chain.`,
    });
  }
  return chain;
}

export function rpcUrls(chain) {
  const fromEnv = (process.env[chain.env] || '').split(',').map(s => s.trim()).filter(Boolean);
  return fromEnv.length ? [...fromEnv, ...chain.fallbackRpc] : chain.fallbackRpc;
}
