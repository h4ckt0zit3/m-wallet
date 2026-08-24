import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, CODES } from './lib/errors.js';
import { CHAINS } from './lib/chains.js';
import * as store from './lib/store.js';
import { analyzeUrl, importProject, attachAllowlist, providerCatalog } from './lib/providers/index.js';
import { checkEligibility, supportedRuleTypes, STATUS } from './lib/engine.js';

// Node's built-in .env loader; no dotenv dependency needed.
try { process.loadEnvFile(); } catch { /* no .env file, fine - defaults apply */ }

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8787;

/* ------------------------------------------------------------ plumbing */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(payload);
}

function sendError(res, err) {
  const app = err instanceof AppError ? err : new AppError(CODES.BAD_REQUEST, 'Unexpected server error', { status: 500, detail: err?.message || String(err) });
  if (!(err instanceof AppError)) console.error('[unhandled]', err);
  send(res, app.status || 400, { error: app.toJSON() });
}

async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError(CODES.BAD_REQUEST, 'Request body too large', { detail: `Limit is ${limit / 1e6} MB. Import allowlists in smaller batches.` });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    throw new AppError(CODES.BAD_REQUEST, 'Request body is not valid JSON', { detail: err.message });
  }
}

// ponytail: per-IP fixed window in memory. Enough for a local/single-user tool;
// swap for a shared store if this is ever deployed multi-instance.
const hits = new Map();
function throttle(req, key, max, windowMs) {
  const ip = req.socket.remoteAddress || 'local';
  const id = `${key}:${ip}`;
  const now = Date.now();
  const rec = hits.get(id);
  if (!rec || now > rec.reset) {
    hits.set(id, { n: 1, reset: now + windowMs });
    return;
  }
  if (++rec.n > max) {
    throw new AppError(CODES.RATE_LIMITED, 'Too many requests', {
      status: 429,
      detail: `Limit is ${max} per ${Math.round(windowMs / 1000)}s for this endpoint. Retry in ${Math.ceil((rec.reset - now) / 1000)}s.`,
    });
  }
}

/* -------------------------------------------------------------- exports */

