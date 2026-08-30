import { ethers } from 'ethers';
import { providerFor } from './rpc.js';
import { CHAINS } from './chains.js';

/**
 * SeaDrop configuration recovered from transaction history.
 *
 * Some SeaDrop tokens expose no readable registry pointer (no getAllowedSeaDrop),
 * so their live phase config cannot be read from state. But the transaction that
 * configured the drop is public: `multiConfigure` carries the whole setup -
 * public drop window, allow-list merkle root, token gates, and the signer set.
 *
 * Recovering it lets us distinguish the two cases that matter:
 *
 *   merkleRoot != 0  -> allowlist phase, checkable once the list is supplied
 *   signers.length>0 -> signature-gated phase, decided by a private server and
 *                       therefore NOT checkable from public data, ever
 *
 * Telling the user which one they face is far more useful than "unknown".
 */

const MULTICONFIGURE_ABI = [
  `function multiConfigure((
    uint256 maxSupply,
    string baseURI,
    string contractURI,
    address seaDropImpl,
    (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients) publicDrop,
    string dropURI,
    (bytes32 merkleRoot, string[] publicKeyURIs, string allowListURI) allowListData,
    address creatorPayoutAddress,
    bytes32 provenanceHash,
    address[] allowedFeeRecipients,
    address[] disallowedFeeRecipients,
    address[] allowedPayers,
    address[] disallowedPayers,
    address[] tokenGatedAllowedNftTokens,
    (uint80 mintPrice, uint16 maxTotalMintableByWallet, uint48 startTime, uint48 endTime, uint8 dropStageIndex, uint32 maxTokenSupplyForStage, uint16 feeBps, bool restrictFeeRecipients)[] tokenGatedDropStages,
    address[] disallowedTokenGatedAllowedNftTokens,
    address[] signers,
    (uint80 minMintPrice, uint24 maxMaxTotalMintableByWallet, uint40 minStartTime, uint40 maxEndTime, uint40 maxMaxTokenSupplyForStage, uint16 minFeeBps, uint16 maxFeeBps)[] signedMintValidationParams,
    address[] disallowedSigners
  ))`,
];

const MULTICONFIGURE_SELECTOR = '0x911f456b';
const iface = new ethers.Interface(MULTICONFIGURE_ABI);
const isZeroRoot = root => !root || /^0x0{64}$/i.test(root);

// ponytail: scans a bounded window of recent blocks via eth_getLogs, using the
// token's own events to locate its config transactions. Deep history would need
// an indexer; the drop config is near the mint by construction, so this holds.
const LOOKBACK_BLOCKS = 250_000;
// Cap on getTransaction calls per probe.
const MAX_CANDIDATES = 250;
const FETCH_CONCURRENCY = 20;

/**
 * Find the most recent multiConfigure call made against a token.
 * Returns the decoded config, or null when none is found in the window.
 */
export async function findDropConfig(chainKey, contract) {
  const provider = providerFor(chainKey);
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - LOOKBACK_BLOCKS);

  // The token emits events when configured; use them to find candidate txs
  // rather than scanning every block.
  let logs;
  try {
    logs = await provider.getLogs({ address: contract, fromBlock, toBlock: latest });
  } catch {
    return null; // RPC refused the range; caller degrades to "unknown".
  }
  if (!logs?.length) return null;

  // Config transactions are rare and can sit anywhere in the window - a drop is
  // usually configured BEFORE the mint traffic that dominates the log. So filter
  // out plain transfers, then check every remaining candidate and keep the
  // newest decodable one, which is the live configuration.
  const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
  const configish = logs.filter(l => l.topics[0] !== TRANSFER_TOPIC);
  const candidates = [...new Set((configish.length ? configish : logs).map(l => l.transactionHash))];

  // Fetch candidates in parallel; sequential lookups made this probe take
  // minutes on a busy contract.
  const slice = candidates.slice(0, MAX_CANDIDATES);
  const txs = [];
  for (let i = 0; i < slice.length; i += FETCH_CONCURRENCY) {
    const batch = await Promise.all(
      slice.slice(i, i + FETCH_CONCURRENCY).map(h => provider.getTransaction(h).catch(() => null)),
    );
    txs.push(...batch);
  }

  let best = null;
  for (const tx of txs) {
    if (!tx?.data?.toLowerCase().startsWith(MULTICONFIGURE_SELECTOR)) continue;
    if (tx.to?.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const config = iface.parseTransaction({ data: tx.data }).args[0];
      if (!best || tx.blockNumber >= best.blockNumber) {
        best = { config, txHash: tx.hash, blockNumber: tx.blockNumber };
      }
    } catch {
      continue; // A different multiConfigure shape; not one we can decode.
    }
  }
  return best;
}

