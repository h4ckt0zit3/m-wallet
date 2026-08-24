import { AppError, CODES } from './errors.js';
import { nftBalance, tokenBalance, normalizeAddress } from './rpc.js';
import { matchTreeToRoot, buildTree } from './merkle.js';
import { firstTxTime, hasInteracted } from './etherscan.js';
import { GTD, FCFS, PUBLIC } from './phases.js';

/**
 * Eligibility Engine - pure logic, zero knowledge of HTTP or the UI.
 *
 * A rule evaluator returns one of three verdicts and never anything else:
 *   pass: true   -> requirement provably met      (confidence: verified)
 *   pass: false  -> requirement provably not met  (confidence: verified)
 *   pass: null   -> cannot be determined publicly (confidence: unknown)
 *
 * There is deliberately no "probably". Adding a rule type = add one entry to
 * EVALUATORS below.
 */

export const VERDICT = { ELIGIBLE: 'ELIGIBLE', NOT_ELIGIBLE: 'NOT_ELIGIBLE', UNVERIFIABLE: 'UNVERIFIABLE' };
export const STATUS = { BOTH: 'BOTH', GTD: 'GTD', FCFS: 'FCFS', PUBLIC: 'PUBLIC', NOT_ELIGIBLE: 'NOT_ELIGIBLE', UNVERIFIABLE: 'UNVERIFIABLE' };

const ok = (reason, source, extra = {}) => ({ pass: true, reason, source, confidence: 'verified', ...extra });
const no = (reason, source, extra = {}) => ({ pass: false, reason, source, confidence: 'verified', ...extra });
const unknown = (reason, source, extra = {}) => ({ pass: null, reason, source, confidence: 'unknown', ...extra });

