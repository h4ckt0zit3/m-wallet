import { AppError, CODES } from '../errors.js';
import { fetchJson, safeUrl } from '../http.js';
import { resolveChain } from '../chains.js';
import { probeDrop, readBasics } from '../onchain.js';
import { normalizeAddress } from '../rpc.js';

/**
 * MintPlatformProvider: OpenSea.
 *
 * URL -> collection slug -> contract + chain via the official API v2, then the
 * mint phases are read from the chain (SeaDrop), because OpenSea does not
 * expose drop stages on a public unauthenticated endpoint.
 *
 * Requires OPENSEA_API_KEY. opensea.io itself sits behind bot protection and
 * we do not attempt to scrape it.
 */

const API = 'https://api.opensea.io/api/v2';

function apiHeaders() {
  const key = process.env.OPENSEA_API_KEY?.trim();
  if (!key) {
    throw new AppError(CODES.NEEDS_API_KEY, 'OpenSea link analysis needs an OpenSea API key', {
      status: 400,
      detail: 'Set OPENSEA_API_KEY in .env and restart the server. Keys are free at https://docs.opensea.io/reference/api-keys. Alternatively paste the collection contract address directly - that path needs no key.',
    });
  }
  return { 'x-api-key': key };
}

const get = (path, label) => fetchJson(`${API}${path}`, { headers: apiHeaders(), label: label || 'OpenSea API', perMinute: 60 });

/** Pull { slug, chain, contract } out of any OpenSea URL shape we know. */
function parseUrl(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const i = parts.findIndex(p => p === 'item' || p === 'assets');
  if (i !== -1 && parts.length >= i + 3) {
    return { chainSlug: parts[i + 1], contract: parts[i + 2], tokenId: parts[i + 3] || null };
  }
  const c = parts.indexOf('collection');
  if (c !== -1 && parts[c + 1]) return { slug: parts[c + 1] };
  // https://opensea.io/<chain>/<contract> - occasionally seen on drop pages
  if (parts.length >= 2 && /^0x[0-9a-fA-F]{40}$/.test(parts[1])) return { chainSlug: parts[0], contract: parts[1] };
  return null;
}

export const openseaProvider = {
  id: 'opensea',
  name: 'OpenSea',
  requires: ['OPENSEA_API_KEY'],
  urlHint: 'https://opensea.io/collection/<slug> or https://opensea.io/item/<chain>/<contract>/<id>',

  matches(input) {
    try {
      return /(^|\.)opensea\.io$/.test(new URL(String(input).trim()).hostname.replace(/^www\./, ''));
    } catch {
      return false;
    }
  },

  async analyze(input) {
    const url = safeUrl(input);
    const parsed = parseUrl(url);
    if (!parsed) {
      throw new AppError(CODES.INVALID_URL, 'That OpenSea URL does not point at a collection or item', {
        detail: 'Supported shapes: /collection/<slug>, /item/<chain>/<contract>/<tokenId>, /assets/<chain>/<contract>/<tokenId>.',
      });
    }

    let slug = parsed.slug;
    let chainKey = null;
    let contract = null;
    const warnings = [];

    if (parsed.contract) {
      const chain = resolveChain(parsed.chainSlug);
      if (!chain) {
        throw new AppError(CODES.UNSUPPORTED_CHAIN, `OpenSea chain "${parsed.chainSlug}" is not supported by this build`, {
          detail: 'Add it to lib/chains.js with an RPC endpoint to enable it.',
        });
      }
      chainKey = chain.key;
      contract = normalizeAddress(parsed.contract);
      const info = await get(`/chain/${parsed.chainSlug}/contract/${contract}`, 'OpenSea contract lookup').catch(err => {
        warnings.push(`Could not resolve the collection slug from OpenSea: ${err.message}`);
        return null;
      });
      slug = info?.collection || slug;
    }

    let meta = null;
    if (slug) {
      meta = await get(`/collections/${encodeURIComponent(slug)}`, 'OpenSea collection lookup');
      if (!contract) {
        const supported = (meta.contracts || [])
          .map(c => ({ ...c, chain: resolveChain(c.chain) }))
          .filter(c => c.chain);
        if (!supported.length) {
          throw new AppError(CODES.UNSUPPORTED_CHAIN, `Collection "${slug}" is not on a chain this build supports`, {
            detail: `OpenSea reports contracts on: ${(meta.contracts || []).map(c => c.chain).join(', ') || 'none'}.`,
          });
        }
        if (supported.length > 1) {
          warnings.push(`Collection is deployed on ${supported.length} chains (${supported.map(c => c.chain.key).join(', ')}). Analyzed ${supported[0].chain.key}; paste the contract address directly to analyze another.`);
        }
        contract = normalizeAddress(supported[0].address);
        chainKey = supported[0].chain.key;
      }
    }

    if (!contract) {
      throw new AppError(CODES.CONTRACT_NOT_FOUND, 'Could not determine a contract address from that OpenSea link', {
        detail: 'The collection may be a shared-storefront or off-chain listing. Paste the contract address directly instead.',
      });
    }

    const basics = await readBasics(chainKey, contract).catch(() => ({}));
    const probe = await probeDrop(chainKey, contract);

    if (!probe.phases.length) {
      warnings.push('OpenSea does not publish drop stages on an unauthenticated endpoint, and this contract exposes no phase configuration on-chain. Mint phases could not be determined - anything shown on the OpenSea drop page is rendered client-side behind their protected API.');
    }

    return {
      platform: 'opensea',
      sourceUrl: url.toString(),
      name: meta?.name || basics.name || `OpenSea collection ${contract.slice(0, 10)}...`,
      slug: slug || null,
      description: meta?.description || null,
      imageUrl: meta?.image_url || null,
      contract,
      chain: chainKey,
      supply: meta?.total_supply ?? basics.maxSupply ?? null,
      phases: probe.phases,
      warnings: [...warnings, ...probe.warnings],
      findings: probe.findings,
      frameworks: probe.frameworks,
      sources: [
        { label: 'OpenSea API v2', url: `${API}/collections/${slug || ''}` },
        ...probe.sources,
      ],
    };
  },
};
