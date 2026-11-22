// LDBWS client: one departure board per call, no logging of the credentials.
// Spec: TEC-427 attachments (ldbws-swagger-json.txt, LDBWS Documentation.pdf).
// Access: Rail Data Marketplace product "Live Departure Board", header x-apikey.
// Base URL and key come from /etc/uclh-rail/ldbws.env. Never log either value.

const CRS = /^[A-Z]{3}$/;

function credentials() {
  const base = process.env.LDBWS_URL;
  const key = process.env.LDBWS_KEY;
  if (!base || !key) {
    throw new Error('LDBWS_URL and LDBWS_KEY must both be set');
  }
  return { base: base.replace(/\/+$/, ''), key };
}

function crs(value, name) {
  if (typeof value !== 'string' || !CRS.test(value)) {
    throw new Error(`${name} must be a 3-letter uppercase CRS code`);
  }
  return value;
}

function normalise(s) {
  return {
    id: s?.serviceID ?? s?.rsid ?? null,
    std: s?.std ?? null,
    etd: s?.etd ?? null,
    platform: s?.platform ?? null,
    cancelled: s?.isCancelled === true || s?.etd === 'Cancelled',
    delayReason: s?.delayReason ?? null,
    operator: s?.operator ?? null,
  };
}

// window: minutes either side of now (LDBWS timeWindow, 1-120).
export async function getBoard({ from, to, window = 120, numRows = 9, fetchImpl = fetch } = {}) {
  const fromCrs = crs(from, 'from');
  const toCrs = crs(to, 'to');
  if (!Number.isInteger(window) || window < 1 || window > 120) {
    throw new Error('window must be an integer 1-120');
  }
  if (!Number.isInteger(numRows) || numRows < 1 || numRows > 9) {
    throw new Error('numRows must be an integer 1-9');
  }

  const { base, key } = credentials();
  const url = new URL(`${base}/GetDepBoardWithDetails/${fromCrs}`);
  url.searchParams.set('filterCrs', toCrs);
  url.searchParams.set('filterType', 'to');
  url.searchParams.set('numRows', String(numRows));
  url.searchParams.set('timeWindow', String(window));

  const res = await fetchImpl(url, {
    headers: { 'x-apikey': key, accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    // Deliberately no request headers or URL key in the message.
    const err = new Error(`LDBWS request failed: HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    // 429 and 5xx are transient: the runner backs off and retries.
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const board = await res.json();
  return {
    generatedAt: board.generatedAt ?? null,
    locationName: board.locationName ?? null,
    crs: board.crs ?? fromCrs,
    filterCrs: board.filtercrs ?? board.filterCrs ?? toCrs,
    services: (board.trainServices ?? []).map(normalise),
  };
}