const EVALUATORS = {
  /** Public / open phase: no requirement at all. */
  open: async () => ok('Phase is open to any wallet - no allowlist requirement.', 'Mint phase configuration'),

  /** Plain list of addresses published by the project. */
  allowlist: async (rule, wallet) => {
    const list = (rule.addresses || []).map(a => String(a).toLowerCase());
    const src = rule.source || 'Published allowlist';
    if (!list.length) {
      return unknown('The phase uses an allowlist, but no address list was published or supplied.', src, {
        missing: 'The allowlist addresses. Attach them to this project under Projects -> Attach allowlist.',
      });
    }
    return list.includes(wallet.toLowerCase())
      ? ok(`Address found in ${rule.label || 'the'} allowlist (${list.length} entries).`, src)
      : no(`Address is not among the ${list.length} entries of ${rule.label || 'the'} allowlist.`, src);
  },

  /**
   * Merkle allowlist. We only trust a supplied address list once its
   * reconstructed root matches the root published on-chain.
   */
  merkle: async (rule, wallet) => {
    const addresses = rule.addresses || [];
    const src = rule.source || 'On-chain merkle root';
    if (!addresses.length) {
      return unknown('Phase gates on a merkle root, and the underlying address list is not public.', src, {
        missing: `The allowlist snapshot behind root ${rule.root || '(unknown)'}. Projects usually publish it in Discord or via their own API; attach it to this project to enable verification.`,
      });
    }
    let addr;
    try { addr = normalizeAddress(wallet); } catch { return no('Invalid address.', 'input'); }

    if (rule.root) {
      const tree = matchTreeToRoot(addresses, rule.root);
      if (!tree) {
        return unknown('The supplied address list does not reproduce the merkle root published on-chain, so it cannot be trusted for this phase.', src, {
          missing: `A list whose merkle root equals ${rule.root}. The attached list is stale, partial, or belongs to a different phase.`,
        });
      }
      const proof = tree.proofOf(addr);
      return proof
        ? ok(`Address is a leaf of the merkle tree whose root (${rule.root.slice(0, 10)}...) matches the one published on-chain. Proof depth ${proof.length}.`, src, { proof })
        : no(`Address is not in the merkle tree published on-chain (root ${rule.root.slice(0, 10)}..., ${tree.size} entries).`, src);
    }

    const tree = buildTree(addresses);
    const proof = tree.proofOf(addr);
    return proof
      ? ok(`Address is in the supplied allowlist (${tree.size} entries). No on-chain root was readable, so the list could not be confirmed as the one the contract enforces.`, rule.source || 'Supplied allowlist', { proof })
      : no(`Address is not in the supplied allowlist (${tree.size} entries).`, rule.source || 'Supplied allowlist');
  },

  /** Holds >= min NFTs from a collection (ERC-721, or ERC-1155 when tokenId set). */
  'nft-holding': async (rule, wallet, ctx) => {
    const chain = rule.chain || ctx.chainKey;
    const min = Number(rule.min ?? 1);
    const bal = await ctx.memo(`nft:${chain}:${rule.contract}:${rule.tokenId ?? ''}:${wallet}`,
      () => nftBalance(chain, rule.contract, wallet, rule.tokenId));
    const n = Number(bal);
    const what = rule.label || `collection ${rule.contract}`;
    return n >= min
      ? ok(`Holds ${n} from ${what} (requires ${min}).`, `On-chain balanceOf() on ${chain}`)
      : no(`Holds ${n} from ${what}, requires ${min}.`, `On-chain balanceOf() on ${chain}`);
  },

  /** Holds >= min of an ERC-20. */
  'token-holding': async (rule, wallet, ctx) => {
    const chain = rule.chain || ctx.chainKey;
    const min = Number(rule.min ?? 1);
    const bal = await ctx.memo(`erc20:${chain}:${rule.contract}:${wallet}`, () => tokenBalance(chain, rule.contract, wallet));
    const have = Number(bal.formatted);
    const what = rule.label || `token ${rule.contract}`;
    return have >= min
      ? ok(`Holds ${have} ${what} (requires ${min}).`, `On-chain balanceOf() on ${chain}`)
      : no(`Holds ${have} ${what}, requires ${min}.`, `On-chain balanceOf() on ${chain}`);
  },

  /**
   * "Minted in a previous drop". On-chain we can only prove current holding,
   * unless an indexer key is available to look for the original transaction.
   */
  'previous-mint': async (rule, wallet, ctx) => {
    const chain = rule.chain || ctx.chainKey;
    const bal = Number(await ctx.memo(`nft:${chain}:${rule.contract}::${wallet}`, () => nftBalance(chain, rule.contract, wallet)));
    if (bal > 0) {
      return ok(`Currently holds ${bal} from ${rule.label || rule.contract}. Note: this proves ownership today, not that this wallet was the original minter.`, `On-chain balanceOf() on ${chain}`);
    }
    try {
      const res = await ctx.memo(`tx:${chain}:${rule.contract}:${wallet}`, () => hasInteracted(chain, wallet, rule.contract));
      return res.found
        ? ok(`No longer holds the NFT, but transacted with ${rule.label || rule.contract} (tx ${res.hash.slice(0, 10)}...).`, 'Etherscan transaction history')
        : no(`Holds none of ${rule.label || rule.contract} and no transaction to that contract was found.`, 'Etherscan transaction history');
    } catch (err) {
      return unknown(`Wallet holds none of ${rule.label || rule.contract} today, and past participation could not be checked.`, 'Etherscan transaction history', {
        missing: err instanceof AppError ? err.detail : err.message,
      });
    }
  },

  /** Has sent a successful transaction to a given contract. */
  'contract-interaction': async (rule, wallet, ctx) => {
    const chain = rule.chain || ctx.chainKey;
    try {
      const res = await ctx.memo(`tx:${chain}:${rule.contract}:${wallet}`, () => hasInteracted(chain, wallet, rule.contract));
      if (res.found) {
        return ok(`Interacted with ${rule.label || rule.contract} on ${new Date(res.at).toISOString().slice(0, 10)} (tx ${res.hash.slice(0, 10)}...).`, 'Etherscan transaction history');
      }
      return res.truncated
        ? unknown(`No interaction with ${rule.label || rule.contract} found in the first 10,000 transactions of this wallet, which was not its whole history.`, 'Etherscan transaction history', {
            missing: 'Full transaction-history pagination for a very active wallet.',
          })
        : no(`No transaction from this wallet to ${rule.label || rule.contract} exists.`, 'Etherscan transaction history');
    } catch (err) {
      return unknown('Transaction history is required for this rule and could not be read.', 'Etherscan transaction history', {
        missing: err instanceof AppError ? err.detail : err.message,
      });
    }
  },

  /** Wallet must be at least N days old (first outgoing tx). */
  'wallet-age': async (rule, wallet, ctx) => {
    const chain = rule.chain || ctx.chainKey;
    const minDays = Number(rule.minDays ?? 30);
    try {
      const first = await ctx.memo(`age:${chain}:${wallet}`, () => firstTxTime(chain, wallet));
      if (first == null) return no(`Wallet has no outgoing transactions on ${chain}, so it cannot meet the ${minDays}-day age requirement.`, 'Etherscan transaction history');
      const days = Math.floor((Date.now() - first) / 86400000);
      return days >= minDays
        ? ok(`Wallet is ${days} days old (first tx ${new Date(first).toISOString().slice(0, 10)}), requires ${minDays}.`, 'Etherscan transaction history')
        : no(`Wallet is ${days} days old, requires ${minDays}.`, 'Etherscan transaction history');
    } catch (err) {
      return unknown('Wallet age requires transaction history, which is unavailable.', 'Etherscan transaction history', {
        missing: err instanceof AppError ? err.detail : err.message,
      });
    }
  },

  /** Snapshot of holders at a past block. Only verifiable if the list is published. */
  snapshot: async (rule, wallet, ctx) => {
    if (rule.addresses?.length) {
      return EVALUATORS.allowlist({ ...rule, label: rule.label || `snapshot @ block ${rule.blockNumber ?? '?'}` }, wallet, ctx);
    }
    return unknown(`Eligibility is based on a snapshot${rule.blockNumber ? ` taken at block ${rule.blockNumber}` : ''}, and the resulting address list is not published.`, rule.source || 'Project snapshot', {
      missing: 'The snapshot address list, or an archive-node RPC able to read historical balances at that block.',
    });
  },

  /**
   * Anything behind a login, Discord, X, captcha, wallet signature or private
   * API. We never attempt to bypass these - by design this always returns
   * "unable to verify" with an explanation of exactly what is gated.
   */
  external: async rule => {
    const kinds = {
      discord: 'a Discord role / server verification',
      twitter: 'an X (Twitter) follow or verification',
      login: 'an authenticated account on the mint site',
      captcha: 'a human-verification captcha',
      signature: 'a wallet signature from the owner',
      'private-api': 'a private, non-public project API',
      manual: 'information the project has not published',
    };
    const what = kinds[rule.kind] || kinds.manual;
    return unknown(`Eligibility depends on ${what}, which is not publicly accessible.`, rule.source || 'Mint platform', {
      missing: rule.detail || `${what[0].toUpperCase()}${what.slice(1)}. This tool does not bypass authentication, so it can neither confirm nor deny this requirement.`,
    });
  },

  /** Escape hatch for a requirement we parsed but cannot express as a rule. */
  manual: async rule => unknown(
    rule.note || 'This requirement could not be expressed as a machine-checkable rule.',
    rule.source || 'Mint page',
    { missing: rule.missing || 'A structured description of the requirement.' },
  ),
};

