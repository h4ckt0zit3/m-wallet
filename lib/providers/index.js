import { randomUUID } from 'node:crypto';
import { AppError, CODES } from '../errors.js';
import { normalizePhases } from '../phases.js';
import { supportedRuleTypes } from '../engine.js';
import { requireChain } from '../chains.js';
import { normalizeAddress } from '../rpc.js';
import { openseaProvider } from './opensea.js';
import { magicEdenProvider } from './magiceden.js';
import { contractProvider } from './contract.js';

/**
 * MintPlatformProvider registry.
 *
 * To add a platform: create ./<platform>.js exporting { id, name, requires,
 * urlHint, matches(input), analyze(input) -> raw project }, then add it to the
 * array below. Nothing else in the app needs to change - the engine only ever
 * sees the normalized shape produced by analyzeUrl().
 *
 * Order matters: the contract provider is last because it is the catch-all.
 */
export const PROVIDERS = [openseaProvider, magicEdenProvider, contractProvider];

export const providerCatalog = () => PROVIDERS.map(p => ({
  id: p.id,
  name: p.name,
  urlHint: p.urlHint,
  requires: p.requires || [],
  ready: (p.requires || []).every(k => Boolean(process.env[k]?.trim())),
  missingKeys: (p.requires || []).filter(k => !process.env[k]?.trim()),
}));

function pick(input) {
  const provider = PROVIDERS.find(p => p.matches(input));
  if (provider) return provider;
  let host = null;
  try { host = new URL(String(input).trim()).hostname; } catch { /* not a URL */ }
  throw new AppError(CODES.UNSUPPORTED_PLATFORM, host ? `${host} is not a supported mint platform` : 'Could not recognise that input', {
    detail: `Supported today: ${PROVIDERS.map(p => p.name).join(', ')}. You can always paste the collection contract address (0x...) directly. To add a platform, drop a new module into lib/providers/ and register it in lib/providers/index.js.`,
  });
}

/**
 * Resolve any supported link (or bare contract address) into a normalized,
 * storable project with classified mint phases.
 */
export async function analyzeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new AppError(CODES.INVALID_URL, 'Paste a mint link or a contract address first');
  if (raw.length > 2048) throw new AppError(CODES.INVALID_URL, 'That input is too long to be a URL');

  const provider = pick(raw);
  const project = await provider.analyze(raw);

  const phases = normalizePhases(project.phases || []).map((p, i) => ({
    id: `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`,
    ...p,
  }));

  return {
    id: randomUUID(),
    createdAt: Date.now(),
    ...project,
    input: raw,
    phases,
    warnings: project.warnings || [],
    findings: project.findings || [],
    sources: project.sources || [],
    attachedAllowlists: {},
  };
}

/**
 * Attach a user-supplied address list to a phase. This is how a Discord-only
 * or API-gated allowlist becomes verifiable: the merkle rule will confirm the
 * list reproduces the on-chain root before trusting it.
 */
export function attachAllowlist(project, phaseId, addresses, label = 'User-supplied allowlist') {
  const phase = project.phases.find(p => p.id === phaseId);
  if (!phase) throw new AppError(CODES.NOT_FOUND, `Phase "${phaseId}" not found in this project`);
  const list = [...new Set(addresses.map(a => String(a).trim()).filter(Boolean))];
  if (!list.length) throw new AppError(CODES.BAD_REQUEST, 'No addresses found in that allowlist');

  const target = phase.rules.find(r => r.type === 'merkle' || r.type === 'allowlist' || r.type === 'snapshot');
  if (target) {
    target.addresses = list;
    target.source = label;
  } else {
    phase.rules.push({ type: 'allowlist', addresses: list, source: label, label });
  }
  project.attachedAllowlists = { ...project.attachedAllowlists, [phaseId]: { count: list.length, label, at: Date.now() } };
  return project;
}

/**
 * Manual project definition ("paste JSON"). This is the escape hatch for a
 * project whose phases live only in a Discord announcement or a spreadsheet:
 * describe the phases and requirements yourself, and the engine checks them
 * with exactly the same rules and the same honesty about what it can prove.
 */
export function importProject(input) {
  const obj = typeof input === 'string' ? parseJson(input) : input;
  if (!obj || typeof obj !== 'object') throw new AppError(CODES.BAD_REQUEST, 'Project definition must be a JSON object');

  const chain = requireChain(obj.chain || 'ethereum');
  const name = String(obj.name || '').trim();
  if (!name) throw new AppError(CODES.BAD_REQUEST, 'Project definition needs a "name"');
  if (!Array.isArray(obj.phases) || !obj.phases.length) {
    throw new AppError(CODES.BAD_REQUEST, 'Project definition needs a non-empty "phases" array', {
      detail: 'Each phase needs a "name" and a "rules" array. See data/sample-project.json for a working example.',
    });
  }

  const known = new Set(supportedRuleTypes());
  const phases = obj.phases.map((p, i) => {
    if (!p?.name) throw new AppError(CODES.BAD_REQUEST, `Phase ${i + 1} is missing a "name"`);
    const rules = Array.isArray(p.rules) ? p.rules : [];
    for (const r of rules) {
      if (!known.has(r?.type)) {
        throw new AppError(CODES.BAD_REQUEST, `Phase "${p.name}" uses unknown rule type "${r?.type}"`, {
          detail: `Supported rule types: ${[...known].join(', ')}.`,
        });
      }
      if (['nft-holding', 'token-holding', 'previous-mint', 'contract-interaction'].includes(r.type)) {
        r.contract = normalizeAddress(r.contract);
        if (r.chain) r.chain = requireChain(r.chain).key;
      }
      if (r.addresses) r.addresses = r.addresses.map(a => normalizeAddress(a));
    }
    return {
      ...p,
      startTime: p.startTime ? new Date(p.startTime).getTime() : null,
      endTime: p.endTime ? new Date(p.endTime).getTime() : null,
      rules,
    };
  });

  const phasesWithIds = normalizePhases(phases).map((p, i) => ({
    id: `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`,
    ...p,
  }));

  return {
    id: randomUUID(),
    createdAt: Date.now(),
    platform: 'manual',
    sourceUrl: obj.sourceUrl || null,
    input: obj.sourceUrl || name,
    name,
    slug: obj.slug || null,
    description: obj.description || null,
    contract: obj.contract ? normalizeAddress(obj.contract) : null,
    chain: chain.key,
    supply: obj.supply ?? null,
    phases: phasesWithIds,
    warnings: [
      'This project was defined by hand, not read from a mint platform. Its phase names, dates and requirements are only as accurate as what was entered.',
      ...(obj.warnings || []),
    ],
    findings: obj.findings || [],
    frameworks: [],
    sources: obj.sources || [{ label: 'Manual definition', url: obj.sourceUrl || null }],
    attachedAllowlists: {},
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AppError(CODES.BAD_REQUEST, 'That is not valid JSON', { detail: err.message });
  }
}