const csvCell = v => {
  const s = String(v ?? '');
  // Neutralise spreadsheet formula injection from user-supplied wallet labels.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

function toCsv(results) {
  const head = ['Wallet', 'Address', 'GTD', 'FCFS', 'Both', 'Status', 'Confidence', 'Reason', 'Sources', 'Missing', 'Last Checked'];
  const when = new Date(results.checkedAt).toISOString();
  const rows = results.results.map(r => [
    r.name, r.address, r.gtd ? 'YES' : 'NO', r.fcfs ? 'YES' : 'NO', r.both ? 'YES' : 'NO',
    r.status, r.confidence, r.reason, (r.sources || []).join('; '), (r.missing || []).join('; '), when,
  ]);
  return [head, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}

function toLists(results) {
  const pick = pred => results.results.filter(pred).map(r => r.address);
  return {
    gtd: pick(r => r.gtd),
    fcfs: pick(r => r.fcfs),
    both: pick(r => r.both),
    notEligible: pick(r => r.status === STATUS.NOT_ELIGIBLE),
    unverifiable: pick(r => r.status === STATUS.UNVERIFIABLE),
  };
}

/* --------------------------------------------------------------- routes */

const routes = [
  ['GET', /^\/api\/health$/, async () => ({
    ok: true,
    chains: Object.values(CHAINS).map(c => ({ key: c.key, id: c.id, name: c.name })),
    providers: providerCatalog(),
    ruleTypes: supportedRuleTypes(),
    indexer: { etherscan: Boolean(process.env.ETHERSCAN_API_KEY?.trim()) },
  })],

  ['GET', /^\/api\/stats$/, async () => store.stats()],

  /* wallets */
  ['GET', /^\/api\/wallets$/, async () => ({ wallets: store.listWallets() })],
  ['POST', /^\/api\/wallets$/, async (req, res, m, body) => ({ wallet: store.addWallet(body) })],
  ['POST', /^\/api\/wallets\/import$/, async (req, res, m, body) => store.importWallets(body.text)],
  ['PATCH', /^\/api\/wallets\/([\w-]+)$/, async (req, res, m, body) => ({ wallet: store.updateWallet(m[1], body) })],
  ['DELETE', /^\/api\/wallets\/([\w-]+)$/, async (req, res, m) => ({ deleted: store.deleteWallet(m[1]) })],

  /* projects */
  ['GET', /^\/api\/projects$/, async () => ({ projects: store.listProjects() })],
  ['GET', /^\/api\/projects\/([\w-]+)$/, async (req, res, m) => ({
    project: store.getProject(m[1]),
    results: store.getResults(m[1]),
  })],
  ['DELETE', /^\/api\/projects\/([\w-]+)$/, async (req, res, m) => ({ deleted: store.deleteProject(m[1]) })],

  ['POST', /^\/api\/analyze$/, async (req, res, m, body) => {
    throttle(req, 'analyze', 20, 60_000);
    const project = await analyzeUrl(body.url);
    return { project: store.saveProject(project) };
  }],

  ['POST', /^\/api\/projects\/import$/, async (req, res, m, body) => ({
    project: store.saveProject(importProject(body.definition ?? body)),
  })],

  ['POST', /^\/api\/projects\/([\w-]+)\/allowlist$/, async (req, res, m, body) => {
    const project = store.getProject(m[1]);
    const addresses = String(body.addresses || '').split(/[\s,;]+/).filter(Boolean);
    attachAllowlist(project, body.phaseId, addresses, body.label || 'User-supplied allowlist');
    return { project: store.saveProject(project) };
  }],

  /* eligibility */
  ['POST', /^\/api\/projects\/([\w-]+)\/check$/, async (req, res, m, body) => {
    throttle(req, 'check', 10, 60_000);
    const project = store.getProject(m[1]);
    const all = store.listWallets();
    const wallets = body.walletIds?.length ? all.filter(w => body.walletIds.includes(w.id)) : all;
    if (!wallets.length) {
      throw new AppError(CODES.BAD_REQUEST, 'No wallets to check', { detail: 'Add at least one wallet address under Wallets first.' });
    }
    return { results: store.saveResults(project.id, await checkEligibility(project, wallets)) };
  }],

  ['GET', /^\/api\/projects\/([\w-]+)\/results$/, async (req, res, m) => {
    const results = store.getResults(m[1]);
    if (!results) throw new AppError(CODES.NOT_FOUND, 'This project has not been checked yet', { status: 404, detail: 'Run "Recheck eligibility" to generate results.' });
    return { results };
  }],

  ['GET', /^\/api\/projects\/([\w-]+)\/export$/, async (req, res, m, body, url) => {
    const results = store.getResults(m[1]);
    if (!results) throw new AppError(CODES.NOT_FOUND, 'Nothing to export - this project has not been checked yet', { status: 404 });
    const format = url.searchParams.get('format') || 'json';
    const slug = (results.projectName || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    if (format === 'csv') {
      send(res, 200, toCsv(results), {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${slug}-eligibility.csv"`,
      });
      return null;
    }
    if (format === 'lists') return toLists(results);
    send(res, 200, JSON.stringify(results, null, 2), {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}-eligibility.json"`,
    });
    return null;
  }],
];

/* ---------------------------------------------------------- static files */

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: { code: 'FORBIDDEN', message: 'Path traversal blocked' } });
  fs.readFile(file, (err, data) => {
    if (err) {
      return send(res, 404, { error: { code: CODES.NOT_FOUND, message: `No route or file for ${pathname}` } });
    }
    send(res, 200, data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  });
}

/* ---------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
    const pathMatches = routes.map(r => [r, pathname.match(r[1])]).filter(([, m]) => m);
    const hit = pathMatches.find(([[method]]) => method === req.method);
    if (!hit) {
      if (pathMatches.length) {
        const allowed = [...new Set(pathMatches.map(([[method]]) => method))];
        throw new AppError(CODES.BAD_REQUEST, `${req.method} is not allowed on ${pathname}`, { status: 405, detail: `Use ${allowed.join(' or ')}.` });
      }
      throw new AppError(CODES.NOT_FOUND, `Unknown endpoint ${pathname}`, { status: 404 });
    }
    const [[, , handler], m] = hit;
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const out = await handler(req, res, m, body, url);
    if (out !== null) send(res, 200, out);
  } catch (err) {
    sendError(res, err);
  }
});

server.listen(PORT, () => {
  const keys = providerCatalog().filter(p => !p.ready);
  console.log(`\n  Wallet Eligibility Checker -> http://localhost:${PORT}\n`);
  console.log(`  database : ${store.dbPath()}`);
  console.log(`  indexer  : ${process.env.ETHERSCAN_API_KEY ? 'Etherscan key set' : 'no ETHERSCAN_API_KEY (wallet-age & interaction rules will report "unable to verify")'}`);
  if (keys.length) console.log(`  disabled : ${keys.map(p => `${p.name} (needs ${p.missingKeys.join(', ')})`).join(', ')}`);
  console.log('');
});

export { server };