export const supportedRuleTypes = () => Object.keys(EVALUATORS);

async function evaluateRule(rule, wallet, ctx) {
  const fn = EVALUATORS[rule.type];
  if (!fn) {
    return {
      ...unknown(`Unrecognised requirement type "${rule.type}".`, 'Eligibility engine', {
        missing: `An evaluator for "${rule.type}" in lib/engine.js.`,
      }),
      rule: rule.type,
    };
  }
  try {
    return { ...(await fn(rule, wallet, ctx)), rule: rule.type, label: rule.label || null };
  } catch (err) {
    const detail = err instanceof AppError ? `${err.message}. ${err.detail || ''}`.trim() : err.message;
    return {
      ...unknown(`Check failed: ${err instanceof AppError ? err.message : 'unexpected error'}`, 'Eligibility engine', { missing: detail }),
      rule: rule.type,
    };
  }
}

async function evaluatePhase(phase, wallet, ctx) {
  const rules = phase.rules?.length
    ? phase.rules
    : [{ type: 'manual', note: 'The mint phase was detected but no requirements could be read from public data.' }];

  const checks = [];
  for (const rule of rules) checks.push(await evaluateRule(rule, wallet, ctx));

  const failed = checks.find(c => c.pass === false);
  const unresolved = checks.filter(c => c.pass === null);

  let verdict, reason, confidence;
  if (failed) {
    verdict = VERDICT.NOT_ELIGIBLE; reason = failed.reason; confidence = 'verified';
  } else if (unresolved.length) {
    verdict = VERDICT.UNVERIFIABLE; reason = unresolved.map(c => c.reason).join(' '); confidence = 'unknown';
  } else {
    verdict = VERDICT.ELIGIBLE; reason = checks.map(c => c.reason).join(' '); confidence = 'verified';
  }

  return {
    phaseId: phase.id,
    phaseName: phase.name,
    normalized: phase.normalized,
    phaseConfidence: phase.phaseConfidence,
    mappingNote: phase.mappingNote,
    startTime: phase.startTime ?? null,
    endTime: phase.endTime ?? null,
    walletLimit: phase.walletLimit ?? null,
    verdict,
    reason,
    confidence,
    missing: unresolved.map(c => c.missing).filter(Boolean),
    sources: [...new Set(checks.map(c => c.source).filter(Boolean))],
    checks,
  };
}

