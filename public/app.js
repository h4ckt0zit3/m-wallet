/* Wallet Eligibility Checker - vanilla ES modules, no build step. */

const $ = sel => document.querySelector(sel);
const view = $('#view');

const state = {
  wallets: [],
  projects: [],
  health: null,
  project: null,     // currently selected project
  results: null,     // results for that project
  filter: 'ALL',
  search: '',
  walletSearch: '',
  busy: false,
};

/* ------------------------------------------------------------- helpers */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = a => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');
const fmtDate = ts => (ts ? new Date(ts).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const yn = v => `<span class="yn ${v ? 'y' : 'n'}">${v ? '✅' : '❌'}</span>`;

function toast(kind, title, detail) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t">${esc(title)}</div>${detail ? `<div class="d">${esc(detail)}</div>` : ''}`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 12000 : 5000);
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = data?.error || { message: `HTTP ${res.status}`, code: 'HTTP_ERROR' };
    const e = new Error(err.message);
    e.code = err.code;
    e.detail = err.detail;
    throw e;
  }
  return data;
}

/** Wrap an async action: disables the button, shows a spinner, reports errors. */
function action(btn, fn) {
  return async (...args) => {
    if (state.busy) return;
    state.busy = true;
    const label = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${btn.dataset.busy || 'Working…'}`; }
    try {
      await fn(...args);
    } catch (err) {
      toast('err', err.message, err.detail || err.code);
    } finally {
      state.busy = false;
      if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; }
    }
  };
}

function modal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').showModal();
}

const copy = async (text, what = 'Copied') => {
  try {
    await navigator.clipboard.writeText(text);
    toast('ok', what, `${text.split('\n').length} line(s) on the clipboard`);
  } catch {
    modal('Copy manually', `<textarea readonly>${esc(text)}</textarea>`);
  }
};

/* ------------------------------------------------------------ data load */

async function refresh() {
  const [w, p, h] = await Promise.all([api('/wallets'), api('/projects'), api('/health')]);
  state.wallets = w.wallets;
  state.projects = p.projects;
  state.health = h;
}

async function selectProject(id) {
  const { project, results } = await api(`/projects/${id}`);
  state.project = project;
  state.results = results;
  state.filter = 'ALL';
  state.search = '';
}

/* -------------------------------------------------------------- widgets */

const statusBadge = s => `<span class="badge ${s}">${s.replace('_', ' ')}</span>`;
const confBadge = c => `<span class="badge ${c === 'verified' ? 'verified' : 'unknown'}">${c === 'verified' ? 'Verified' : 'Unknown'}</span>`;

function phaseSummary(p) {
  const orig = esc(p.name);
  const conf = p.phaseConfidence || 'unknown';
  return `<span class="badge ${p.normalized}">${p.normalized}</span>
    <span>${orig}</span>
    <span class="badge ${conf}">${conf}</span>`;
}

function warningsBlock(list, cls = '') {
  if (!list?.length) return '';
  return list.map(w => `<div class="note ${cls}">${esc(w)}</div>`).join('');
}

/* ------------------------------------------------------------ dashboard */

async function renderDashboard() {
  const s = await api('/stats');
  const providers = state.health.providers;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="sub">Public-data eligibility checking for NFT mints.</p></div>
      <button class="primary" data-go="#/projects">Analyze a mint link</button>
    </div>

    <div class="grid stats">
      <div class="stat"><div class="k">Wallets saved</div><div class="v">${s.wallets}</div></div>
      <div class="stat"><div class="k">Projects analyzed</div><div class="v">${s.projects}</div></div>
      <div class="stat"><div class="k">Rule types supported</div><div class="v">${state.health.ruleTypes.length}</div></div>
      <div class="stat ${s.lastChecked ? '' : 'none'}"><div class="k">Last check</div><div class="v" style="font-size:15px;padding-top:8px">${s.lastChecked ? fmtDate(s.lastChecked) : 'never'}</div></div>
    </div>

    <div class="grid two">
      <div class="card">
        <h2>Recently analyzed</h2>
        ${s.recent.length ? s.recent.map(p => `
          <div class="card tight" style="margin-bottom:8px;cursor:pointer" data-project="${p.id}">
            <div class="row" style="justify-content:space-between">
              <div>
                <b>${esc(p.name)}</b>
                <div class="sub">${esc(p.platform)} · ${esc(p.chain)} · ${p.phases} phase(s)</div>
              </div>
              <div style="text-align:right">
                ${p.summary ? `<span class="badge GTD">${p.summary.gtd} GTD</span> <span class="badge FCFS">${p.summary.fcfs} FCFS</span>` : '<span class="badge neutral">not checked</span>'}
                <div class="sub" style="margin-top:4px">${p.checkedAt ? fmtDate(p.checkedAt) : ''}</div>
              </div>
            </div>
          </div>`).join('') : '<p class="sub">Nothing yet. Paste a mint link under Projects.</p>'}
      </div>

      <div class="card">
        <h2>Data sources</h2>
        ${providers.map(p => `
          <div class="row" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line-soft)">
            <div><b>${esc(p.name)}</b><div class="sub mono" style="font-size:11px">${esc(p.urlHint || '')}</div></div>
            <span class="badge ${p.ready ? 'verified' : 'unknown'}">${p.ready ? 'ready' : `needs ${p.missingKeys.join(', ')}`}</span>
          </div>`).join('')}
        <div class="row" style="justify-content:space-between;padding:7px 0">
          <div><b>Etherscan indexer</b><div class="sub" style="font-size:11px">wallet age · contract interaction</div></div>
          <span class="badge ${state.health.indexer.etherscan ? 'verified' : 'unknown'}">${state.health.indexer.etherscan ? 'ready' : 'no ETHERSCAN_API_KEY'}</span>
        </div>
      </div>
    </div>`;
}

