# Wallet Eligibility Checker

Check a batch of public wallet addresses against an NFT mint's phases and get a
straight answer per wallet: **GTD**, **FCFS**, **Both**, **Not eligible**, or
**Unable to verify** — with the reason, the data source and a confidence level
on every row.

It never asks for a private key, seed phrase, password or signature, never
connects to a wallet, and never bypasses a login, captcha or Discord gate. When
eligibility depends on something private, it says so and names exactly what is
missing instead of guessing.

---

# Part 1 — How to use it

## 1. Install and run

You need **Node 20 or newer** (`node -v` to check).

```bash
cd M_WALLET
npm install          # installs ethers, the only dependency
npm run seed         # optional: loads 5 demo wallets + 2 demo projects
npm start            # starts the server
```

Then open **<http://localhost:8787>** in a browser.

The startup banner tells you what is and isn't configured:

```
  Wallet Eligibility Checker -> http://localhost:8787

  database : .../data/db.json
  indexer  : no ETHERSCAN_API_KEY (wallet-age & interaction rules will report "unable to verify")
  disabled : OpenSea (needs OPENSEA_API_KEY)
```

That is a healthy first run. **No API keys are required** — contract addresses,
Magic Eden links and manual project definitions all work without any. Keys only
unlock extra sources; see [Part 3](#part-3--configuration).

Other commands:

| Command | What it does |
|---|---|
| `npm start` | Run the server on port 8787 (`PORT=3000 npm start` to change). |
| `npm run dev` | Same, but restarts when you edit a file. |
| `npm test` | Runs the engine test suite (11 assertions). |
| `npm run seed` | Loads the demo wallets and projects. Safe to re-run. |

Stop the server with `Ctrl+C`.

## 2. Take the 60-second tour

If you ran `npm run seed`, do this first — it needs no network and no keys, and
shows you every result type at once:

1. Click **Eligibility** in the sidebar.
2. In the project dropdown pick **Sample Drop (offline demo)**.
3. Click **Check eligibility**.

You should see:

| Wallet | GTD | FCFS | Both | Status | Why |
|---|---|---|---|---|---|
| Main | ✅ | ❌ | ❌ | GTD | on the OG allowlist |
| Alpha 1 | ❌ | ✅ | ❌ | FCFS | in the holder snapshot |
| Alpha 2 | ✅ | ✅ | ✅ | BOTH | in both lists |
| Alpha 3 | ❌ | ❌ | ❌ | UNVERIFIABLE | a Discord raffle phase can't be checked publicly |
| Burner | ❌ | ❌ | ❌ | UNVERIFIABLE | same |

Click any row to open the full evidence trail. Now do it with your own data.

## 3. Add your wallets

Sidebar → **Wallets**.

**One at a time:** click **Add wallet**, give it a label (`Main`, `Alpha 1`) and
paste the **public `0x` address**. Nothing else is ever needed.

**In bulk:** click **Bulk import** and paste one wallet per line. All of these
work, mixed freely:

```
0x1111111111111111111111111111111111111111
Main, 0x2222222222222222222222222222222222222222
0x3333333333333333333333333333333333333333, Alpha 1
Alpha 2	0x4444444444444444444444444444444444444444
```

Separators can be a comma, semicolon or tab. Up to 1000 lines per import.

Import reports **per line**, so a typo never silently vanishes:

```
Imported 49/50 — line 12: "0xnope" is not a valid EVM address
```

Addresses are validated and EIP-55 checksummed before saving. A mixed-case
address whose checksum doesn't match is **rejected as a likely typo** — paste it
all-lowercase if you're sure it's right. Duplicates are refused with the name of
the existing entry.

Use the search box to filter by name or address; **Rename** and **Delete** are on
each row.

> ⚠️ This tool only ever needs public addresses. If any site or tool asks for a
> seed phrase or private key to "check eligibility", it is stealing from you.

## 4. Analyze a mint

Sidebar → **Projects**. Paste into the box and hit **Analyze**:

| What you can paste | Works without an API key? |
|---|---|
| `0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D` | ✅ yes |
| `base:0xAbC…` (contract on another chain) | ✅ yes |
| `https://etherscan.io/address/0xAbC…` | ✅ yes |
| `https://magiceden.io/collections/ethereum/0xAbC…` | ✅ yes |
| `https://opensea.io/collection/<slug>` | needs `OPENSEA_API_KEY` |
| `https://opensea.io/item/ethereum/0xAbC…/1234` | needs `OPENSEA_API_KEY` |

The tool resolves the link to the underlying **collection and contract** — it
does not treat it as a web page. You then land on the Eligibility screen showing
what it found: project name, contract, chain, and every mint phase it could read.

**If it can't find phases, it tells you so** rather than inventing them:

> No mint phase configuration is readable on-chain for this contract. Its phases
> are most likely enforced by an off-chain API or a signature-based minter.

That is a real answer, not a failure. See [step 6](#6-when-a-phase-cant-be-verified)
for what to do next.

**No link at all?** Click **Define manually (JSON)** and describe the phases
yourself — see [Part 4](#part-4--defining-a-project-by-hand).

## 5. Check your wallets and read the results

Press **Check eligibility**. Every saved wallet is evaluated against every phase.

**Top of the page — the summary:**

```
Wallets checked 25   GTD 7   FCFS 11   Both 5   Not eligible 7   Unable to verify 2
```

**Below it — one row per wallet**, with filter chips (`ALL`, `GTD`, `FCFS`,
`BOTH`, `NOT ELIGIBLE`, `UNVERIFIABLE`) and a search box for names/addresses.

### What each status means

| Status | Meaning |
|---|---|
| **GTD** | Guaranteed a mint allocation in a guaranteed phase. |
| **FCFS** | Can mint in an FCFS phase — allocation depends on supply and speed, **not** guaranteed. |
| **BOTH** | Qualifies for a guaranteed phase *and* an FCFS phase. |
| **PUBLIC** | Not on any list, but the public phase is open to everyone. |
| **NOT ELIGIBLE** | Provably fails every phase that could be checked. |
| **UNVERIFIABLE** | ⚠️ Something required is not publicly accessible. **Not the same as "no".** |

### The confidence column

- **Verified** — proven from public data (an on-chain read, or a list confirmed against the on-chain merkle root).
- **Unknown** — at least one requirement couldn't be checked publicly.

### Click any row for the evidence

The detail panel shows, per phase: the verdict, every individual rule check with
✅/❌/⚠️, the exact data source for each (`On-chain balanceOf() on ethereum`,
`Etherscan transaction history`, `Project Discord announcement, 18 Aug 2026`),
and — for anything unresolved — a **Missing to verify** line naming precisely
what would be needed.

### Phase names vs GTD/FCFS

Each phase shows the **original project name next to the normalized category**,
plus how the mapping was made:

```
GTD    OG / Guaranteed    mapped        ← keyword matched directly
FCFS   WL                 inferred      ← guessed from phase ordering, verify this one
```

An `inferred` badge means the project didn't state whether the phase is
guaranteed — check the project's own announcement before trusting it. Full rules
in [Part 5](#part-5--how-gtdfcfs-is-decided).

## 6. When a phase can't be verified

`UNVERIFIABLE` appears when a requirement is genuinely not public — a Discord
role, an X follow, a site login, a captcha, a private API, or a merkle root whose
address list the project never published.

The tool will not scrape or bypass any of these. Instead, if you can get the list
yourself:

1. Expand the phase on the Eligibility screen.
2. Click **Attach allowlist addresses**.
3. Paste the addresses (one per line or comma-separated) and note where they came from.
4. Click **Attach**, then **Recheck eligibility**.

**The list is not taken on faith.** If the phase publishes a merkle root
on-chain, the engine rebuilds the tree under four common hashing conventions and
only trusts your list if one of them reproduces that exact root. A stale, partial
or wrong-phase list stays `UNVERIFIABLE`:

> The supplied address list does not reproduce the merkle root published
> on-chain, so it cannot be trusted for this phase.

That is the whole point of the tool — it would rather say "I don't know" than
hand you a false ✅.

## 7. Export

On the results toolbar:

| Button | Output |
|---|---|
| **Export CSV** | Full table: wallet, address, GTD/FCFS/Both, status, confidence, reason, sources, missing info, timestamp. |
| **Export JSON** | The complete result object including every per-phase check. |
| **Copy GTD list** | Just the GTD addresses, one per line, straight to your clipboard. |
| **Copy FCFS list** | Same for FCFS. |
| **Copy Both list** | Same for wallets in both. |

The copy buttons give you a paste-ready block:

```
0x1111111111111111111111111111111111111111
0x3333333333333333333333333333333333333333
```

## 8. Recheck

Allowlists and snapshots change. Press **Recheck eligibility** any time — it
re-fetches all public data and overwrites the results. The toolbar always shows
when the current results were produced:

```
Last checked: 25 Aug 2026, 10:32 PM
```

## 9. Where things live

- Sidebar → **Dashboard** — quick stats, recently analyzed projects, and which data sources are ready.
- Sidebar → **Settings** — provider status, supported chains, supported rule types, security posture.
- All data is stored in **`data/db.json`** (public addresses, labels and results only). Delete that file to reset everything, then `npm run seed` for the demo data back.

## 10. Troubleshooting

| What you see | What it means / what to do |
|---|---|
| `OpenSea link analysis needs an OpenSea API key` | Put `OPENSEA_API_KEY` in `.env` and restart — or paste the contract address instead, which needs no key. |
| `foundation.app is not a supported mint platform` | Not built in. Paste the collection's contract address, or add a provider ([Part 6](#part-6--extending-it)). |
| `"0xzz" is not a valid EVM address` | Typo. Addresses are `0x` + exactly 40 hex characters. |
| `failed the EIP-55 checksum` | Mixed-case address doesn't match its checksum — usually a typo. Paste it all-lowercase to skip the check. |
| `RPC call failed while …` | The free public RPC is rate limiting. Set `RPC_ETHEREUM` in `.env` to an Alchemy/Infura URL. |
| `Magic Eden launchpad links cannot be resolved from public data` | `/launchpad/<symbol>` URLs need Magic Eden's private API. Open the collection page (`/collections/<chain>/0x…`) and paste that. |
| `No mint phase configuration is readable on-chain` | The contract publishes nothing about its phases. Define it manually ([Part 4](#part-4--defining-a-project-by-hand)). |
| `This project has not been checked yet` | Press **Check eligibility** first. |
| `No wallets to check` | Add at least one wallet under **Wallets**. |
| `Too many requests` | Built-in rate limit (20 analyses / 10 checks per minute). Wait a few seconds. |
| Browser shows "Could not reach the API" | The server isn't running. `npm start` in the project folder. |

---

# Part 2 — What it actually verifies

| Requirement type | How it's checked | Needs |
|---|---|---|
| `open` | Public phase, no requirement | — |
| `allowlist` | Address is in a published list | the list |
| `merkle` | Address is a leaf of a tree **whose root matches the on-chain root** | root + list |
| `nft-holding` | `balanceOf()` on ERC-721 / ERC-1155 | RPC |
| `token-holding` | `balanceOf()` + `decimals()` on ERC-20 | RPC |
| `previous-mint` | Current holding; failing that, a tx to that contract | RPC (+ Etherscan) |
| `contract-interaction` | A successful tx from wallet to contract | `ETHERSCAN_API_KEY` |
| `wallet-age` | Timestamp of first outgoing tx | `ETHERSCAN_API_KEY` |
| `snapshot` | Published snapshot list; otherwise unverifiable | the list |
| `external` | Discord / X / login / captcha / signature / private API | **always unverifiable, by design** |

### The three-verdict rule

Every check returns exactly one of:

| Verdict | Meaning | Confidence |
|---|---|---|
| `true` | Provably met from public data | verified |
| `false` | Provably **not** met | verified |
| `null` | Cannot be determined publicly | unknown |

There is no "probably". A phase is eligible only when **every** rule returns
`true`. If any rule fails → not eligible. If nothing fails but something is
unknowable → unverifiable, with the gap named.

`previous-mint` is deliberately worded carefully: on-chain we can prove you
*hold* an NFT today, not that you were the original minter. The result says so.

### Platform support — honest status

| Platform | Status |
|---|---|
| **Contract address / block explorer** | ✅ No key needed. Reads `name`, `totalSupply`, OpenSea SeaDrop config, and ~9 common merkle-root getters. |
| **OpenSea** | ⚠️ Resolves collection → contract + chain via official API v2 (**needs `OPENSEA_API_KEY`**). Phases then come from the chain (SeaDrop). OpenSea publishes no unauthenticated drop-stage endpoint and opensea.io sits behind bot protection, which this tool does not scrape — for non-SeaDrop drops it reports phases-undetermined. |
| **Magic Eden (EVM)** | ⚠️ Uses the public Reservoir-backed `/mints/v1` endpoint, which does publish stage names, times, wallet limits and allowlist flags. Collection URLs containing a contract work; `/launchpad/<symbol>` returns a clear error. |
| **Manual JSON** | ✅ Define phases yourself. Same engine, same evidence trail. |

---

# Part 3 — Configuration

Copy `.env.example` to `.env` and fill in what you have. Keys are read
server-side only and never reach the browser. Restart the server after editing.

| Variable | Effect if missing |
|---|---|
| `PORT` | Defaults to 8787. |
| `OPENSEA_API_KEY` | OpenSea links rejected with an explanation. Contract addresses still work. Free at <https://docs.opensea.io/reference/api-keys>. |
| `MAGICEDEN_API_KEY` | Magic Eden still works, on a lower public rate limit. |
| `ETHERSCAN_API_KEY` | `wallet-age` and `contract-interaction` report "unable to verify". Free tier is enough. |
| `RPC_ETHEREUM`, `RPC_BASE`, `RPC_POLYGON`, `RPC_ARBITRUM`, `RPC_OPTIMISM`, `RPC_SEPOLIA` | Falls back to public RPCs — fine for testing, rate-limited under load. Comma-separate several for automatic failover. |

Chains supported out of the box: **Ethereum, Base, Polygon, Arbitrum, OP
Mainnet, Sepolia**.

---

# Part 4 — Defining a project by hand

For mints whose phases live in a Discord announcement or a spreadsheet.
**Projects → Define manually (JSON)**. The prefilled example is editable; the
engine treats these rules exactly like platform-sourced ones.

```json
{
  "name": "Example Mint",
  "chain": "ethereum",
  "contract": "0xYourCollectionContract",
  "sourceUrl": "https://example.com/mint",
  "phases": [
    {
      "name": "OG / Guaranteed",
      "startTime": "2026-09-01T18:00:00Z",
      "walletLimit": 2,
      "rules": [
        { "type": "allowlist",
          "addresses": ["0x1111…", "0x2222…"],
          "source": "Project Discord, 18 Aug" }
      ]
    },
    {
      "name": "FCFS",
      "startTime": "2026-09-01T19:00:00Z",
      "rules": [
        { "type": "nft-holding",
          "contract": "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
          "min": 1, "label": "BAYC" }
      ]
    },
    { "name": "Public", "rules": [{ "type": "open" }] }
  ]
}
```

Any rule type from [Part 2](#part-2--what-it-actually-verifies) can be used. A
phase may combine several — **all** of them must pass. Set `"normalized": "GTD"`
on a phase to override the automatic mapping.

Working examples ship in `data/sample-project.json` (offline) and
`data/sample-project-onchain.json` (live RPC).

---

# Part 5 — How GTD/FCFS is decided

Phase names are normalized in two tiers, so unambiguous words always win:

- **Tier 1 (decisive):** `gtd`, `guaranteed` → **GTD** · `fcfs`, `first come`, `waitlist`, `raffle`, `lottery`, `overflow`, `backup` → **FCFS** · `public`, `open edition` → **PUBLIC**
- **Tier 2 (softer):** `og`, `vip`, `priority`, `founder`, `holder`, `team`, `tier 1` → **GTD** · `tier 2` → **FCFS**
- **Ambiguous** (`wl`, `whitelist`, `allowlist`, `presale`, `early access`, `private`): resolved by position — the earliest ambiguous phase becomes GTD unless an explicit guaranteed phase already exists, in which case it becomes FCFS.

So `FCFS — token holders` resolves to **FCFS**, not GTD, even though "holders"
is a GTD signal.

Inferred mappings are badged `inferred` with a note explaining the assumption,
and **the original name is always displayed beside the normalized one**:

```
Original Phase: OG / Guaranteed    Normalized: GTD    (mapped)
Original Phase: WL                 Normalized: FCFS   (inferred)
```

The mapping is a convenience, never a replacement for what the project said.

---

# Part 6 — Extending it

## Architecture

```
public/            browser UI (dashboard, wallets, projects, eligibility, settings)
   |  fetch /api/*
server.js          HTTP routes, rate limits, CSV/JSON export
   |
lib/engine.js      Eligibility Engine  <- pure logic, no HTTP or UI knowledge
   |
lib/providers/     MintPlatformProvider registry (opensea, magiceden, contract, manual)
lib/onchain.js     drop-framework probes (SeaDrop, custom merkle getters)
lib/rpc.js         BlockchainProvider + NFT/Token ownership providers
lib/etherscan.js   indexer provider (wallet age, contract interaction)
lib/merkle.js      AllowlistProvider helper (OZ-compatible trees)
lib/phases.js      phase-name -> GTD / FCFS / PUBLIC mapping layer
lib/store.js       persistence
```

The engine takes `(project, wallets)` and returns results. It imports nothing
from `server.js` and knows about no specific platform — which is what makes new
platforms cheap.

**Stack:** Node `node:http` + vanilla ES-module frontend, no build step. One
dependency, `ethers` (keccak256, EIP-55, ABI encoding, RPC). `.env` via
`process.loadEnvFile()`, tests via `node:test`, storage in one atomic-write JSON
file.

## Add a mint platform

1. Create `lib/providers/myplatform.js`:

```js
export const myPlatformProvider = {
  id: 'myplatform',
  name: 'My Platform',
  requires: ['MYPLATFORM_API_KEY'],   // shown in Settings; [] if none needed
  urlHint: 'https://myplatform.xyz/mint/<slug>',
  matches: input => /myplatform\.xyz$/.test(new URL(input).hostname),
  async analyze(input) {
    // resolve the URL -> contract + chain, then read the phases
    return {
      platform: 'myplatform',
      sourceUrl: input,
      name, contract, chain,           // chain is a key from lib/chains.js
      phases: [{ name: 'OG', startTime, walletLimit, rules: [...] }],
      warnings: [],                    // say what you could NOT determine
      findings: [], sources: [],
    };
  },
};
```

2. Register it in `lib/providers/index.js` → `PROVIDERS`, **before**
   `contractProvider` (the catch-all).

Done. Phase normalization, the engine, the UI, filters and exports pick it up
automatically. Use `probeDrop(chain, contract)` from `lib/onchain.js` if the
contract publishes config on-chain.

- **Add a rule type:** one entry in `EVALUATORS` in `lib/engine.js` returning `ok()` / `no()` / `unknown()`. It's immediately usable from manual JSON and appears in Settings.
- **Add a chain:** one entry in `lib/chains.js`.

## HTTP API

```
GET    /api/health                     providers, chains, rule types, key status
GET    /api/stats                      dashboard counters + recent projects
GET    /api/wallets
POST   /api/wallets                    { name, address }
POST   /api/wallets/import             { text }   one wallet per line
PATCH  /api/wallets/:id                { name?, address?, notes? }
DELETE /api/wallets/:id
POST   /api/analyze                    { url }    -> project
POST   /api/projects/import            { definition }   manual JSON
POST   /api/projects/:id/allowlist     { phaseId, addresses, label }
POST   /api/projects/:id/check         { walletIds? }   -> results
GET    /api/projects/:id/results
GET    /api/projects/:id/export?format=csv|json|lists
DELETE /api/projects/:id
```

Every error is `{ error: { code, message, detail } }` with a real explanation —
`INVALID_URL`, `UNSUPPORTED_PLATFORM`, `INVALID_ADDRESS`, `CONTRACT_NOT_FOUND`,
`UNSUPPORTED_CHAIN`, `RATE_LIMITED`, `RPC_FAILURE`, `NEEDS_API_KEY`,
`REQUIRES_PRIVATE_AUTH`, `ALLOWLIST_UNAVAILABLE`, `NOT_FOUND`. Nothing fails
silently.

---

# Part 7 — Security

- **Public addresses only.** No key, seed, password or signature is ever requested or accepted.
- **No wallet connection.** No transaction is ever built, signed or sent.
- Addresses are validated and EIP-55 checksummed before storage; a bad checksum is rejected as a likely typo.
- URLs are scheme-checked and private/loopback hosts refused before any outbound fetch.
- API keys stay in `.env`, server-side. `.env` and `data/db.json` are git-ignored.
- CSV export neutralises spreadsheet formula injection from wallet labels.
- Outbound token-bucket rate limiting per host; per-IP limits on analyze and check.
- Protected resources (Discord, X, logins, captchas, private APIs) are **never** bypassed — they are reported as unverifiable.

## Known limits

- `contract-interaction` scans the first 10,000 transactions of a wallet; a busier wallet reports "unable to verify" rather than risking a false negative.
- Historical snapshots need the project's published list — no archive-node balance replay.
- ENS names are not resolved; paste `0x` addresses.
- Single-process in-memory rate limiting and a single-file store: right for a local tool, not for a multi-instance deployment.
