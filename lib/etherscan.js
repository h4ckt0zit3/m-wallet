import { fetchJson } from './http.js';
import { AppError, CODES } from './errors.js';
import { requireChain } from './chains.js';

/**
 * Indexer provider for the two rule types that plain RPC cannot answer:
 * "has this wallet interacted with contract X" and "how old is this wallet".
 * Without a key we throw NEEDS_API_KEY, which the engine turns into
 * "Unable to verify" — we never approximate these.
 */

const BASE = 'https://api.etherscan.io/v2/api';

function key() {
  const k = process.env.ETHERSCAN_API_KEY?.trim();
  if (!k) {
    throw new AppError(CODES.NEEDS_API_KEY, 'No block-explorer API key configured', {
      detail: 'This rule needs transaction history, which the RPC node does not index. Set ETHERSCAN_API_KEY in .env (free tier works) and re-run the check.',
    });
  }
  return k;
}

async function call(chainKey, params) {
  const chain = requireChain(chainKey);
  const url = new URL(BASE);
  url.search = new URLSearchParams({ chainid: String(chain.id), apikey: key(), ...params }).toString();
  const json = await fetchJson(url.toString(), { label: 'Etherscan', perMinute: 100, timeoutMs: 20_000 });
  if (json.status === '0' && /no transactions found|no records/i.test(json.message || json.result || '')) return [];
  if (json.status === '0') {
    throw new AppError(CODES.UPSTREAM_FAILURE, `Etherscan: ${json.message || 'request failed'}`, {
      status: 502, detail: typeof json.result === 'string' ? json.result : 'Check that the API key is valid and the chain is supported by Etherscan V2.',
    });
  }
  return Array.isArray(json.result) ? json.result : [];
}

/** Timestamp (ms) of a wallet's first outgoing transaction, or null if none. */
export async function firstTxTime(chainKey, address) {
  const txs = await call(chainKey, {
    module: 'account', action: 'txlist', address, startblock: '0', endblock: '99999999',
    page: '1', offset: '1', sort: 'asc',
  });
  return txs.length ? Number(txs[0].timeStamp) * 1000 : null;
}

// ponytail: scans the first 10k txs only. Wallets busier than that would need
// cursor pagination — add it if a false negative ever shows up.
export async function hasInteracted(chainKey, address, contract) {
  const target = contract.toLowerCase();
  const txs = await call(chainKey, {
    module: 'account', action: 'txlist', address, startblock: '0', endblock: '99999999',
    page: '1', offset: '10000', sort: 'asc',
  });
  const hit = txs.find(t => (t.to || '').toLowerCase() === target && t.isError === '0');
  return hit ? { found: true, hash: hit.hash, at: Number(hit.timeStamp) * 1000, truncated: txs.length >= 10000 } : { found: false, truncated: txs.length >= 10000 };
}
