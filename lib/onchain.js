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

// SeaDrop 1.0 is deployed at the same address on every chain OpenSea supports.
const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

const SEADROP_ABI = [
  'function getPublicDrop(address) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowListMerkleRoot(address) view returns (bytes32)',
  'function getTokenGatedAllowedTokens(address) view returns (address[])',
];

const quiet = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };

const isZeroRoot = root => !root || /^0x0{64}$/i.test(root);

/** OpenSea SeaDrop: a public drop struct plus an optional allow-list merkle root. */
async function probeSeaDrop(chainKey, contract) {
  const sd = contractAt(chainKey, SEADROP, SEADROP_ABI);
  const drop = await quiet(() => sd.getPublicDrop(contract));
  const root = await quiet(() => sd.getAllowListMerkleRoot(contract));
  const gated = await quiet(() => sd.getTokenGatedAllowedTokens(contract), []);

  const hasPublic = drop && Number(drop.startTime) > 0;
  if (!hasPublic && isZeroRoot(root) && !gated?.length) return null;

  const phases = [];
  const explorer = `${CHAINS[chainKey]?.explorer}/address/${SEADROP}`;

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
        source: `SeaDrop.getAllowListMerkleRoot() on ${chainKey}`,
        label: 'SeaDrop allow list',
      }],
      note: 'SeaDrop publishes a single allow-list merkle root on-chain. It does not publish the addresses behind it, nor whether the phase is guaranteed or FCFS.',
    });
  }

  for (const token of gated || []) {
    phases.push({
      name: `Token-gated (${token.slice(0, 8)}...)`,
      startTime: null,
      endTime: null,
      walletLimit: null,
      rules: [{ type: 'nft-holding', chain: chainKey, contract: token, min: 1, label: `token-gated collection ${token}`, source: 'SeaDrop.getTokenGatedAllowedTokens()' }],
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
      rules: [{ type: 'open', source: 'SeaDrop.getPublicDrop()' }],
    });
  }

  return {
    framework: 'OpenSea SeaDrop 1.0',
    phases,
    findings: [`Read SeaDrop configuration from ${SEADROP} on ${chainKey}.`],
    sources: [{ label: 'SeaDrop contract', url: explorer }],
  };
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
