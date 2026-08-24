import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, CODES } from './errors.js';
import { normalizeAddress } from './rpc.js';

/**
 * Persistence: a single JSON file under data/.
 *
 * Nothing here is a secret - only public addresses, labels and results - so a
 * flat file is the right amount of database for this. Writes are atomic
 * (tmp + rename) so a crash mid-write cannot corrupt the store.
 *
 * ponytail: single-file JSON, loaded in memory. Move to SQLite if this ever
 * holds more than a few thousand wallets or needs concurrent writers.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = () => process.env.DB_PATH || path.join(ROOT, 'data', 'db.json');
const EMPTY = { wallets: [], projects: [], results: {} };

let db = null;

function load() {
  if (db) return db;
  try {
    db = { ...EMPTY, ...JSON.parse(fs.readFileSync(dbPath(), 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new AppError(CODES.BAD_REQUEST, `Could not read the database at ${dbPath()}`, {
        status: 500,
        detail: `${err.message}. Fix or delete the file - a fresh one will be created on next write.`,
      });
    }
    db = structuredClone(EMPTY);
  }
  return db;
}

function save() {
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
}

/* ---------------------------------------------------------------- wallets */

export const listWallets = () => load().wallets;

export function addWallet({ name, address, notes = '' }) {
  const d = load();
  const addr = normalizeAddress(address);
  const label = String(name || '').trim() || `Wallet ${d.wallets.length + 1}`;
  if (label.length > 64) throw new AppError(CODES.BAD_REQUEST, 'Wallet name must be 64 characters or fewer');

  const existing = d.wallets.find(w => w.address.toLowerCase() === addr.toLowerCase());
  if (existing) {
    throw new AppError(CODES.BAD_REQUEST, `That address is already saved as "${existing.name}"`, {
      detail: 'Rename the existing entry instead of adding a duplicate.',
    });
  }
  const wallet = { id: randomUUID(), name: label, address: addr, notes: String(notes).slice(0, 280), addedAt: Date.now() };
  d.wallets.push(wallet);
  save();
  return wallet;
}

/**
 * Bulk import. Accepts one wallet per line in any of:
 *   0xabc...
 *   Name, 0xabc...
 *   0xabc..., Name
 *   Name<TAB>0xabc...
 * Returns per-line results so the UI can show exactly which lines failed.
 */
export function importWallets(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) throw new AppError(CODES.BAD_REQUEST, 'Nothing to import - paste at least one address');
  if (lines.length > 1000) throw new AppError(CODES.BAD_REQUEST, `That is ${lines.length} lines; import at most 1000 at a time`);

  const added = [];
  const failed = [];
  lines.forEach((line, i) => {
    const parts = line.split(/[,;\t]/).map(s => s.trim()).filter(Boolean);
    const addrPart = parts.find(p => /^0x[0-9a-fA-F]{40}$/.test(p));
    const namePart = parts.find(p => p !== addrPart);
    try {
      if (!addrPart) {
        throw new AppError(CODES.INVALID_ADDRESS, 'No 0x address found on this line', {
          detail: 'Expected formats: "0xabc...", "Label, 0xabc..." or "0xabc..., Label".',
        });
      }
      added.push(addWallet({ name: namePart || `Imported ${i + 1}`, address: addrPart }));
    } catch (err) {
      failed.push({ line: i + 1, text: line.slice(0, 80), reason: err.message, detail: err.detail || null });
    }
  });
  return { added, failed, total: lines.length };
}

export function updateWallet(id, patch) {
  const d = load();
  const w = d.wallets.find(x => x.id === id);
  if (!w) throw new AppError(CODES.NOT_FOUND, 'Wallet not found', { status: 404 });
  if (patch.name !== undefined) {
    const label = String(patch.name).trim();
    if (!label) throw new AppError(CODES.BAD_REQUEST, 'Wallet name cannot be empty');
    w.name = label.slice(0, 64);
  }
  if (patch.address !== undefined) {
    const addr = normalizeAddress(patch.address);
    const clash = d.wallets.find(x => x.id !== id && x.address.toLowerCase() === addr.toLowerCase());
    if (clash) throw new AppError(CODES.BAD_REQUEST, `That address is already saved as "${clash.name}"`);
    w.address = addr;
  }
  if (patch.notes !== undefined) w.notes = String(patch.notes).slice(0, 280);
  save();
  return w;
}

export function deleteWallet(id) {
  const d = load();
  const i = d.wallets.findIndex(w => w.id === id);
  if (i === -1) throw new AppError(CODES.NOT_FOUND, 'Wallet not found', { status: 404 });
  const [gone] = d.wallets.splice(i, 1);
  save();
  return gone;
}

/* --------------------------------------------------------------- projects */

export const listProjects = () => load().projects;

export function getProject(id) {
  const p = load().projects.find(x => x.id === id);
  if (!p) throw new AppError(CODES.NOT_FOUND, 'Project not found', { status: 404 });
  return p;
}

export function saveProject(project) {
  const d = load();
  const i = d.projects.findIndex(p => p.id === project.id
    || (p.contract === project.contract && p.chain === project.chain && p.platform === project.platform));
  if (i === -1) d.projects.unshift(project);
  else d.projects[i] = { ...project, id: d.projects[i].id, createdAt: d.projects[i].createdAt };
  save();
  return i === -1 ? project : d.projects[i];
}

export function deleteProject(id) {
  const d = load();
  const i = d.projects.findIndex(p => p.id === id);
  if (i === -1) throw new AppError(CODES.NOT_FOUND, 'Project not found', { status: 404 });
  const [gone] = d.projects.splice(i, 1);
  delete d.results[id];
  save();
  return gone;
}

/* ---------------------------------------------------------------- results */

export const getResults = id => load().results[id] || null;

export function saveResults(id, results) {
  const d = load();
  d.results[id] = results;
  save();
  return results;
}

export function stats() {
  const d = load();
  return {
    wallets: d.wallets.length,
    projects: d.projects.length,
    lastChecked: Object.values(d.results).reduce((m, r) => Math.max(m, r.checkedAt || 0), 0) || null,
    recent: d.projects.slice(0, 5).map(p => ({
      id: p.id, name: p.name, platform: p.platform, chain: p.chain,
      phases: p.phases.length, createdAt: p.createdAt,
      summary: d.results[p.id]?.summary || null,
      checkedAt: d.results[p.id]?.checkedAt || null,
    })),
  };
}

/** Test hook: point the store at a scratch file. */
export function _useFile(file) {
  db = null;
  process.env.DB_PATH = file;
}

export { dbPath };
