import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide } from './alerts.mjs';

const fixture = () =>
  structuredClone(
    JSON.parse(readFileSync(new URL('./fixtures/alerts-board.json', import.meta.url), 'utf8')),
  );

// 07:00 Europe/London on 2026-11-23 is GMT (no DST), so std times line up.
const now = new Date('2026-11-23T07:00:00Z');
const byId = (r, id) => r.messages.filter((m) => m.serviceId === id);

test('cancelled: one message, then never again', () => {
  const board = fixture();
  board.services[0].cancelled = true;
  board.services[0].etd = 'Cancelled';
  board.services[0].platform = null;

  const first = decide({}, board, now);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].kind, 'cancelled');
  assert.equal(first.messages[0].key, 'HML-EUS-0712|cancelled|cancelled');
  assert.equal(first.messages[0].text, '*```❌🚆 07:12 HML\u2192EUS cancelled```*\n\n*```Next: 07:27, on time```*');
  assert.equal(first.nextState.sent['HML-EUS-0712|cancelled|cancelled'], true);

  const second = decide(first.nextState, board, now);
  assert.deepEqual(second.messages, []);
});

test('cancelled train gets no late or platform message too', () => {
  const board = fixture();
  board.services[0].cancelled = true;
  board.services[0].etd = 'Cancelled';
  board.services[0].std = '07:08';
  board.services[0].platform = '9';

  const first = decide({}, board, now);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].kind, 'cancelled');
});

test('expected 5 min or more late alerts; 4 min does not', () => {
  const board = fixture();
  board.services[0].etd = '07:20'; // 8 min late
  board.services[1].etd = '07:31'; // 4 min late

  const r = decide({}, board, now);
  const late0 = byId(r, 'HML-EUS-0712');
  assert.equal(late0.length, 1);
  assert.equal(late0[0].kind, 'late');
  assert.equal(late0[0].value, '07:20');
  assert.equal(late0[0].key, 'HML-EUS-0712|late|07:20');
  assert.equal(late0[0].text, '*```🐢🚆 07:12 HML\u2192EUS delayed```*\n\n*```Now 07:20, 8 min late```*');
  assert.deepEqual(byId(r, 'HML-EUS-0727'), []);
});

test('the same delay is not repeated, a worse one is', () => {
  const board = fixture();
  board.services[0].etd = '07:20';
  const first = decide({}, board, now);
  assert.equal(byId(first, 'HML-EUS-0712').length, 1);

  const second = decide(first.nextState, board, now);
  assert.deepEqual(second.messages, []);

  board.services[0].etd = '07:26';
  const third = decide(second.nextState, board, now);
  const m = byId(third, 'HML-EUS-0712');
  assert.equal(m.length, 1);
  assert.equal(m[0].value, '07:26');
});

test('"Delayed" with no time alerts once, as a delay with no estimate', () => {
  const board = fixture();
  board.services[0].etd = 'Delayed';

  const first = decide({}, board, now);
  const m = byId(first, 'HML-EUS-0712');
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'late');
  assert.equal(m[0].value, 'Delayed');
  assert.match(m[0].text, /delayed```\*\n\n\*```No estimate yet```\*$/);

  const second = decide(first.nextState, board, now);
  assert.deepEqual(second.messages, []);
});

test('platform change within 10 min alerts once', () => {
  const board = fixture();
  board.services[0].std = '07:08'; // 8 min away

  const base = decide({}, board, now); // first sight: records platform 1
  assert.deepEqual(base.messages, []);

  board.services[0].platform = '2';
  const changed = decide(base.nextState, board, now);
  const m = byId(changed, 'HML-EUS-0712');
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'platform');
  assert.equal(m[0].value, '2');
  assert.equal(m[0].key, 'HML-EUS-0712|platform|2');
  assert.equal(m[0].text, '*```🔀🚉 07:08 HML\u2192EUS platform 2```*\n\n*```Was platform 1```*');

  const repeat = decide(changed.nextState, board, now);
  assert.deepEqual(repeat.messages, []);
});

test('platform change more than 10 min out is held until the train is close', () => {
  const board = fixture(); // 07:12 is 12 min away at 07:00

  const base = decide({}, board, now);
  assert.deepEqual(base.messages, []);

  board.services[0].platform = '2';
  const early = decide(base.nextState, board, now); // 12 min out: no alert yet
  assert.deepEqual(early.messages, []);

  const closer = new Date('2026-11-23T07:05:00Z'); // 7 min out
  const inWindow = decide(early.nextState, board, closer);
  const m = byId(inWindow, 'HML-EUS-0712');
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'platform');
  assert.equal(m[0].value, '2');
});

test('recovery: a late train back on time gets one message, then no repeat', () => {
  const board = fixture();
  board.services[0].etd = '07:20';

  const late = decide({}, board, now);
  assert.equal(byId(late, 'HML-EUS-0712').length, 1);

  board.services[0].etd = 'On time';
  const back = decide(late.nextState, board, now);
  const m = byId(back, 'HML-EUS-0712');
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'ontime');
  assert.equal(m[0].key, 'HML-EUS-0712|ontime|ontime');
  assert.equal(m[0].text, '*```✅🚆 07:12 HML\u2192EUS on time again```*');

  const repeat = decide(back.nextState, board, now);
  assert.deepEqual(repeat.messages, []);
});

test('a train that was never late sends nothing when on time', () => {
  const r = decide({}, fixture(), now);
  assert.deepEqual(r.messages, []);
});

test('state is pruned to the services on the current board', () => {
  const board = fixture();
  board.services[0].etd = '07:20';
  const first = decide({}, board, now);

  board.services = board.services.filter((s) => s.id !== 'HML-EUS-0712');
  const second = decide(first.nextState, board, now);
  assert.equal(second.nextState.last['HML-EUS-0712'], undefined);
  assert.equal(second.nextState.sent['HML-EUS-0712|late|07:20'], undefined);
});

test('reason goes last; blank reasons are left off', () => {
  const board = fixture();
  board.services[0].cancelled = true;
  board.services[0].etd = 'Cancelled';
  board.services[0].cancelReason = 'Train crew shortage';
  board.services[1].etd = 'Delayed';
  board.services[1].delayReason = '  ';

  const { messages } = decide({}, board, now);
  assert.equal(messages[0].text, '*```❌🚆 07:12 HML\u2192EUS cancelled```*\n\n*```Next: 07:27, delayed```*\n\n```Train crew shortage```');
  assert.equal(messages[1].text, '*```⏳🚆 07:27 HML\u2192EUS delayed```*\n\n*```No estimate yet```*');
});

test('cancelled last train on the board: no Next line', () => {
  const board = fixture();
  const last = board.services.at(-1);
  last.cancelled = true;
  last.etd = 'Cancelled';
  const m = decide({}, board, now).messages.find((x) => x.kind === 'cancelled');
  assert.equal(m.text, '*```❌🚆 ' + last.std + ' HML\u2192EUS cancelled```*');
});
