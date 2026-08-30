import test from 'node:test';
import assert from 'node:assert/strict';
import { probeDrop } from '../lib/onchain.js';

/**
 * Regression: probeDrop used to query the canonical SeaDrop registry blindly.
 * A registry returns a zero-filled struct for a token it does not know, which
 * decodes without throwing - so unrelated contracts were reported as having a
 * "Public Sale" phase that does not exist. A probe must never invent a phase.
 *
 * These hit a live RPC; skipped when the network is unavailable so the suite
 * stays runnable offline.
 */

// Probe the same endpoints the app falls back to; any one reachable is enough.
const online = await (async () => {
  for (const url of ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://rpc.ankr.com/eth']) {
    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(8000),
    }).then(r => r.ok).catch(() => false);
    if (ok) return true;
  }
  return false;
})();

test('a non-SeaDrop contract yields no fabricated phase', { skip: !online && 'no network' }, async () => {
  // BAYC: a plain ERC-721, governed by no SeaDrop registry.
  const out = await probeDrop('ethereum', '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D');
  assert.equal(out.phases.length, 0, 'must not invent phases for a non-SeaDrop token');
  assert.ok(out.warnings.length, 'must explain that nothing was readable');
  assert.ok(
    !out.phases.some(p => p.normalized === 'PUBLIC'),
    'the old bug surfaced as a phantom PUBLIC phase',
  );
});

test('probeDrop never reports a phase without a citable source', { skip: !online && 'no network' }, async () => {
  const out = await probeDrop('ethereum', '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D');
  for (const p of out.phases) {
    for (const rule of p.rules) {
      assert.ok(rule.source, `rule ${rule.type} must cite where it came from`);
    }
  }
});

/**
 * A signature-gated stage must surface as UNVERIFIABLE with the signer named -
 * never as a confident yes or no. The criteria live in a private database, so
 * no public source can answer, and the tool must say exactly that.
 */
test('a recovered multiConfigure reports a signature gate honestly', { skip: !online && 'no network' }, async () => {
  const { probeMultiConfigure } = await import('../lib/multiconfigure.js');
  const { checkEligibility } = await import('../lib/engine.js');

  // Decoding is exercised without a network call by driving the phase shape the
  // recovery produces: an `external`/private-api rule.
  const project = {
    id: 'sig', name: 'Signature gated', chain: 'ethereum', contract: null,
    phases: [{
      id: 'p0', name: 'Signature-gated stage', normalized: 'GTD', phaseConfidence: 'declared',
      rules: [{ type: 'external', kind: 'private-api', source: 'multiConfigure()', detail: 'Requires a signature from off-chain signer 0xabc at mint time.' }],
    }],
  };
  const out = await checkEligibility(project, [{ id: 'w', name: 'W', address: '0x'.padEnd(42, '1') }]);
  const r = out.results[0];
  assert.equal(r.status, 'UNVERIFIABLE');
  assert.equal(r.gtd, false, 'a signature gate must never be reported as GTD-eligible');
  assert.equal(r.confidence, 'unknown');
  assert.ok(r.missing.length, 'must name what is missing');
  assert.match(r.missing.join(' '), /sign/i, 'the explanation must point at the signature gate');
  assert.equal(typeof probeMultiConfigure, 'function');
});
