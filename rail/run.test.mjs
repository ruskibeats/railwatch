import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { windowFor, londonNow, isBankHoliday, isOff, runOnce, backoffMs } from './run.mjs';
import { loadBankHolidays } from './holidays.mjs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const BASE = 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120';

beforeEach(() => {
  process.env.LDBWS_URL = BASE;
  process.env.LDBWS_KEY = 'test-key-not-real';
});

function fakeFetch(body) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  return { impl, calls };
}

// In-memory file store so runOnce tests never touch disk.
function memoryFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readText: async (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p);
    },
    writeText: async (p, t) => files.set(p, t),
  };
}

const CONFIG = {
  off: [],
  publishDir: '/srv/estate/publish/rail',
  stateDir: '/var/lib/uclh-rail',
  to: '447000000000',
};

// --- window gate -----------------------------------------------------------

test('weekday morning window is HML to EUS, 07:00 <= t < 09:00', () => {
  assert.equal(windowFor(new Date('2026-11-23T07:00:00Z')).from, 'HML');
  assert.equal(windowFor(new Date('2026-11-23T08:59:00Z')).from, 'HML');
  assert.equal(windowFor(new Date('2026-11-23T09:00:00Z')), null);
  assert.equal(windowFor(new Date('2026-11-23T06:59:00Z')), null);
});

test('weekday evening window is EUS to HML, 17:00 <= t < 19:00', () => {
  assert.equal(windowFor(new Date('2026-11-23T17:00:00Z')).from, 'EUS');
  assert.equal(windowFor(new Date('2026-11-23T18:59:00Z')).from, 'EUS');
  assert.equal(windowFor(new Date('2026-11-23T19:00:00Z')), null);
  assert.equal(windowFor(new Date('2026-11-23T16:59:00Z')), null);
});

test('weekend has no window', () => {
  assert.equal(windowFor(new Date('2026-11-21T08:00:00Z')), null); // Saturday
  assert.equal(windowFor(new Date('2026-11-22T08:00:00Z')), null); // Sunday
});

test('window uses Europe/London, so BST shifts the UTC boundary', () => {
  // 06:30Z on 2026-06-15 is 07:30 in London (BST).
  assert.equal(windowFor(new Date('2026-06-15T06:30:00Z')).from, 'HML');
  assert.equal(londonNow(new Date('2026-06-15T06:30:00Z')).minutes, 7 * 60 + 30);
});

test('bank holidays and off dates match the London calendar day', () => {
  const events = [{ title: 'Christmas Day', date: '2026-12-25' }];
  assert.equal(isBankHoliday(new Date('2026-12-25T08:00:00Z'), events), true);
  assert.equal(isBankHoliday(new Date('2026-12-24T08:00:00Z'), events), false);
  assert.equal(isOff(new Date('2026-12-24T08:00:00Z'), ['2026-12-24']), true);
  assert.equal(isOff(new Date('2026-12-24T08:00:00Z'), []), false);
});

// --- runOnce gates ---------------------------------------------------------

test('outside a window nothing is fetched and nothing is published', async () => {
  const { impl, calls } = fakeFetch(fixture('hml-to-eus.json'));
  const fs = memoryFs();
  const r = await runOnce({
    now: new Date('2026-11-23T09:00:00Z'),
    config: CONFIG,
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
    send: async () => true,
  });
  assert.equal(r.skipped, 'outside-window');
  assert.equal(calls.length, 0);
  assert.equal(fs.files.size, 0);
});

test('bank holiday: no fetch, no publish, no send', async () => {
  const { impl, calls } = fakeFetch(fixture('hml-to-eus.json'));
  const fs = memoryFs();
  const r = await runOnce({
    now: new Date('2026-11-23T07:30:00Z'),
    config: CONFIG,
    holidays: [{ date: '2026-11-23', title: 'Test holiday' }],
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
    send: async () => true,
  });
  assert.equal(r.skipped, 'bank-holiday');
  assert.equal(calls.length, 0);
  assert.equal(fs.files.size, 0);
});

test('off date in config is skipped', async () => {
  const { impl, calls } = fakeFetch(fixture('hml-to-eus.json'));
  const fs = memoryFs();
  const r = await runOnce({
    now: new Date('2026-11-23T07:30:00Z'),
    config: { ...CONFIG, off: ['2026-11-23'] },
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
    send: async () => true,
  });
  assert.equal(r.skipped, 'off-date');
  assert.equal(calls.length, 0);
});

