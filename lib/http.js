import { AppError, CODES } from './errors.js';

/**
 * Outbound HTTP: timeout, per-host rate limiting, one polite retry on 429/5xx.
 * Every external API in this app goes through here so a single misbehaving
 * upstream cannot hammer a provider or hang a request forever.
 */

const buckets = new Map();

// ponytail: in-memory token bucket, single process. Swap for Redis if this
// ever runs multi-instance.
function bucketFor(host, perMinute) {
  let b = buckets.get(host);
  if (!b) {
    b = { tokens: perMinute, capacity: perMinute, refillPerMs: perMinute / 60000, last: Date.now() };
    buckets.set(host, b);
  }
  const now = Date.now();
  b.tokens = Math.min(b.capacity, b.tokens + (now - b.last) * b.refillPerMs);
  b.last = now;
  return b;
}

async function takeToken(host, perMinute) {
  const b = bucketFor(host, perMinute);
  if (b.tokens >= 1) { b.tokens -= 1; return; }
  const waitMs = Math.ceil((1 - b.tokens) / b.refillPerMs);
  if (waitMs > 10_000) {
    throw new AppError(CODES.RATE_LIMITED, `Local rate limit reached for ${host}`, {
      status: 429,
      detail: `Would need to wait ${Math.round(waitMs / 1000)}s. Slow down, or configure an API key with a higher quota.`,
    });
  }
  await new Promise(r => setTimeout(r, waitMs));
  bucketFor(host, perMinute).tokens -= 1;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function fetchJson(url, {
  headers = {}, timeoutMs = 15_000, perMinute = 60, label = 'upstream API', retries = 1, method = 'GET', body,
} = {}) {
  const host = new URL(url).host;
  await takeToken(host, perMinute);

  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { accept: 'application/json', 'user-agent': 'mint-eligibility-checker/1.0', ...headers },
        body,
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
      const aborted = err?.name === 'AbortError';
      throw new AppError(CODES.UPSTREAM_FAILURE, `${label} did not respond`, {
        status: 502,
        detail: aborted ? `Request to ${host} timed out after ${timeoutMs}ms.` : `Network error contacting ${host}: ${err.message}`,
        cause: err,
      });
    }
    clearTimeout(timer);

    if (res.status === 429) {
      if (attempt < retries) {
        const ra = Number(res.headers.get('retry-after')) || 2;
        await sleep(Math.min(ra, 5) * 1000);
        continue;
      }
      throw new AppError(CODES.RATE_LIMITED, `${label} rate limit hit`, {
        status: 429,
        detail: `${host} returned HTTP 429. Add an API key or wait before retrying.`,
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError(CODES.NEEDS_API_KEY, `${label} rejected the request (HTTP ${res.status})`, {
        status: 502,
        detail: `${host} requires a valid API key. Set the relevant key in .env and restart the server.`,
      });
    }
    if (res.status === 404) {
      throw new AppError(CODES.NOT_FOUND, `${label} has no record of that resource`, {
        status: 404,
        detail: `${host} returned HTTP 404 for ${url}.`,
      });
    }
    if (!res.ok) {
      if (res.status >= 500 && attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new AppError(CODES.UPSTREAM_FAILURE, `${label} returned HTTP ${res.status}`, {
        status: 502, detail: text || `No response body from ${host}.`,
      });
    }

    try {
      return await res.json();
    } catch (err) {
      throw new AppError(CODES.UPSTREAM_FAILURE, `${label} returned a non-JSON response`, {
        status: 502,
        detail: `Expected JSON from ${host}. The endpoint may have changed or be serving an HTML challenge page.`,
        cause: err,
      });
    }
  }
}

/** Reject anything that is not a plain http(s) URL before we ever fetch it. */
export function safeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new AppError(CODES.INVALID_URL, 'That does not look like a URL', {
      detail: 'Paste a full link including https://, for example https://opensea.io/collection/example',
    });
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new AppError(CODES.INVALID_URL, `Unsupported URL scheme "${u.protocol}"`, {
      detail: 'Only http:// and https:// links are accepted.',
    });
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || /^(127|10|192\.168|169\.254)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new AppError(CODES.INVALID_URL, 'Refusing to fetch a private/loopback address', {
      detail: 'Mint links must point at a public host.',
    });
  }
  return u;
}
