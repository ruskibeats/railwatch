// UK bank holidays from gov.uk, cached daily.
//
// The JSON shape is { "england-and-wales": { events: [{ title, date }] }, ... }.
// The cache is one file in the state dir: { fetchedOn: 'YYYY-MM-DD', events }.
// When the network fetch fails we fall back to the cached events (even stale),
// so a bad morning at gov.uk never blocks the board.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const GOV_URL = 'https://www.gov.uk/bank-holidays.json';

// Write via a temp file and rename, so a reader never sees half a file.
export function defaultWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export async function loadBankHolidays({
  cachePath,
  today,
  fetchImpl = fetch,
  readText = (p) => readFileSync(p, 'utf8'),
  writeText = defaultWrite,
} = {}) {
  let cached = null;
  try {
    cached = JSON.parse(await readText(cachePath));
  } catch {
    // No cache yet.
  }
  if (cached?.fetchedOn === today && Array.isArray(cached.events)) {
    return cached.events;
  }

  try {
    const res = await fetchImpl(GOV_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const events = data?.['england-and-wales']?.events ?? [];
    await writeText(cachePath, `${JSON.stringify({ fetchedOn: today, events }, null, 2)}\n`);
    return events;
  } catch (err) {
    if (Array.isArray(cached?.events)) {
      console.error(`bank holidays fetch failed (${err.message}); using the cached list`);
      return cached.events;
    }
    throw err;
  }
}