// --- runOnce happy path ----------------------------------------------------

test('morning poll fetches HML->EUS, publishes the board and sends each alert once', async () => {
  const { impl, calls } = fakeFetch(fixture('hml-to-eus.json'));
  const fs = memoryFs();
  const sent = [];
  const send = async (text) => {
    sent.push(text);
    return true;
  };

  const first = await runOnce({
    now: new Date('2026-11-23T07:30:00Z'),
    config: CONFIG,
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
    send,
  });

  assert.equal(first.skipped, null);
  assert.equal(first.window, 'HML-EUS');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/HML\?/);
  assert.match(calls[0], /filterCrs=EUS/);
  assert.match(calls[0], /filterType=to/);

  // 07:27 is 7 min late, 07:42 is cancelled.
  assert.deepEqual(first.messages.map((m) => m.kind).sort(), ['cancelled', 'late']);
  assert.equal(first.sent, 2);
  assert.equal(sent.length, 2);

  const board = JSON.parse(fs.files.get('/srv/estate/publish/rail/board.json'));
  assert.equal(board.directions['HML-EUS'].services.length, 3);
  assert.equal(board.directions['HML-EUS'].crs, 'HML');

  // Second poll: same board, no repeat.
  const second = await runOnce({
    now: new Date('2026-11-23T07:32:00Z'),
    config: CONFIG,
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
    send,
  });
  assert.deepEqual(second.messages, []);
  assert.equal(sent.length, 2);
});

test('publish keeps the other direction and a platform change alerts once', async () => {
  const eus = fixture('eus-to-hml.json');
  const changed = fixture('hml-to-eus.json');
  const { impl } = fakeFetch(changed);
  const seeded = {
    '/srv/estate/publish/rail/board.json': JSON.stringify({
      updatedAt: '2026-11-23T17:30:00.000Z',
      directions: { 'EUS-HML': { crs: 'EUS', filterCrs: 'HML', services: [] } },
    }),
  };
  const fs = memoryFs(seeded);
  const sent = [];
  const send = async (t) => {
    sent.push(t);
    return true;
  };

  await runOnce({
    now: new Date('2026-11-23T07:30:00Z'),
    config: CONFIG,
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
    send,
  });

  // The second run sees platform 2 -> 5 inside the 10-minute window.
  changed.trainServices[1].platform = '5';
  const r = await runOnce({
    now: new Date('2026-11-23T07:31:00Z'),
    config: CONFIG,
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
    send,
  });

  assert.equal(r.messages.filter((m) => m.kind === 'platform').length, 1);
  const board = JSON.parse(fs.files.get('/srv/estate/publish/rail/board.json'));
  assert.ok(board.directions['EUS-HML'], 'other direction kept');
  assert.equal(board.directions['HML-EUS'].services[1].platform, '5');

  // eus fixture untouched sanity check
  assert.equal(eus.filtercrs, 'HML');
  assert.equal(eus.trainServices.length, 2);
});

test('a failed send is retried on the next tick instead of being marked sent', async () => {
  const { impl } = fakeFetch(fixture('hml-to-eus.json'));
  const fs = memoryFs();
  let fail = true;
  const send = async () => {
    if (fail) return false;
    return true;
  };

  const first = await runOnce({
    now: new Date('2026-11-23T07:30:00Z'),
    config: CONFIG,
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
    send,
  });
  assert.equal(first.sent, 0);
  assert.equal(first.failed.length, 2);

  fail = false;
  const second = await runOnce({
    now: new Date('2026-11-23T07:32:00Z'),
    config: CONFIG,
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
    send,
  });
  assert.equal(second.sent, 2);
  assert.equal(second.failed.length, 0);
});

// --- 429/5xx backoff -------------------------------------------------------

function failingFetch(status) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { ok: false, status, statusText: 'Transient' };
  };
  return { impl, calls };
}

async function poll(now, { impl, fs, config = CONFIG, send = async () => true }) {
  return runOnce({ now, config, fetchImpl: impl, readText: fs.readText, writeText: fs.writeText, send });
}

test('backoff length is 2, 4, 8, 10, 10 minutes', () => {
  assert.equal(backoffMs(1) / 60000, 2);
  assert.equal(backoffMs(2) / 60000, 4);
  assert.equal(backoffMs(3) / 60000, 8);
  assert.equal(backoffMs(4) / 60000, 10);
  assert.equal(backoffMs(9) / 60000, 10);
});

