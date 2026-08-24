/**
 * Load the sample wallets and the offline sample project into the store.
 *   npm run seed
 * Safe to re-run: duplicate wallets are skipped, the project is replaced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import { importProject } from './lib/providers/index.js';
import { checkEligibility } from './lib/engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(ROOT, 'data', f), 'utf8');

const imported = store.importWallets(read('sample-wallets.txt'));
console.log(`wallets: ${imported.added.length} added, ${imported.failed.length} skipped (${imported.failed.map(f => f.reason).join('; ') || 'none'})`);

for (const file of ['sample-project.json', 'sample-project-onchain.json']) {
  const project = store.saveProject(importProject(JSON.parse(read(file))));
  console.log(`project: ${project.name} (${project.phases.length} phases) -> ${project.phases.map(p => `${p.name}=${p.normalized}`).join(', ')}`);
}

// Run the offline project so the dashboard has results on first load.
const offline = store.listProjects().find(p => p.contract === '0x0000000000000000000000000000000000000001');
const results = await checkEligibility(offline, store.listWallets());
store.saveResults(offline.id, results);
console.log('results:', JSON.stringify(results.summary));
console.log('\nSeeded. Run `npm start` and open http://localhost:8787');
