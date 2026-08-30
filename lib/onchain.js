import { ethers } from 'ethers';
import { contractAt, providerFor, normalizeAddress } from './rpc.js';
import { CHAINS } from './chains.js';

/**
 * On-chain mint-configuration probe.
 *
 * Reads whatever a drop contract actually publishes about its phases. Every
 * read is best-effort and every finding records where it came from, so the
 * eligibility engine can cite real evidence instead of an assumption.
 *
 * Adding support for another drop framework = add a probe function and list it
 * in PROBES at the bottom.
 */

const SEADROP_ABI = [
  'function getPublicDrop(address) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowListMerkleRoot(address) view returns (bytes32)',
  'function getTokenGatedAllowedTokens(address) view returns (address[])',
];

// The token side of the SeaDrop interface: which registries may mint it.
const SEADROP_TOKEN_ABI = ['function getAllowedSeaDrop() view returns (address[])'];

const quiet = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };

const isZeroRoot = root => !root || /^0x0{64}$/i.test(root);

/**
 * OpenSea SeaDrop.
 *
 * A registry call like getPublicDrop() returns a zero-filled struct for a token
 * it has never heard of, and that decodes without throwing - so querying a
 * registry blindly invents an empty "Public Sale" phase for unrelated tokens.
 * We therefore ask the TOKEN which SeaDrop governs it (getAllowedSeaDrop) and
 * only trust a registry the token itself names. If the token does not answer,
 * it is not a SeaDrop 1.0 token and we say nothing rather than guessing.
 */
async function probeSeaDrop(chainKey, contract) {
  const token = contractAt(chainKey, contract, SEADROP_TOKEN_ABI);
  const allowed = await quiet(() => token.getAllowedSeaDrop());

  if (!allowed?.length) {
    // Not a SeaDrop 1.0 token. Report the gap instead of fabricating phases.
    const looksSeaDrop = await hasSeaDropWriteInterface(chainKey, contract);
    return looksSeaDrop
      ? {
          framework: 'SeaDrop-family (registry not discoverable)',
          phases: [],
          findings: [],
          sources: [],
          warnings: ['This contract implements the SeaDrop minting interface, but does not expose getAllowedSeaDrop(), so the registry holding its mint stages could not be identified on-chain. Its allow-list root and phase schedule are therefore not readable from public chain data - the mint platform renders them from its own API.'],
        }
      : null;
  }

  const phases = [];
  const findings = [];
  const sources = [];

  for (const registry of allowed) {
    const sd = contractAt(chainKey, registry, SEADROP_ABI);
    const drop = await quiet(() => sd.getPublicDrop(contract));
    const root = await quiet(() => sd.getAllowListMerkleRoot(contract));
    const gated = await quiet(() => sd.getTokenGatedAllowedTokens(contract), []);

    const hasPublic = drop && Number(drop.startTime) > 0;
    if (!hasPublic && isZeroRoot(root) && !gated?.length) continue;

    findings.push(`Read SeaDrop configuration from ${registry} on ${chainKey} (named by the token itself).`);
    sources.push({ label: 'SeaDrop registry', url: `${CHAINS[chainKey]?.explorer}/address/${registry}` });

    if (!isZeroRoot(root)) {
      phases.push({
        name: 'SeaDrop Allow List',
        startTime: null,
        endTime: null,
        walletLimit: null,
        rules: [{
          type: 'merkle',
          root,
          chain: chainKey,
          contract,
          source: `SeaDrop.getAllowListMerkleRoot() at ${registry} on ${chainKey}`,
          label: 'SeaDrop allow list',
        }],
        note: 'SeaDrop publishes a single allow-list merkle root on-chain. It does not publish the addresses behind it, nor whether the phase is guaranteed or FCFS.',
      });
    }

    for (const gatedToken of gated || []) {
      phases.push({
        name: `Token-gated (${gatedToken.slice(0, 8)}...)`,
        startTime: null,
        endTime: null,
        walletLimit: null,
        rules: [{ type: 'nft-holding', chain: chainKey, contract: gatedToken, min: 1, label: `token-gated collection ${gatedToken}`, source: 'SeaDrop.getTokenGatedAllowedTokens()' }],
      });
    }

    if (hasPublic) {
      phases.push({
        name: 'Public Sale',
        normalized: 'PUBLIC',
        startTime: Number(drop.startTime) * 1000,
        endTime: Number(drop.endTime) * 1000,
        walletLimit: Number(drop.maxTotalMintableByWallet) || null,
        price: ethers.formatEther(drop.mintPrice),
        rules: [{ type: 'open', source: `SeaDrop.getPublicDrop() at ${registry}` }],
      });
    }
  }

  if (!phases.length) {
    return {
      framework: 'OpenSea SeaDrop 1.0',
      phases: [],
      findings: [`Token names ${allowed.length} SeaDrop registry/registries, none of which holds a configured drop for it.`],
      sources: [],
      warnings: ['The token points at a SeaDrop registry, but that registry has no drop configured for it yet. Phases may not have been set on-chain at the time of this check.'],
    };
  }

  return { framework: 'OpenSea SeaDrop 1.0', phases, findings, sources };
}