/**
 * Build phases from a recovered multiConfigure call.
 * Returns null when no config transaction was found.
 */
export async function probeMultiConfigure(chainKey, contract) {
  const found = await findDropConfig(chainKey, contract);
  if (!found) return null;

  const { config, txHash } = found;
  const explorer = CHAINS[chainKey]?.explorer;
  const txUrl = explorer ? `${explorer}/tx/${txHash}` : txHash;
  const evidence = `SeaDrop multiConfigure() transaction ${txHash.slice(0, 12)}...`;

  const phases = [];
  const warnings = [];
  const findings = [`Recovered the drop configuration from ${evidence} on ${chainKey}.`];

  const signers = (config.signers || []).filter(s => s !== ethers.ZeroAddress);
  const root = config.allowListData?.merkleRoot;
  const allowListURI = config.allowListData?.allowListURI || '';

  // 1. Merkle allow list, when one was actually configured.
  if (!isZeroRoot(root)) {
    phases.push({
      name: 'Allow List',
      startTime: null,
      endTime: null,
      walletLimit: null,
      rules: [{
        type: 'merkle',
        root,
        chain: chainKey,
        contract,
        source: evidence,
        label: 'SeaDrop allow list',
      }],
      note: allowListURI
        ? `The project published the allow list at ${allowListURI}. Attach those addresses to verify wallets against the on-chain root.`
        : 'A merkle root is configured but the address list behind it was not published on-chain.',
    });
  }

  // 2. Signature-gated stage: the case that can never be verified publicly.
  if (signers.length) {
    phases.push({
      name: 'Signature-gated stage',
      startTime: null,
      endTime: null,
      walletLimit: null,
      rules: [{
        type: 'external',
        kind: 'private-api',
        source: evidence,
        detail: `Minting this stage requires an ECDSA signature produced at mint time by ${signers.join(', ')}, a key the mint platform controls. No allow list exists on-chain (merkle root is empty), so the eligibility criteria are held in a private database and are not published anywhere public. The platform's own mint page is the only place that can answer whether a given wallet qualifies.`,
      }],
      note: 'Eligibility for this stage is decided off-chain by a signing server. This is not a gap in available data - no public source exists.',
    });
    warnings.push(`This drop gates a mint stage behind an off-chain signer (${signers[0]}). Wallet eligibility for that stage is decided by a private server and cannot be verified from public data by any tool.`);
  }

  // 3. Token-gated stages.
  (config.tokenGatedAllowedNftTokens || []).forEach((token, i) => {
    const stage = config.tokenGatedDropStages?.[i];
    phases.push({
      name: `Token-gated (${token.slice(0, 8)}...)`,
      startTime: stage?.startTime ? Number(stage.startTime) * 1000 : null,
      endTime: stage?.endTime ? Number(stage.endTime) * 1000 : null,
      walletLimit: stage?.maxTotalMintableByWallet ? Number(stage.maxTotalMintableByWallet) : null,
      rules: [{
        type: 'nft-holding',
        chain: chainKey,
        contract: token,
        min: 1,
        label: `token-gated collection ${token}`,
        source: evidence,
      }],
    });
  });

  // 4. The public drop window.
  const pub = config.publicDrop;
  if (pub && Number(pub.startTime) > 0) {
    phases.push({
      name: 'Public Sale',
      normalized: 'PUBLIC',
      startTime: Number(pub.startTime) * 1000,
      endTime: Number(pub.endTime) * 1000,
      walletLimit: Number(pub.maxTotalMintableByWallet) || null,
      price: ethers.formatEther(pub.mintPrice),
      rules: [{ type: 'open', source: evidence }],
    });
  }

  if (!phases.length) return null;

  return {
    framework: 'OpenSea SeaDrop (recovered from multiConfigure)',
    phases,
    findings,
    warnings,
    sources: [{ label: 'Drop configuration transaction', url: txUrl }],
  };
}
