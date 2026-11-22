import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatBoard, statusText, validateBoard } from './board.mjs';

const board = JSON.parse(await readFile(new URL('./fixtures/board.json', import.meta.url)));

test('the published fixture matches the card contract', () => {
  assert.deepEqual(validateBoard(board), []);
});

test('validateBoard names what is wrong', () => {
  const bad = { generatedAt: 1, boards: [{ from: 'HML', to: 'EUS', fromName: 'x', toName: 'y', services: [{ id: 2 }] }] };
  const errors = validateBoard(bad);
  assert.ok(errors.includes('generatedAt must be a string'));
  assert.ok(errors.includes('boards must hold both directions'));
  assert.ok(errors.some((e) => e.endsWith('.id must be a string')));
});

test('both directions come out, in feed order', () => {
  const out = formatBoard(board);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'Hemel Hempstead \u2192 London Euston');
  assert.equal(out[1].title, 'London Euston \u2192 Hemel Hempstead');
});

test('card rows read std, expected time, cancellation and platform', () => {
  const [hml] = formatBoard(board);
  assert.deepEqual(hml.rows, [
    { std: '07:12', status: 'On time', platform: '1', cancelled: false },
    { std: '07:27', status: '07:34 (+7)', platform: '2', cancelled: false },
    { std: '07:42', status: 'Cancelled', platform: null, cancelled: true },
  ]);
});

test('statusText treats "Delayed" and missing etd as it does on the board', () => {
  assert.equal(statusText({ std: '17:18', etd: 'Delayed' }), 'Delayed');
  assert.equal(statusText({ std: '17:03', etd: '17:03' }), '17:03 on time');
  assert.equal(statusText({ std: '17:03', etd: null }), '17:03');
  assert.equal(statusText({ std: '17:03', etd: 'Cancelled' }), 'Cancelled');
});
