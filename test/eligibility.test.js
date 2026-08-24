import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { normalizePhases, classifyPhaseName } from '../lib/phases.js';
import { buildTree, matchTreeToRoot } from '../lib/merkle.js';
import { checkEligibility, STATUS } from '../lib/engine.js';
import { normalizeAddress } from '../lib/rpc.js';
import { importProject } from '../lib/providers/index.js';

const A = n => `0x${String(n).repeat(40).slice(0, 40)}`;
const WALLETS = [
  { id: 'w1', name: 'Main', address: A(1) },
  { id: 'w2', name: 'Alpha 1', address: A(2) },
  { id: 'w3', name: 'Alpha 2', address: A(3) },
  { id: 'w4', name: 'Alpha 3', address: A(4) },
];

/* ------------------------------------------------------------ addresses */

test('address validation accepts valid and rejects malformed', () => {
  assert.equal(normalizeAddress(A(1)), A(1));
  assert.throws(() => normalizeAddress('0x123'), /not a valid EVM address/);
  assert.throws(() => normalizeAddress('vitalik.eth'), /not a valid EVM address/);
  // Wrong EIP-55 checksum must be rejected, not silently accepted.
  assert.throws(() => normalizeAddress('0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13d'), /checksum/);
});

/* --------------------------------------------------------------- phases */

test('phase names map to GTD / FCFS / PUBLIC', () => {
  assert.equal(classifyPhaseName('OG / Guaranteed').normalized, 'GTD');
  assert.equal(classifyPhaseName('FCFS Round').normalized, 'FCFS');
  assert.equal(classifyPhaseName('Public Sale').normalized, 'PUBLIC');
  assert.equal(classifyPhaseName('WL').confidence, 'ambiguous');
});

test('an ambiguous phase after a guaranteed one is inferred as FCFS', () => {
  const out = normalizePhases([
    { name: 'OG', startTime: 1 },
    { name: 'Allowlist', startTime: 2 },
    { name: 'Public', startTime: 3 },
  ]);
  assert.deepEqual(out.map(p => p.normalized), ['GTD', 'FCFS', 'PUBLIC']);
  assert.equal(out[1].phaseConfidence, 'inferred');
  assert.match(out[1].mappingNote, /Inferred FCFS/);
  // The original name is never lost.
  assert.equal(out[1].name, 'Allowlist');
});

test('a lone ambiguous phase is inferred as GTD, still flagged', () => {
  const out = normalizePhases([{ name: 'Presale', startTime: 1 }]);
  assert.equal(out[0].normalized, 'GTD');
  assert.equal(out[0].phaseConfidence, 'inferred');
});

/* --------------------------------------------------------------- merkle */

test('merkle proofs round-trip and the root identifies the convention', () => {
  const list = [A(1), A(2), A(3), A(5)];
  const tree = buildTree(list);
  assert.ok(tree.proofOf(A(1)));
  assert.equal(tree.proofOf(A(9)), null);

  const found = matchTreeToRoot(list, tree.root);
  assert.ok(found, 'the published root should be reproducible from the list');
  assert.equal(found.root, tree.root);

  // A list that does not produce the published root must NOT be trusted.
  assert.equal(matchTreeToRoot([A(1), A(2)], tree.root), null);
});

/* --------------------------------------------------------------- engine */

const project = importProject({
  name: 'Test Drop',
  chain: 'ethereum',
  contract: A(9),
  phases: [
    { name: 'OG / Guaranteed', rules: [{ type: 'allowlist', addresses: [A(1), A(3)], label: 'OG', source: 'test' }] },
    { name: 'FCFS', rules: [{ type: 'allowlist', addresses: [A(2), A(3)], label: 'FCFS', source: 'test' }] },
    { name: 'Raffle (Discord)', normalized: 'FCFS', rules: [{ type: 'external', kind: 'discord' }] },
  ],
});

