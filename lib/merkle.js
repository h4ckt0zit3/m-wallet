import { ethers } from 'ethers';

/**
 * AllowlistProvider helper — OpenZeppelin-compatible merkle trees.
 *
 * There is no single standard for how projects hash an allowlist leaf, so we
 * build the tree under every common convention and only report a match when a
 * reconstructed root *equals the root published on-chain*. If none match we say
 * so rather than pretending the list is authoritative.
 */

const LEAF_MODES = {
  // keccak256(abi.encodePacked(address)) — merkletreejs convention
  packed: addr => ethers.keccak256(ethers.solidityPacked(['address'], [addr])),
  // keccak256(bytes.concat(keccak256(abi.encode(address)))) — OZ StandardMerkleTree
  standard: addr => ethers.keccak256(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address'], [addr]))),
};

const hashPair = (a, b) => ethers.keccak256(ethers.concat(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));

function buildLayers(leaves) {
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const prev = layers.at(-1);
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  return layers;
}

function proofFor(layers, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const pair = idx ^ 1;
    if (pair < layers[l].length) proof.push(layers[l][pair]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Build one tree under an explicit convention. */
export function buildTree(addresses, { leafMode = 'packed', sortLeaves = true } = {}) {
  const clean = [...new Set(addresses.map(a => ethers.getAddress(a.trim())))];
  const hash = LEAF_MODES[leafMode];
  let entries = clean.map(addr => ({ addr, leaf: hash(addr) }));
  if (sortLeaves) entries.sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0));
  const layers = buildLayers(entries.map(e => e.leaf));
  return {
    leafMode, sortLeaves,
    root: layers.at(-1)[0] ?? ethers.ZeroHash,
    size: entries.length,
    proofOf(address) {
      const target = ethers.getAddress(address);
      const i = entries.findIndex(e => e.addr === target);
      return i === -1 ? null : proofFor(layers, i);
    },
  };
}

const CONVENTIONS = [
  { leafMode: 'packed', sortLeaves: true },
  { leafMode: 'packed', sortLeaves: false },
  { leafMode: 'standard', sortLeaves: true },
  { leafMode: 'standard', sortLeaves: false },
];

/**
 * Find which hashing convention reproduces `expectedRoot` from `addresses`.
 * Returns null when the supplied list does not produce the published root —
 * meaning the list is stale, partial, or from a different phase.
 */
export function matchTreeToRoot(addresses, expectedRoot) {
  if (!expectedRoot) return null;
  const want = expectedRoot.toLowerCase();
  for (const conv of CONVENTIONS) {
    const tree = buildTree(addresses, conv);
    if (tree.root.toLowerCase() === want) return tree;
  }
  return null;
}