function rollUp(phaseResults) {
  const eligibleIn = kind => phaseResults.some(p => p.normalized === kind && p.verdict === VERDICT.ELIGIBLE);
  const gtd = eligibleIn(GTD);
  const fcfs = eligibleIn(FCFS);
  const pub = eligibleIn(PUBLIC);
  const anyUnverifiable = phaseResults.some(p => p.verdict === VERDICT.UNVERIFIABLE);

  let status;
  if (gtd && fcfs) status = STATUS.BOTH;
  else if (gtd) status = STATUS.GTD;
  else if (fcfs) status = STATUS.FCFS;
  else if (anyUnverifiable) status = STATUS.UNVERIFIABLE;
  else if (pub) status = STATUS.PUBLIC;
  else status = STATUS.NOT_ELIGIBLE;

  const decisive = phaseResults.filter(p => p.verdict === VERDICT.ELIGIBLE);
  const reason = decisive.length
    ? decisive.map(p => `${p.phaseName} -> ${p.normalized}: ${p.reason}`).join(' | ')
    : (phaseResults.find(p => p.verdict === VERDICT.UNVERIFIABLE)?.reason
      || phaseResults.map(p => `${p.phaseName}: ${p.reason}`).join(' | ')
      || 'No mint phases were detected for this project.');

  return {
    gtd,
    fcfs,
    both: gtd && fcfs,
    public: pub,
    status,
    reason,
    confidence: status === STATUS.UNVERIFIABLE || !phaseResults.length ? 'unknown' : 'verified',
  };
}

// Small concurrency limiter so 50 wallets do not open 50 RPC sockets at once.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

/**
 * Run every wallet against every phase of a project.
 * @param {object} project normalized project (see lib/providers)
 * @param {Array<{id:string,name:string,address:string}>} wallets
 */
export async function checkEligibility(project, wallets, { concurrency = 6 } = {}) {
  if (!project) throw new AppError(CODES.NOT_FOUND, 'Project not found');

  const memoStore = new Map();
  const ctx = {
    chainKey: project.chain,
    project,
    memo(key, fn) {
      if (!memoStore.has(key)) {
        memoStore.set(key, fn().catch(err => { memoStore.delete(key); throw err; }));
      }
      return memoStore.get(key);
    },
  };

  const phases = project.phases || [];
  const checkedAt = Date.now();

  const results = await mapLimit(wallets, concurrency, async wallet => {
    let address;
    try {
      address = normalizeAddress(wallet.address);
    } catch (err) {
      return {
        walletId: wallet.id, name: wallet.name, address: wallet.address,
        status: STATUS.UNVERIFIABLE, gtd: false, fcfs: false, both: false, public: false,
        reason: err.message, confidence: 'unknown', phases: [], missing: [err.detail], sources: [],
      };
    }
    const phaseResults = [];
    for (const phase of phases) phaseResults.push(await evaluatePhase(phase, address, ctx));
    return {
      walletId: wallet.id,
      name: wallet.name,
      address,
      ...rollUp(phaseResults),
      missing: [...new Set(phaseResults.flatMap(p => p.missing))],
      sources: [...new Set(phaseResults.flatMap(p => p.sources))],
      phases: phaseResults,
    };
  });

  const count = pred => results.filter(pred).length;
  return {
    projectId: project.id,
    projectName: project.name,
    chain: project.chain,
    contract: project.contract,
    checkedAt,
    summary: {
      walletsChecked: results.length,
      gtd: count(r => r.gtd),
      fcfs: count(r => r.fcfs),
      both: count(r => r.both),
      notEligible: count(r => r.status === STATUS.NOT_ELIGIBLE),
      unverifiable: count(r => r.status === STATUS.UNVERIFIABLE),
      publicOnly: count(r => r.status === STATUS.PUBLIC),
    },
    results,
  };
}