/* -------------------------------------------------------------- wallets */

function renderWallets() {
  const q = state.walletSearch.toLowerCase();
  const list = state.wallets.filter(w => !q || w.name.toLowerCase().includes(q) || w.address.toLowerCase().includes(q));

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Wallets</h1><p class="sub">${state.wallets.length} saved · public addresses only, no keys or signatures.</p></div>
      <div class="row">
        <button id="btn-import">Bulk import</button>
        <button class="primary" id="btn-add">Add wallet</button>
      </div>
    </div>

    <div class="card tight">
      <input type="search" id="wallet-search" placeholder="Search by name or address…" value="${esc(state.walletSearch)}">
    </div>

    ${list.length ? `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Address</th><th>Added</th><th style="width:120px"></th></tr></thead>
        <tbody>${list.map(w => `
          <tr>
            <td><b>${esc(w.name)}</b></td>
            <td class="mono" title="${esc(w.address)}">${esc(w.address)}</td>
            <td class="sub">${fmtDate(w.addedAt)}</td>
            <td>
              <div class="row" style="gap:6px;justify-content:flex-end">
                <button class="sm ghost" data-rename="${w.id}">Rename</button>
                <button class="sm ghost danger" data-del="${w.id}">Delete</button>
              </div>
            </td>
          </tr>`).join('')}</tbody>
      </table>
    </div>` : `<div class="card empty"><h3>${state.wallets.length ? 'No wallets match that search' : 'No wallets yet'}</h3><p>Add addresses one at a time, or paste a list with Bulk import.</p></div>`}`;

  $('#wallet-search').oninput = e => { state.walletSearch = e.target.value; renderWallets(); };

  $('#btn-add').onclick = () => modal('Add wallet', `
    <label class="field"><span>Label</span><input type="text" id="w-name" placeholder="Main"></label>
    <label class="field"><span>Public address</span><input type="text" id="w-addr" placeholder="0x…" spellcheck="false"></label>
    <div class="note">This tool only ever needs the public address. Never paste a private key or seed phrase anywhere.</div>
    <div class="row end"><button class="primary" id="w-save">Save wallet</button></div>`);

  $('#btn-import').onclick = () => modal('Bulk import wallets', `
    <label class="field"><span>One wallet per line — <code>0xabc…</code>, <code>Label, 0xabc…</code> or <code>0xabc…, Label</code></span>
      <textarea id="w-bulk" placeholder="Main, 0x1111111111111111111111111111111111111111&#10;Alpha 1, 0x2222222222222222222222222222222222222222"></textarea></label>
    <div class="row end"><button class="primary" id="w-import">Import</button></div>`);

  view.onclick = async e => {
    const del = e.target.dataset.del;
    const ren = e.target.dataset.rename;
    if (del) {
      const w = state.wallets.find(x => x.id === del);
      if (!confirm(`Delete "${w.name}" (${short(w.address)})?`)) return;
      await action(e.target, async () => {
        await api(`/wallets/${del}`, { method: 'DELETE' });
        await refresh();
        renderWallets();
        toast('ok', 'Wallet deleted');
      })();
    }
    if (ren) {
      const w = state.wallets.find(x => x.id === ren);
      const name = prompt('New label', w.name);
      if (!name) return;
      await action(e.target, async () => {
        await api(`/wallets/${ren}`, { method: 'PATCH', body: { name } });
        await refresh();
        renderWallets();
      })();
    }
  };
}

/* ------------------------------------------------------------- projects */

function renderProjects() {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Projects</h1><p class="sub">Paste a mint or collection link. Supported: ${state.health.providers.map(p => esc(p.name)).join(', ')}.</p></div>
    </div>

    <div class="card">
      <label class="field"><span>Mint / collection URL, or a contract address</span>
        <input type="text" id="analyze-url" spellcheck="false" placeholder="https://opensea.io/collection/…   ·   https://magiceden.io/collections/base/0x…   ·   0xContract   ·   base:0xContract"></label>
      <div class="row end">
        <button id="btn-manual">Define manually (JSON)</button>
        <button class="primary" id="btn-analyze" data-busy="Analyzing…">Analyze</button>
      </div>
      ${state.health.providers.filter(p => !p.ready).map(p => `<div class="note" style="margin-top:10px"><b>${esc(p.name)}</b> is disabled: set ${esc(p.missingKeys.join(', '))} in <span class="mono">.env</span> and restart. Contract addresses work without any key.</div>`).join('')}
    </div>

    ${state.projects.length ? `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Project</th><th>Platform</th><th>Chain</th><th>Contract</th><th>Phases</th><th>Analyzed</th><th></th></tr></thead>
        <tbody>${state.projects.map(p => `
          <tr class="clickable" data-open="${p.id}">
            <td><b>${esc(p.name)}</b>${p.warnings?.length ? ' <span class="badge UNVERIFIABLE">⚠ ' + p.warnings.length + '</span>' : ''}</td>
            <td><span class="badge neutral">${esc(p.platform)}</span></td>
            <td class="sub">${esc(p.chain)}</td>
            <td class="mono">${esc(short(p.contract))}</td>
            <td>${p.phases.map(ph => `<span class="badge ${ph.normalized}">${ph.normalized}</span>`).join(' ') || '<span class="sub">none found</span>'}</td>
            <td class="sub">${fmtDate(p.createdAt)}</td>
            <td><button class="sm ghost danger" data-del="${p.id}">Delete</button></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>` : '<div class="card empty"><h3>No projects analyzed yet</h3><p>Paste a link above to get started.</p></div>'}`;

  const urlInput = $('#analyze-url');
  const analyze = action($('#btn-analyze'), async () => {
    const { project } = await api('/analyze', { method: 'POST', body: { url: urlInput.value } });
    await refresh();
    await selectProject(project.id);
    location.hash = '#/eligibility';
    toast('ok', `Analyzed ${project.name}`, `${project.phases.length} phase(s) found on ${project.chain}`);
  });
  $('#btn-analyze').onclick = analyze;
  urlInput.onkeydown = e => { if (e.key === 'Enter') analyze(); };

  $('#btn-manual').onclick = () => modal('Define a project manually', `
    <p class="sub">For mints whose phases live in Discord or a spreadsheet. The engine checks these rules exactly like platform-sourced ones.</p>
    <label class="field"><span>Project JSON</span><textarea id="p-json" style="min-height:260px">${esc(SAMPLE_JSON)}</textarea></label>
    <div class="row end"><button class="primary" id="p-import">Import project</button></div>`);

  view.onclick = async e => {
    const del = e.target.dataset.del;
    if (del) {
      e.stopPropagation();
      if (!confirm('Delete this project and its results?')) return;
      return action(e.target, async () => {
        await api(`/projects/${del}`, { method: 'DELETE' });
        await refresh();
        renderProjects();
      })();
    }
    const row = e.target.closest('[data-open]');
    if (row) {
      await selectProject(row.dataset.open);
      location.hash = '#/eligibility';
    }
  };
}

/* ---------------------------------------------------------- eligibility */

function renderEligibility() {
  const p = state.project;
  if (!p) {
    view.innerHTML = `<div class="page-head"><div><h1>Eligibility</h1><p class="sub">Pick a project to check your wallets against.</p></div></div>
      <div class="card empty"><h3>No project selected</h3><p>Analyze a mint link under <a href="#/projects">Projects</a> first.</p></div>`;
    return;
  }

  const r = state.results;
  const s = r?.summary;
  const rows = r ? filterRows(r.results) : [];

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(p.name)}</h1>
        <p class="sub">
          ${esc(p.platform)} · ${esc(p.chain)} ·
          <span class="mono">${esc(p.contract || 'no contract')}</span>
          ${p.sourceUrl ? ` · <a href="${esc(p.sourceUrl)}" target="_blank" rel="noreferrer noopener">source ↗</a>` : ''}
        </p>
      </div>
      <div class="row">
        <select id="project-picker" style="width:auto;min-width:190px">
          ${state.projects.map(x => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
        </select>
        <button class="primary" id="btn-check" data-busy="Checking…">${r ? 'Recheck eligibility' : 'Check eligibility'}</button>
      </div>
    </div>

    ${warningsBlock(p.warnings)}

    <div class="card">
      <h2>Mint phases (${p.phases.length})</h2>
      ${p.phases.length ? p.phases.map(ph => `
        <details class="phase">
          <summary>${phaseSummary(ph)}${ph.walletLimit ? `<span class="badge neutral">limit ${ph.walletLimit}</span>` : ''}</summary>
          <div class="body">
            <dl class="kv">
              <dt>Original phase</dt><dd>${esc(ph.name)}</dd>
              <dt>Normalized</dt><dd>${ph.normalized} <span class="sub">(${esc(ph.phaseConfidence)})</span></dd>
              <dt>Mapping note</dt><dd>${esc(ph.mappingNote || '—')}</dd>
              <dt>Starts</dt><dd>${fmtDate(ph.startTime)}</dd>
              <dt>Ends</dt><dd>${fmtDate(ph.endTime)}</dd>
              <dt>Per-wallet limit</dt><dd>${ph.walletLimit ?? '—'}</dd>
              <dt>Requirements</dt><dd>${ph.rules.map(rule => `<div>• <b>${esc(rule.type)}</b> ${esc(ruleDesc(rule))}</div>`).join('') || '<span class="sub">none published</span>'}</dd>
            </dl>
            ${ph.note ? `<div class="note" style="margin-top:8px">${esc(ph.note)}</div>` : ''}
            ${ph.rules.some(x => (x.type === 'merkle' || x.type === 'allowlist' || x.type === 'snapshot') && !x.addresses?.length)
              ? `<div class="row" style="margin-top:8px"><button class="sm" data-attach="${esc(ph.id)}">Attach allowlist addresses</button>
                 ${p.attachedAllowlists?.[ph.id] ? `<span class="badge verified">${p.attachedAllowlists[ph.id].count} attached</span>` : ''}</div>` : ''}
          </div>
        </details>`).join('')
      : '<p class="sub">No mint phases could be read from public data for this project. See the warnings above for exactly what was missing.</p>'}
      ${p.findings?.length ? `<div class="sub" style="margin-top:10px"><b>Verified on-chain:</b> ${p.findings.map(esc).join(' · ')}</div>` : ''}
    </div>

    ${r ? `
    <div class="grid stats">
      <div class="stat"><div class="k">Wallets checked</div><div class="v">${s.walletsChecked}</div></div>
      <div class="stat gtd"><div class="k">GTD eligible</div><div class="v">${s.gtd}</div></div>
      <div class="stat fcfs"><div class="k">FCFS eligible</div><div class="v">${s.fcfs}</div></div>
      <div class="stat both"><div class="k">Both</div><div class="v">${s.both}</div></div>
      <div class="stat none"><div class="k">Not eligible</div><div class="v">${s.notEligible}</div></div>
      <div class="stat warn"><div class="k">Unable to verify</div><div class="v">${s.unverifiable}</div></div>
    </div>

    <div class="card tight">
      <div class="row" style="justify-content:space-between">
        <div class="chips" id="filters">
          ${['ALL', 'GTD', 'FCFS', 'BOTH', 'NOT_ELIGIBLE', 'UNVERIFIABLE'].map(f =>
            `<button class="chip ${state.filter === f ? 'active' : ''}" data-filter="${f}">${f.replace('_', ' ')}</button>`).join('')}
        </div>
        <div class="sub">Last checked: <b>${fmtDate(r.checkedAt)}</b></div>
      </div>
      <div class="row" style="margin-top:10px">
        <input class="grow" type="search" id="res-search" placeholder="Search wallet name or address…" value="${esc(state.search)}">
        <button class="sm" data-export="csv">Export CSV</button>
        <button class="sm" data-export="json">Export JSON</button>
        <button class="sm" data-copy="gtd">Copy GTD list</button>
        <button class="sm" data-copy="fcfs">Copy FCFS list</button>
        <button class="sm" data-copy="both">Copy Both list</button>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr><th>Wallet</th><th>Address</th><th>GTD</th><th>FCFS</th><th>Both</th><th>Status</th><th>Confidence</th><th>Reason</th></tr></thead>
        <tbody>${rows.length ? rows.map(w => `
          <tr class="clickable" data-wallet="${esc(w.walletId)}">
            <td><b>${esc(w.name)}</b></td>
            <td class="mono">${esc(short(w.address))}</td>
            <td>${yn(w.gtd)}</td><td>${yn(w.fcfs)}</td><td>${yn(w.both)}</td>
            <td>${statusBadge(w.status)}</td>
            <td>${confBadge(w.confidence)}</td>
            <td class="reason">${esc(truncate(w.reason, 190))}</td>
          </tr>`).join('') : '<tr><td colspan="8" class="empty">No wallets match this filter.</td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="sub" style="margin-top:10px">Click any row for the full per-phase evidence trail.</p>
    ` : `<div class="card empty"><h3>Not checked yet</h3><p>Run the check to evaluate all ${state.wallets.length} saved wallet(s) against these phases.</p></div>`}`;

  wireEligibility();
}

const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

function ruleDesc(rule) {
  switch (rule.type) {
    case 'open': return 'open to everyone';
    case 'allowlist': return rule.addresses?.length ? `${rule.addresses.length} addresses attached` : 'address list not published';
    case 'merkle': return `${rule.root ? `root ${rule.root.slice(0, 12)}…` : 'root unknown'}${rule.addresses?.length ? ` · ${rule.addresses.length} addresses attached` : ' · address list not published'}`;
    case 'nft-holding': return `hold ≥ ${rule.min ?? 1} of ${rule.label || rule.contract}`;
    case 'token-holding': return `hold ≥ ${rule.min ?? 1} of ${rule.label || rule.contract}`;
    case 'previous-mint': return `participated in ${rule.label || rule.contract}`;
    case 'contract-interaction': return `interacted with ${rule.label || rule.contract}`;
    case 'wallet-age': return `wallet at least ${rule.minDays} days old`;
    case 'snapshot': return `snapshot${rule.blockNumber ? ` @ block ${rule.blockNumber}` : ''}${rule.addresses?.length ? ` · ${rule.addresses.length} addresses attached` : ' · list not published'}`;
    case 'external': return `off-platform verification (${rule.kind})`;
    default: return rule.note || '';
  }
}

function filterRows(rows) {
  const q = state.search.toLowerCase();
  return rows.filter(w => {
    if (q && !w.name.toLowerCase().includes(q) && !w.address.toLowerCase().includes(q)) return false;
    switch (state.filter) {
      case 'GTD': return w.gtd;
      case 'FCFS': return w.fcfs;
      case 'BOTH': return w.both;
      case 'NOT_ELIGIBLE': return w.status === 'NOT_ELIGIBLE';
      case 'UNVERIFIABLE': return w.status === 'UNVERIFIABLE';
      default: return true;
    }
  });
}

function wireEligibility() {
  const p = state.project;

  $('#project-picker').onchange = async e => {
    await selectProject(e.target.value);
    renderEligibility();
  };

  $('#btn-check').onclick = action($('#btn-check'), async () => {
    const { results } = await api(`/projects/${p.id}/check`, { method: 'POST', body: {} });
    state.results = results;
    renderEligibility();
    toast('ok', 'Eligibility checked', `${results.summary.gtd} GTD · ${results.summary.fcfs} FCFS · ${results.summary.unverifiable} unverifiable`);
  });

  const search = $('#res-search');
  if (search) search.oninput = e => { state.search = e.target.value; renderEligibility(); $('#res-search').focus(); };

  view.onclick = async e => {
    const f = e.target.dataset.filter;
    if (f) { state.filter = f; return renderEligibility(); }

    const ex = e.target.dataset.export;
    if (ex) { window.open(`/api/projects/${p.id}/export?format=${ex}`, '_blank'); return; }

    const c = e.target.dataset.copy;
    if (c) {
      const lists = await api(`/projects/${p.id}/export?format=lists`);
      const list = lists[c] || [];
      if (!list.length) return toast('info', `No ${c.toUpperCase()} wallets`, 'Nothing to copy.');
      return copy(list.join('\n'), `${c.toUpperCase()} wallets copied`);
    }

    const attach = e.target.dataset.attach;
    if (attach) return promptAllowlist(attach);

    const row = e.target.closest('[data-wallet]');
    if (row) showWalletDetail(row.dataset.wallet);
  };
}

function promptAllowlist(phaseId) {
  modal('Attach allowlist addresses', `
    <p class="sub">Paste the published allowlist for this phase. If the phase has an on-chain merkle root, the engine will only trust this list once it reproduces that exact root — a stale or partial list is reported as unverifiable rather than treated as truth.</p>
    <label class="field"><span>Addresses (one per line, or comma separated)</span><textarea id="al-text" placeholder="0x1111…&#10;0x2222…"></textarea></label>
    <label class="field"><span>Where did this list come from?</span><input type="text" id="al-label" placeholder="Project Discord announcement, 18 Aug"></label>
    <div class="row end"><button class="primary" id="al-save">Attach</button></div>`);

  $('#al-save').onclick = action($('#al-save'), async () => {
    const { project } = await api(`/projects/${state.project.id}/allowlist`, {
      method: 'POST',
      body: { phaseId, addresses: $('#al-text').value, label: $('#al-label').value || 'User-supplied allowlist' },
    });
    state.project = project;
    $('#modal').close();
    renderEligibility();
    toast('ok', 'Allowlist attached', 'Re-run the check to use it.');
  });
}

function showWalletDetail(walletId) {
  const w = state.results.results.find(x => x.walletId === walletId);
  if (!w) return;
  modal(`${w.name} — ${short(w.address)}`, `
    <dl class="kv">
      <dt>Address</dt><dd class="mono">${esc(w.address)}</dd>
      <dt>Status</dt><dd>${statusBadge(w.status)}</dd>
      <dt>Eligibility</dt><dd>GTD ${yn(w.gtd)} · FCFS ${yn(w.fcfs)} · Both ${yn(w.both)}</dd>
      <dt>Confidence</dt><dd>${confBadge(w.confidence)}</dd>
      <dt>Last checked</dt><dd>${fmtDate(state.results.checkedAt)}</dd>
      <dt>Evidence source</dt><dd>${w.sources?.length ? w.sources.map(esc).join('<br>') : '—'}</dd>
    </dl>
    <h2 style="margin-top:18px">Per-phase result</h2>
    ${w.phases.map(ph => `
      <details class="phase" open>
        <summary>${phaseSummary(ph)}<span class="badge ${ph.verdict === 'ELIGIBLE' ? 'GTD' : ph.verdict === 'UNVERIFIABLE' ? 'UNVERIFIABLE' : 'NOT_ELIGIBLE'}">${ph.verdict.replace('_', ' ')}</span></summary>
        <div class="body">
          <p>${esc(ph.reason)}</p>
          ${ph.checks.map(c => `<div>• <b>${esc(c.rule)}</b> — ${c.pass === true ? '✅' : c.pass === false ? '❌' : '⚠️'} ${esc(c.reason)}<div class="sub" style="font-size:11px">source: ${esc(c.source || '—')}</div></div>`).join('')}
          ${ph.missing?.length ? `<div class="note" style="margin-top:8px"><b>Missing to verify:</b> ${ph.missing.map(esc).join(' · ')}</div>` : ''}
        </div>
      </details>`).join('') || '<p class="sub">No phases were evaluated.</p>'}
    ${w.missing?.length ? `<div class="note">${w.missing.map(esc).join('<br>')}</div>` : ''}`);
}

/* ------------------------------------------------------------- settings */

function renderSettings() {
  const h = state.health;
  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p class="sub">Configuration is read from <span class="mono">.env</span> on the server. Keys never reach the browser.</p></div></div>

    <div class="card">
      <h2>Providers</h2>
      <div class="table-wrap"><table style="min-width:520px">
        <thead><tr><th>Provider</th><th>Status</th><th>Accepts</th></tr></thead>
        <tbody>${h.providers.map(p => `<tr>
          <td><b>${esc(p.name)}</b></td>
          <td><span class="badge ${p.ready ? 'verified' : 'unknown'}">${p.ready ? 'ready' : `needs ${esc(p.missingKeys.join(', '))}`}</span></td>
          <td class="mono">${esc(p.urlHint || '')}</td></tr>`).join('')}
          <tr><td><b>Etherscan indexer</b></td>
            <td><span class="badge ${h.indexer.etherscan ? 'verified' : 'unknown'}">${h.indexer.etherscan ? 'ready' : 'not configured'}</span></td>
            <td class="sub">Required for wallet-age and contract-interaction rules</td></tr>
        </tbody></table></div>
    </div>

    <div class="grid two">
      <div class="card">
        <h2>Supported chains</h2>
        <div class="chips">${h.chains.map(c => `<span class="chip">${esc(c.name)} <span class="sub">#${c.id}</span></span>`).join('')}</div>
        <p class="sub" style="margin-top:10px">Add another EVM chain in <span class="mono">lib/chains.js</span>.</p>
      </div>
      <div class="card">
        <h2>Supported rule types</h2>
        <div class="chips">${h.ruleTypes.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        <p class="sub" style="margin-top:10px">Add another in <span class="mono">lib/engine.js</span> → <span class="mono">EVALUATORS</span>.</p>
      </div>
    </div>

    <div class="card">
      <h2>Security posture</h2>
      <div class="note ok">This app never asks for private keys, seed phrases or passwords, never connects to a wallet, and never signs or sends a transaction. It reads public blockchain data and public platform APIs only.</div>
      <div class="note">Requirements behind Discord roles, X follows, logins, captchas or private APIs are reported as <b>Unable to verify</b> with the missing information named. No protection is bypassed.</div>
    </div>`;
}

/* --------------------------------------------------------------- router */

const ROUTES = {
  '#/dashboard': renderDashboard,
  '#/wallets': renderWallets,
  '#/projects': renderProjects,
  '#/eligibility': renderEligibility,
  '#/settings': renderSettings,
};

async function route() {
  const hash = ROUTES[location.hash] ? location.hash : '#/dashboard';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === hash));
  view.onclick = null;
  try {
    await ROUTES[hash]();
  } catch (err) {
    view.innerHTML = `<div class="card"><div class="note err"><b>${esc(err.message)}</b>${err.detail ? `<br>${esc(err.detail)}` : ''}</div></div>`;
  }
}

/* Delegated handlers for elements rendered inside modals. */
document.addEventListener('click', async e => {
  const id = e.target.id;
  if (id === 'w-save') {
    await action(e.target, async () => {
      await api('/wallets', { method: 'POST', body: { name: $('#w-name').value, address: $('#w-addr').value } });
      $('#modal').close();
      await refresh();
      renderWallets();
      toast('ok', 'Wallet saved');
    })();
  }
  if (id === 'w-import') {
    await action(e.target, async () => {
      const out = await api('/wallets/import', { method: 'POST', body: { text: $('#w-bulk').value } });
      $('#modal').close();
      await refresh();
      renderWallets();
      toast(out.failed.length ? 'info' : 'ok', `Imported ${out.added.length}/${out.total}`,
        out.failed.length ? out.failed.map(f => `line ${f.line}: ${f.reason}`).join(' · ') : '');
    })();
  }
  if (id === 'p-import') {
    await action(e.target, async () => {
      const { project } = await api('/projects/import', { method: 'POST', body: { definition: JSON.parse($('#p-json').value) } });
      $('#modal').close();
      await refresh();
      await selectProject(project.id);
      location.hash = '#/eligibility';
      toast('ok', `Imported ${project.name}`);
    })();
  }
  const go = e.target.dataset.go;
  if (go) location.hash = go;
  const pid = e.target.closest('[data-project]')?.dataset.project;
  if (pid) { await selectProject(pid); location.hash = '#/eligibility'; }
});

const SAMPLE_JSON = JSON.stringify({
  name: 'Example Mint',
  chain: 'ethereum',
  contract: '0x0000000000000000000000000000000000000000',
  sourceUrl: 'https://example.com/mint',
  phases: [
    { name: 'OG / Guaranteed', startTime: '2026-09-01T18:00:00Z', walletLimit: 2, rules: [{ type: 'allowlist', addresses: ['0x1111111111111111111111111111111111111111'], source: 'Project Discord' }] },
    { name: 'FCFS', startTime: '2026-09-01T19:00:00Z', walletLimit: 1, rules: [{ type: 'nft-holding', contract: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', min: 1, label: 'BAYC' }] },
    { name: 'Public', startTime: '2026-09-01T20:00:00Z', rules: [{ type: 'open' }] },
  ],
}, null, 2);

window.addEventListener('hashchange', route);
refresh().then(route).catch(err => {
  view.innerHTML = `<div class="card"><div class="note err"><b>Could not reach the API.</b><br>${esc(err.message)}</div></div>`;
});
