import { ethers } from 'ethers';
import { AppError, CODES } from './errors.js';
import { requireChain, rpcUrls } from './chains.js';

/**
 * BlockchainProvider — the only place that talks to an EVM node.
 * NFTOwnershipProvider / TokenOwnershipProvider are the balance helpers below.
 * Swap in Alchemy/Infura by setting RPC_* env vars; no code change needed.
 */

const cache = new Map();

export function providerFor(chainKey) {
  const chain = requireChain(chainKey);
  if (!cache.has(chain.key)) {
    const urls = rpcUrls(chain);
    const net = new ethers.Network(chain.name, chain.id);
    const providers = urls.map(url => new ethers.JsonRpcProvider(url, net, { staticNetwork: net, batchMaxCount: 10 }));
    cache.set(chain.key, providers.length > 1
      ? new ethers.FallbackProvider(providers.map((p, i) => ({ provider: p, priority: i + 1, stallTimeout: 3000, weight: 1 })), net, { quorum: 1 })
      : providers[0]);
  }
  return cache.get(chain.key);
}

/** Validate + checksum an address. Throws a user-readable error, never guesses. */
export function normalizeAddress(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new AppError(CODES.INVALID_ADDRESS, 'Wallet address is required');
  if (/^0x[0-9a-fA-F]{40}$/.test(raw) === false) {
    throw new AppError(CODES.INVALID_ADDRESS, `"${raw.slice(0, 60)}" is not a valid EVM address`, {
      detail: 'An EVM address is 0x followed by exactly 40 hex characters. ENS names are not resolved offline — paste the 0x address.',
    });
  }
  try {
    return ethers.getAddress(raw);
  } catch {
    throw new AppError(CODES.INVALID_ADDRESS, `"${raw}" failed the EIP-55 checksum`, {
      detail: 'The address has mixed case that does not match its checksum, which usually means a typo. Paste it all-lowercase to skip the checksum check.',
    });
  }
}

async function rpc(chainKey, fn, what) {
  try {
    return await fn(providerFor(chainKey));
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(CODES.RPC_FAILURE, `RPC call failed while ${what}`, {
      status: 502,
      detail: `${err.shortMessage || err.message}. The public RPC for "${chainKey}" may be rate limiting; set RPC_${String(chainKey).toUpperCase()} in .env to a dedicated endpoint.`,
      cause: err,
    });
  }
}

export async function assertContract(chainKey, address, label = 'Contract') {
  const addr = normalizeAddress(address);
  const code = await rpc(chainKey, p => p.getCode(addr), `checking code at ${addr}`);
  if (!code || code === '0x') {
    throw new AppError(CODES.CONTRACT_NOT_FOUND, `${label} ${addr} has no code on ${chainKey}`, {
      detail: 'Either the address is an EOA (a normal wallet), or the contract lives on a different chain than the one detected.',
    });
  }
  return addr;
}

export function contractAt(chainKey, address, abi) {
  return new ethers.Contract(normalizeAddress(address), abi, providerFor(chainKey));
}

const ERC721_ABI = ['function balanceOf(address) view returns (uint256)', 'function ownerOf(uint256) view returns (address)'];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'];
const ERC1155_ABI = ['function balanceOf(address,uint256) view returns (uint256)'];

/** NFTOwnershipProvider */
export async function nftBalance(chainKey, contract, wallet, tokenId = null) {
  const owner = normalizeAddress(wallet);
  if (tokenId !== null && tokenId !== undefined && tokenId !== '') {
    const c = contractAt(chainKey, contract, ERC1155_ABI);
    return await rpc(chainKey, () => c.balanceOf(owner, tokenId), `reading ERC-1155 balance of ${owner}`);
  }
  const c = contractAt(chainKey, contract, ERC721_ABI);
  return await rpc(chainKey, () => c.balanceOf(owner), `reading ERC-721 balance of ${owner}`);
}

/** TokenOwnershipProvider */
export async function tokenBalance(chainKey, contract, wallet) {
  const c = contractAt(chainKey, contract, ERC20_ABI);
  const owner = normalizeAddress(wallet);
  const [raw, decimals] = await Promise.all([
    rpc(chainKey, () => c.balanceOf(owner), `reading ERC-20 balance of ${owner}`),
    rpc(chainKey, () => c.decimals(), 'reading token decimals').catch(() => 18n),
  ]);
  return { raw, decimals: Number(decimals), formatted: ethers.formatUnits(raw, Number(decimals)) };
}

export async function readCollectionName(chainKey, contract) {
  const c = contractAt(chainKey, contract, ['function name() view returns (string)']);
  try { return await c.name(); } catch { return null; }
}

export { rpc as rawRpc, ethers };