/**
 * Detect a SeaDrop-family token by its write interface. Tokens minted through a
 * newer/forked SeaDrop still carry updateAllowList + mintSeaDrop even when they
 * expose no readable registry pointer.
 */
async function hasSeaDropWriteInterface(chainKey, contract) {
  const code = await quiet(() => providerFor(chainKey).getCode(contract), '0x');
  if (!code || code === '0x') return false;
  // Selectors: updateAllowList(address,(bytes32,string[],string)) and mintSeaDrop(address,uint256)
  return ['3680620d', '64869dad'].every(sel => code.toLowerCase().includes(sel));
}

// Common ad-hoc merkle-root getters used by hand-rolled drop contracts.
const ROOT_GETTERS = [
  ['merkleRoot', 'Allowlist'],
  ['root', 'Allowlist'],
  ['allowlistMerkleRoot', 'Allowlist'],
  ['whitelistMerkleRoot', 'Whitelist'],
  ['presaleMerkleRoot', 'Presale'],
  ['ogMerkleRoot', 'OG'],
  ['gtdMerkleRoot', 'Guaranteed'],
  ['fcfsMerkleRoot', 'FCFS'],
  ['waitlistMerkleRoot', 'Waitlist'],
];

/** Hand-rolled ERC-721 drops: probe the usual public getters. */
async function probeGenericMerkle(chainKey, contract) {
  const phases = [];
  const findings = [];
  for (const [fn, label] of ROOT_GETTERS) {
    const c = contractAt(chainKey, contract, [`function ${fn}() view returns (bytes32)`]);
    const root = await quiet(() => c[fn]());
    if (isZeroRoot(root)) continue;
    findings.push(`${fn}() returned ${root}`);
    phases.push({
      name: label,
      startTime: null,
      endTime: null,
      walletLimit: null,
      rules: [{ type: 'merkle', root, chain: chainKey, contract, source: `${fn}() on ${contract}`, label: `${label} merkle allowlist` }],
      note: `Contract publishes a merkle root via ${fn}(). The address list behind it is off-chain.`,
    });
  }
  return phases.length ? { framework: 'Custom merkle drop', phases, findings, sources: [] } : null;
}

/** Basic collection facts every ERC-721 exposes. */
export async function readBasics(chainKey, contract) {
  const c = contractAt(chainKey, contract, [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function maxSupply() view returns (uint256)',
  ]);
  const [name, symbol, totalSupply, maxSupply] = await Promise.all([
    quiet(() => c.name()), quiet(() => c.symbol()),
    quiet(() => c.totalSupply()), quiet(() => c.maxSupply()),
  ]);
  return {
    name: name || null,
    symbol: symbol || null,
    totalSupply: totalSupply != null ? Number(totalSupply) : null,
    maxSupply: maxSupply != null ? Number(maxSupply) : null,
  };
}

const PROBES = [probeSeaDrop, probeGenericMerkle];

/**
 * Run every known drop-framework probe against a contract.
 * Returns { phases, findings, sources, warnings } - phases may be empty, which
 * is a legitimate answer meaning "this contract publishes nothing on-chain".
 */
export async function probeDrop(chainKey, contractAddress) {
  const contract = normalizeAddress(contractAddress);
  const phases = [];
  const findings = [];
  const sources = [];
  const warnings = [];
  const frameworks = [];

  for (const probe of PROBES) {
    try {
      const res = await probe(chainKey, contract);
      if (!res) continue;
      frameworks.push(res.framework);
      phases.push(...res.phases);
      findings.push(...(res.findings || []));
      sources.push(...(res.sources || []));
      warnings.push(...(res.warnings || []));
    } catch (err) {
      warnings.push(`Probe ${probe.name} failed: ${err.shortMessage || err.message}`);
    }
  }

  if (!phases.length) {
    warnings.push('No mint phase configuration is readable on-chain for this contract. Its phases are most likely enforced by an off-chain API or a signature-based minter.');
  }
  return { phases, findings, sources, warnings, frameworks };
}

export async function currentBlock(chainKey) {
  return providerFor(chainKey).getBlockNumber();
}