test('engine classifies GTD / FCFS / BOTH and explains every verdict', async () => {
  const out = await checkEligibility(project, WALLETS);
  const by = Object.fromEntries(out.results.map(r => [r.name, r]));

  assert.equal(by['Main'].status, STATUS.GTD);
  assert.ok(by['Main'].gtd && !by['Main'].fcfs);
  assert.match(by['Main'].reason, /found in OG allowlist/);

  assert.equal(by['Alpha 1'].status, STATUS.FCFS);
  assert.equal(by['Alpha 2'].status, STATUS.BOTH);
  assert.ok(by['Alpha 2'].both);

  // No allowlist hit anywhere, and the Discord phase cannot be checked:
  // that is "unable to verify", never a confident "not eligible".
  assert.equal(by['Alpha 3'].status, STATUS.UNVERIFIABLE);
  assert.equal(by['Alpha 3'].confidence, 'unknown');
  assert.ok(by['Alpha 3'].missing.length, 'must say what information is missing');

  assert.deepEqual(out.summary, { walletsChecked: 4, gtd: 2, fcfs: 2, both: 1, notEligible: 0, unverifiable: 1, publicOnly: 0 });
  // Every wallet carries evidence, not just a yes/no.
  for (const r of out.results) assert.ok(r.reason.length > 10, `${r.name} needs a reason`);
});

test('a wallet failing every checkable phase is NOT_ELIGIBLE, not unverifiable', async () => {
  const strict = importProject({
    name: 'Strict', chain: 'ethereum',
    phases: [{ name: 'Guaranteed', rules: [{ type: 'allowlist', addresses: [A(1)], source: 'test' }] }],
  });
  const out = await checkEligibility(strict, [WALLETS[3]]);
  assert.equal(out.results[0].status, STATUS.NOT_ELIGIBLE);
  assert.equal(out.results[0].confidence, 'verified');
  assert.match(out.results[0].reason, /not among the 1 entries/);
});

test('an unverifiable merkle phase names exactly what is missing', async () => {
  const gated = importProject({
    name: 'Gated', chain: 'ethereum',
    phases: [{ name: 'Guaranteed', rules: [{ type: 'merkle', root: '0x' + 'ab'.repeat(32), source: 'on-chain' }] }],
  });
  const out = await checkEligibility(gated, [WALLETS[0]]);
  assert.equal(out.results[0].status, STATUS.UNVERIFIABLE);
  assert.match(out.results[0].missing.join(' '), /allowlist snapshot behind root/);
});

test('an attached list that does not reproduce the on-chain root is rejected', async () => {
  const real = buildTree([A(1), A(2), A(3)]);
  const wrong = importProject({
    name: 'Stale list', chain: 'ethereum',
    phases: [{ name: 'Guaranteed', rules: [{ type: 'merkle', root: real.root, addresses: [A(1), A(7)], source: 'on-chain' }] }],
  });
  const out = await checkEligibility(wrong, [WALLETS[0]]);
  assert.equal(out.results[0].status, STATUS.UNVERIFIABLE, 'a stale list must not produce a confident YES');
  assert.match(out.results[0].reason, /does not reproduce the merkle root/);
});

/* ---------------------------------------------------------------- store */

test('store validates addresses and refuses duplicates', async () => {
  const tmp = path.join(os.tmpdir(), `wec-test-${process.pid}.json`);
  process.env.DB_PATH = tmp;
  const store = await import('../lib/store.js');
  store._useFile(tmp);
  try {
    const out = store.importWallets(`Main, ${A(1)}\nBroken, 0xnope\n${A(2)}`);
    assert.equal(out.added.length, 2);
    assert.equal(out.failed.length, 1);
    assert.equal(out.failed[0].line, 2);
    assert.throws(() => store.addWallet({ name: 'Dupe', address: A(1) }), /already saved as "Main"/);
  } finally {
    fs.rmSync(tmp, { force: true });
    delete process.env.DB_PATH;
  }
});

test('an unambiguous keyword outranks a softer one in the same name', () => {
  // "holders" alone is a GTD signal, but an explicit FCFS must win.
  assert.equal(classifyPhaseName('FCFS - token holders').normalized, 'FCFS');
  assert.equal(classifyPhaseName('Guaranteed OG').normalized, 'GTD');
  assert.equal(classifyPhaseName('Public open edition').normalized, 'PUBLIC');
});
