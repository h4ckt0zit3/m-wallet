import { AppError, CODES } from '../errors.js';
import { assertContract, normalizeAddress } from '../rpc.js';
import { probeDrop, readBasics } from '../onchain.js';
import { CHAINS, resolveChain } from '../chains.js';

/**
 * MintPlatformProvider: raw contract address or block-explorer URL.
 *
 * This is the fallback that always works without any API key. Accepts:
 *   0xabc...                       (assumes Ethereum)
 *   base:0xabc...                  (explicit chain prefix)
 *   https://etherscan.io/address/0xabc...
 *   https://basescan.org/token/0xabc...
 */

const EXPLORER_HOSTS = {
  'etherscan.io': 'ethereum',
  'basescan.org': 'base',
  'polygonscan.com': 'polygon',
  'arbiscan.io': 'arbitrum',
  'optimistic.etherscan.io': 'optimism',
  'sepolia.etherscan.io': 'sepolia',
};

const ADDRESS_RE = /(0x[0-9a-fA-F]{40})/;

export const contractProvider = {
  id: 'contract',
  name: 'Contract address / block explorer',
  requires: [],
  urlHint: '0xContractAddress, base:0xContractAddress, or an Etherscan/Basescan link',

  matches(input) {
    const raw = String(input).trim();
    if (ADDRESS_RE.test(raw) && !raw.startsWith('http')) return true;
    try {
      const host = new URL(raw).hostname.replace(/^www\./, '');
      return host in EXPLORER_HOSTS && ADDRESS_RE.test(raw);
    } catch {
      return false;
    }
  },

  async analyze(input) {
    const raw = String(input).trim();
    let chainKey = 'ethereum';
    let sourceUrl = null;

    if (raw.startsWith('http')) {
      const url = new URL(raw);
      chainKey = EXPLORER_HOSTS[url.hostname.replace(/^www\./, '')] || 'ethereum';
      sourceUrl = url.toString();
    } else if (raw.includes(':')) {
      const [prefix] = raw.split(':');
      const chain = resolveChain(prefix);
      if (!chain) {
        throw new AppError(CODES.UNSUPPORTED_CHAIN, `Unknown chain prefix "${prefix}"`, {
          detail: `Use one of: ${Object.keys(CHAINS).join(', ')}. Example: base:0x1234...`,
        });
      }
      chainKey = chain.key;
    }

    const match = raw.match(ADDRESS_RE);
    if (!match) throw new AppError(CODES.INVALID_ADDRESS, 'No contract address found in that input');
    const contract = await assertContract(chainKey, normalizeAddress(match[1]), 'Collection contract');

    const basics = await readBasics(chainKey, contract);
    const probe = await probeDrop(chainKey, contract);

    return {
      platform: 'contract',
      sourceUrl: sourceUrl || `${CHAINS[chainKey].explorer}/address/${contract}`,
      name: basics.name || `Contract ${contract.slice(0, 10)}...`,
      slug: null,
      contract,
      chain: chainKey,
      supply: basics.maxSupply ?? basics.totalSupply ?? null,
      phases: probe.phases,
      warnings: [
        ...probe.warnings,
        'Analyzed directly from the contract. Phase names and GTD/FCFS labelling come from on-chain getters only; a project may describe them differently on its own site.',
      ],
      findings: probe.findings,
      frameworks: probe.frameworks,
      sources: [
        { label: 'Block explorer', url: `${CHAINS[chainKey].explorer}/address/${contract}` },
        ...probe.sources,
      ],
    };
  },
};
