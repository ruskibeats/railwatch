import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getBoard } from './ldbws.mjs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function fakeFetch(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok, status, statusText, json: async () => body };
  };
  return { impl, calls };
}

const BASE = 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120';
const KEY = 'test-key-not-real';

beforeEach(() => {
  process.env.LDBWS_URL = BASE;
  process.env.LDBWS_KEY = KEY;
});

test('HML to EUS: normalises each service to the agreed shape', async () => {
  const { impl } = fakeFetch(fixture('hml-to-eus.json'));
  const board = await getBoard({ from: 'HML', to: 'EUS', fetchImpl: impl });

  assert.equal(board.crs, 'HML');
  assert.equal(board.filterCrs, 'EUS');
  assert.equal(board.generatedAt, '2026-11-23T07:00:00Z');
  assert.equal(board.services.length, 3);

  assert.deepEqual(board.services[0], {
    id: 'HML-EUS-0712',
    std: '07:12',
    etd: 'On time',
    platform: '1',
    cancelled: false,
    delayReason: null,
    operator: 'London Northwestern Railway',
  });
  assert.equal(board.services[1].delayReason, 'Signalling fault near Watford Junction');
  assert.equal(board.services[2].cancelled, true);
  assert.equal(board.services[2].platform, null);
});

test('EUS to HML: "Delayed" etd is kept as text, not guessed', async () => {
  const { impl } = fakeFetch(fixture('eus-to-hml.json'));
  const board = await getBoard({ from: 'EUS', to: 'HML', fetchImpl: impl });

  assert.equal(board.services.length, 2);
  assert.equal(board.services[1].etd, 'Delayed');
  assert.equal(board.services[1].delayReason, 'Earlier train fault');
  // The real destination is Milton Keynes Central; the filter is HML, not the name.
  assert.equal(board.filterCrs, 'HML');
});

test('calls GetDepBoardWithDetails with filterCrs/filterType=to and x-apikey', async () => {
  const { impl, calls } = fakeFetch(fixture('hml-to-eus.json'));
  await getBoard({ from: 'HML', to: 'EUS', window: 120, numRows: 9, fetchImpl: impl });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, `${BASE}/GetDepBoardWithDetails/HML`);
  assert.equal(url.searchParams.get('filterCrs'), 'EUS');
  assert.equal(url.searchParams.get('filterType'), 'to');
  assert.equal(url.searchParams.get('numRows'), '9');
  assert.equal(url.searchParams.get('timeWindow'), '120');
  assert.equal(calls[0].init.headers['x-apikey'], KEY);
  assert.equal(calls[0].url.includes(KEY), false);
});

test('empty board gives an empty service list', async () => {
  const { impl } = fakeFetch({ generatedAt: '2026-11-23T07:00:00Z', crs: 'HML', filtercrs: 'EUS', trainServices: [] });
  const board = await getBoard({ from: 'HML', to: 'EUS', fetchImpl: impl });
  assert.deepEqual(board.services, []);
});

test('etd "Cancelled" alone marks the service cancelled', async () => {
  const { impl } = fakeFetch({ trainServices: [{ serviceID: 'X1', std: '07:12', etd: 'Cancelled' }] });
  const board = await getBoard({ from: 'HML', to: 'EUS', fetchImpl: impl });
  assert.equal(board.services[0].cancelled, true);
});

test('missing credentials throw without naming a value', async () => {
  const { impl } = fakeFetch(fixture('hml-to-eus.json'));
  delete process.env.LDBWS_URL;
  await assert.rejects(
    () => getBoard({ from: 'HML', to: 'EUS', fetchImpl: impl }),
    (err) => err.message.includes('LDBWS_URL and LDBWS_KEY') && !err.message.includes(KEY),
  );
  process.env.LDBWS_URL = BASE;
  delete process.env.LDBWS_KEY;
  await assert.rejects(
    () => getBoard({ from: 'HML', to: 'EUS', fetchImpl: impl }),
    (err) => err.message.includes('LDBWS_URL and LDBWS_KEY') && !err.message.includes(KEY),
  );
});

test('HTTP error does not leak the credentials or header', async () => {
  const { impl } = fakeFetch({}, { ok: false, status: 401, statusText: 'Unauthorized' });
  await assert.rejects(
    () => getBoard({ from: 'HML', to: 'EUS', fetchImpl: impl }),
    (err) => {
      assert.match(err.message, /HTTP 401/);
      assert.equal(err.message.includes(KEY), false);
      assert.equal(err.message.includes('x-apikey'), false);
      return true;
    },
  );
});

test('429 and 5xx are marked retryable, 4xx is not', async () => {
  for (const status of [429, 500, 503]) {
    const { impl } = fakeFetch({}, { ok: false, status, statusText: 'Transient' });
    await assert.rejects(
      () => getBoard({ from: 'HML', to: 'EUS', fetchImpl: impl }),
      (err) => {
        assert.equal(err.status, status);
        assert.equal(err.retryable, true);
        return true;
      },
    );
  }
  const { impl } = fakeFetch({}, { ok: false, status: 400, statusText: 'Bad Request' });
  await assert.rejects(
    () => getBoard({ from: 'HML', to: 'EUS', fetchImpl: impl }),
    (err) => {
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('rejects lowercase or non-3-letter CRS codes', async () => {
  const { impl } = fakeFetch(fixture('hml-to-eus.json'));
  await assert.rejects(() => getBoard({ from: 'hml', to: 'EUS', fetchImpl: impl }), /from must be/);
  await assert.rejects(() => getBoard({ from: 'HML', to: 'EUSTON', fetchImpl: impl }), /to must be/);
});

test('rejects window outside 1-120 and numRows outside 1-9', async () => {
  const { impl } = fakeFetch(fixture('hml-to-eus.json'));
  await assert.rejects(() => getBoard({ from: 'HML', to: 'EUS', window: 0, fetchImpl: impl }), /window/);
  await assert.rejects(() => getBoard({ from: 'HML', to: 'EUS', window: 121, fetchImpl: impl }), /window/);
  await assert.rejects(() => getBoard({ from: 'HML', to: 'EUS', numRows: 10, fetchImpl: impl }), /numRows/);
});
