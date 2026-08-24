import { AppError, CODES } from '../errors.js';
import { fetchJson, safeUrl } from '../http.js';
import { resolveChain } from '../chains.js';
import { probeDrop, readBasics } from '../onchain.js';
import { normalizeAddress } from '../rpc.js';
import { classifyPhaseName } from '../phases.js';

/**
 * MintPlatformProvider: Magic Eden (EVM).
 *
 * Magic Eden proxies the Reservoir API, whose /mints/v1 endpoint publishes mint
 * stages including per-stage allowlist flags and wallet limits. That is a real
 * public source of GTD/FCFS phase data, so we use it when it answers and fall
 * back to the on-chain probe when it does not.
 *
 * Launchpad URLs that only carry a symbol (/launchpad/<chain>/<symbol>) cannot
 * be resolved to a contract without Magic Eden's private launchpad API - we say
 * so instead of guessing.
 */

const RTP = 'https://api-mainnet.magiceden.dev/v3/rtp';

const headers = () => {
  const key = process.env.MAGICEDEN_API_KEY?.trim();
  return key ? { authorization: `Bearer ${key}` } : {};
};

/** Reservoir stage kinds -> our rule shape. */
function stageToPhase(stage, chainKey, contract) {
  const name = stage.stage || stage.kind || 'Mint phase';
  const declared = stage.kind === 'public' ? 'PUBLIC' : undefined;
  const rules = [];

  if (stage.kind === 'allowlist') {
    rules.push({
      type: 'merkle',
      root: null,
      chain: chainKey,
      contract,
      source: 'Magic Eden / Reservoir mint stages',
      label: `${name} allowlist`,
    });
  } else if (stage.kind === 'public') {
    rules.push({ type: 'open', source: 'Magic Eden / Reservoir mint stages' });
  } else {
    rules.push({
      type: 'manual',
      note: `Magic Eden reports a "${stage.kind}" mint stage whose requirements it does not publish in a machine-readable form.`,
      missing: 'A structured requirement description for this stage.',
      source: 'Magic Eden / Reservoir mint stages',
    });
  }

  return {
    name,
    normalized: declared,
    startTime: stage.startTime ? Number(stage.startTime) * 1000 : null,
    endTime: stage.endTime ? Number(stage.endTime) * 1000 : null,
    walletLimit: stage.maxMintsPerWallet != null ? Number(stage.maxMintsPerWallet) : null,
    price: stage.price?.amount?.decimal ?? null,
    rules,
    note: classifyPhaseName(name).confidence === 'ambiguous'
      ? 'Magic Eden does not label stages as guaranteed or FCFS; the classification below is inferred from the stage name and ordering.'
      : null,
  };
}

export const magicEdenProvider = {
  id: 'magiceden',
  name: 'Magic Eden (EVM)',
  requires: [],
  optionalKeys: ['MAGICEDEN_API_KEY'],
  urlHint: 'https://magiceden.io/collections/<chain>/<contract>',

  matches(input) {
    try {
      return /(^|\.)magiceden\.(io|us)$/.test(new URL(String(input).trim()).hostname.replace(/^www\./, ''));
    } catch {
      return false;
    }
  },

  async analyze(input) {
    const url = safeUrl(input);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'launchpad') {
      throw new AppError(CODES.REQUIRES_PRIVATE_AUTH, 'Magic Eden launchpad links cannot be resolved from public data', {
        detail: `"${parts.slice(1).join('/')}" is a launchpad symbol, and mapping it to a contract address requires Magic Eden's private launchpad API. Open the collection page (magiceden.io/collections/<chain>/0x...) and paste that link, or paste the contract address directly.`,
      });
    }

    const idx = parts.indexOf('collections');
    const chainSlug = idx !== -1 ? parts[idx + 1] : null;
    const id = idx !== -1 ? parts[idx + 2] : null;
    if (!chainSlug || !id) {
      throw new AppError(CODES.INVALID_URL, 'That Magic Eden URL does not contain a chain and collection', {
        detail: 'Supported shape: https://magiceden.io/collections/<chain>/<contractAddress>',
      });
    }

    const chain = resolveChain(chainSlug);
    if (!chain) {
      throw new AppError(CODES.UNSUPPORTED_CHAIN, `Magic Eden chain "${chainSlug}" is not supported by this build`, {
        detail: 'This build handles EVM chains only. Solana collections are out of scope; add an EVM chain in lib/chains.js if it is missing.',
      });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(id)) {
      throw new AppError(CODES.INVALID_ADDRESS, `"${id}" is a collection symbol, not a contract address`, {
        detail: 'Magic Eden symbol slugs cannot be resolved to a contract from public data. Paste the contract address, or the collection URL that contains it.',
      });
    }

    const chainKey = chain.key;
    const contract = normalizeAddress(id);
    const warnings = [];

    const mints = await fetchJson(`${RTP}/${chainSlug}/mints/v1?collection=${contract}&limit=50`, {
      headers: headers(), label: 'Magic Eden mint stages', perMinute: 30,
    }).catch(err => {
      warnings.push(`Magic Eden mint-stage lookup failed: ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
      return null;
    });

    const meta = await fetchJson(`${RTP}/${chainSlug}/collections/v7?id=${contract}&limit=1`, {
      headers: headers(), label: 'Magic Eden collection lookup', perMinute: 30,
    }).catch(() => null);

    const stages = mints?.mints || [];
    const phases = stages.map(s => stageToPhase(s, chainKey, contract));

    const probe = await probeDrop(chainKey, contract);
    // On-chain merkle roots make Magic Eden's allowlist stages actually verifiable.
    const roots = probe.phases.flatMap(p => p.rules).filter(r => r.type === 'merkle' && r.root);
    if (roots.length === 1) {
      for (const p of phases) {
        for (const r of p.rules) if (r.type === 'merkle' && !r.root) r.root = roots[0].root;
      }
    }

    const combined = phases.length ? phases : probe.phases;
    if (!combined.length) {
      warnings.push('Neither Magic Eden nor the contract published any mint stage data for this collection.');
    }
    if (phases.some(p => p.rules.some(r => r.type === 'merkle' && !r.root))) {
      warnings.push('Magic Eden reports an allowlist stage but does not publish the addresses or the merkle root. Attach the allowlist to this project to make it checkable.');
    }

    const collection = meta?.collections?.[0];
    return {
      platform: 'magiceden',
      sourceUrl: url.toString(),
      name: collection?.name || (await readBasics(chainKey, contract).catch(() => ({}))).name || `Magic Eden collection ${contract.slice(0, 10)}...`,
      slug: collection?.slug || null,
      description: collection?.description || null,
      imageUrl: collection?.image || null,
      contract,
      chain: chainKey,
      supply: collection?.tokenCount != null ? Number(collection.tokenCount) : null,
      phases: combined,
      warnings: [...warnings, ...probe.warnings],
      findings: [
        ...(stages.length ? [`Magic Eden published ${stages.length} mint stage(s).`] : []),
        ...probe.findings,
      ],
      frameworks: probe.frameworks,
      sources: [
        { label: 'Magic Eden / Reservoir mints API', url: `${RTP}/${chainSlug}/mints/v1?collection=${contract}` },
        ...probe.sources,
      ],
    };
  },
};