test('429: cooldown is stored and the next tick does not call the API', async () => {
  const { impl, calls } = failingFetch(429);
  const fs = memoryFs();

  const first = await poll(new Date('2026-11-23T07:30:00Z'), { impl, fs });
  assert.equal(first.skipped, 'backoff');
  assert.equal(first.failures, 1);
  assert.equal(first.retryAt, '2026-11-23T07:32:00.000Z');
  assert.equal(calls.length, 1);

  const stored = JSON.parse(fs.files.get('/var/lib/uclh-rail/alerts.json'));
  assert.deepEqual(stored.backoff['HML-EUS'], {
    failures: 1,
    until: '2026-11-23T07:32:00.000Z',
  });

  // One minute later: still inside the cooldown, no second call.
  const second = await poll(new Date('2026-11-23T07:31:00Z'), { impl, fs });
  assert.equal(second.skipped, 'backoff');
  assert.equal(calls.length, 1);

  // After the cooldown it tries again, and the backoff grows.
  const third = await poll(new Date('2026-11-23T07:33:00Z'), { impl, fs });
  assert.equal(third.failures, 2);
  assert.equal(third.retryAt, '2026-11-23T07:37:00.000Z');
  assert.equal(calls.length, 2);
});

test('5xx backoff grows with consecutive failures and clears after a success', async () => {
  const fs = memoryFs();
  const calls = [];
  let failing = true;
  const impl = async () => {
    calls.push(1);
    if (failing) return { ok: false, status: 503, statusText: 'Service Unavailable' };
    return { ok: true, status: 200, statusText: 'OK', json: async () => fixture('hml-to-eus.json') };
  };

  const first = await poll(new Date('2026-11-23T07:00:00Z'), { impl, fs });
  assert.equal(first.failures, 1);
  assert.equal(first.retryAt, '2026-11-23T07:02:00.000Z');

  const second = await poll(new Date('2026-11-23T07:02:00Z'), { impl, fs });
  assert.equal(second.failures, 2);
  assert.equal(second.retryAt, '2026-11-23T07:06:00.000Z');
  assert.equal(calls.length, 2);

  failing = false;
  const third = await poll(new Date('2026-11-23T07:06:00Z'), { impl, fs });
  assert.equal(third.skipped, null);
  assert.equal(calls.length, 3);

  const stored = JSON.parse(fs.files.get('/var/lib/uclh-rail/alerts.json'));
  assert.equal(stored.backoff['HML-EUS'], undefined, 'success clears the cooldown');
});

test('a non-retryable HTTP error is reported and sets no backoff', async () => {
  const { impl } = failingFetch(401);
  const fs = memoryFs();
  const r = await poll(new Date('2026-11-23T07:30:00Z'), { impl, fs });
  assert.equal(r.skipped, 'fetch-error');
  assert.match(r.error, /HTTP 401/);
  assert.equal(fs.files.has('/var/lib/uclh-rail/alerts.json'), false);
});

// --- holiday cache ---------------------------------------------------------

test('bank holidays are cached for the day and reused without a fetch', async () => {
  const fs = memoryFs();
  let fetches = 0;
  const gov = {
    'england-and-wales': { events: [{ title: 'Boxing Day', date: '2026-12-26' }] },
  };
  const impl = async () => {
    fetches += 1;
    return { ok: true, status: 200, json: async () => gov };
  };

  const a = await loadBankHolidays({
    cachePath: '/var/lib/uclh-rail/bank-holidays.json',
    today: '2026-12-24',
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
  });
  assert.equal(a[0].date, '2026-12-26');
  assert.equal(fetches, 1);

  const b = await loadBankHolidays({
    cachePath: '/var/lib/uclh-rail/bank-holidays.json',
    today: '2026-12-24',
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
  });
  assert.equal(b[0].date, '2026-12-26');
  assert.equal(fetches, 1, 'cached for the day, no second fetch');
});

test('if gov.uk is down, the stale cached list is used', async () => {
  const fs = memoryFs({
    '/var/lib/uclh-rail/bank-holidays.json': JSON.stringify({
      fetchedOn: '2026-12-23',
      events: [{ title: 'Christmas Day', date: '2026-12-25' }],
    }),
  });
  const impl = async () => {
    throw new Error('network down');
  };
  const events = await loadBankHolidays({
    cachePath: '/var/lib/uclh-rail/bank-holidays.json',
    today: '2026-12-24',
    fetchImpl: impl,
    readText: fs.readText,
    writeText: fs.writeText,
  });
  assert.equal(events[0].date, '2026-12-25');
});
