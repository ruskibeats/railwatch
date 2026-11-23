// Rail 3: the paperclip runner.
//
// Gates (all in Europe/London, weekday only):
//   07:00-10:00  HML -> EUS
//   16:00-19:00  EUS -> HML
// Nothing is fetched, published or sent outside a window, on a weekend, on a
// UK bank holiday, or on an `off:` date. Every gate has a test in run.test.mjs.
//
// Inside a window: one LDBWS call for that direction, publish the latest board
// per direction, run the TEC-430 alert rules with per-change dedupe, and send
// each new message once through caddy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getBoard } from './ldbws.mjs';
import { decide, londonNow } from './alerts.mjs';
import { loadBankHolidays, defaultWrite } from './holidays.mjs';

export { londonNow };
import { makeSender } from './notify.mjs';

// Half-open [start, end): a poll at exactly 10:00 or 19:00 is outside.
export const WINDOWS = Object.freeze([
  { from: 'HML', to: 'EUS', start: 7 * 60, end: 10 * 60 },
  { from: 'EUS', to: 'HML', start: 16 * 60, end: 19 * 60 },
]);

// The active direction window, or null when nothing should run.
export function windowFor(date) {
  const { weekday, minutes } = londonNow(date);
  if (weekday === 'Sat' || weekday === 'Sun') return null;
  return WINDOWS.find((w) => minutes >= w.start && minutes < w.end) ?? null;
}

// events: [{ date: 'YYYY-MM-DD', ... }] as returned by holidays.mjs.
export function isBankHoliday(date, events = []) {
  const day = londonNow(date).date;
  return events.some((e) => e?.date === day);
}

export function isOff(date, off = []) {
  return off.includes(londonNow(date).date);
}

// Backoff for transient LDBWS failures (429/5xx): 2, 4, 8, 10, 10... minutes.
// The timer still fires every minute, but runOnce returns early until the
// cooldown passes, so a run of 429s is hit once, not every tick.
export const BACKOFF_BASE_MS = 2 * 60 * 1000;
export const BACKOFF_MAX_MS = 10 * 60 * 1000;

export function backoffMs(failures) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

// One poll. Testable without network or disk: inject fetchImpl, send,
// readText and writeText. `send(text)` returns true on delivery.
export async function runOnce({
  now = new Date(),
  config = {},
  holidays = [],
  fetchImpl = fetch,
  send = async () => true,
  readText = (p) => readFileSync(p, 'utf8'),
  writeText = defaultWrite,
} = {}) {
  const win = windowFor(now);
  if (!win) return { skipped: 'outside-window', messages: [] };
  if (isBankHoliday(now, holidays)) return { skipped: 'bank-holiday', messages: [] };
  if (isOff(now, config.off ?? [])) return { skipped: 'off-date', messages: [] };

  const key = `${win.from}-${win.to}`;

  // Dedupe state and the 429/5xx cooldown share one file.
  const statePath = `${config.stateDir ?? '/var/lib/uclh-rail'}/alerts.json`;
  let state = {};
  try {
    state = JSON.parse(await readText(statePath));
  } catch {
    // First run.
  }

  const cooldown = state.backoff?.[key];
  if (cooldown && Date.parse(cooldown.until) > now.getTime()) {
    return { skipped: 'backoff', window: key, retryAt: cooldown.until, messages: [] };
  }

  let board;
  try {
    board = await getBoard({ from: win.from, to: win.to, fetchImpl });
  } catch (err) {
    if (err.retryable !== true) {
      return { skipped: 'fetch-error', window: key, error: err.message, messages: [] };
    }
    const failures = (cooldown?.failures ?? 0) + 1;
    const until = new Date(now.getTime() + backoffMs(failures)).toISOString();
    state.backoff = { ...(state.backoff ?? {}), [key]: { failures, until } };
    await writeText(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return {
      skipped: 'backoff',
      window: key,
      error: err.message,
      failures,
      retryAt: until,
      messages: [],
    };
  }
  if (state.backoff?.[key]) {
    const backoff = { ...state.backoff };
    delete backoff[key];
    state.backoff = backoff;
  }

  // Publish the latest board per direction, keeping the other direction.
  const publishPath = `${config.publishDir ?? '/srv/estate/publish/rail'}/board.json`;
  let published = { updatedAt: now.toISOString(), directions: {} };
  try {
    published = JSON.parse(await readText(publishPath));
  } catch {
    // First run, or the file is unreadable: start a fresh document.
  }
  published.updatedAt = now.toISOString();
  published.directions = { ...(published.directions ?? {}), [key]: board };
  await writeText(publishPath, `${JSON.stringify(published, null, 2)}\n`);

  // Alerts with per-change dedupe (TEC-430).
  const { messages, nextState } = decide(state[key], board, now);

  // A failed send is retried next tick; a successful one is never repeated.
  const failed = new Set();
  for (const m of messages) {
    if (!(await send(m.text))) failed.add(m.key);
  }
  if (failed.size === 0) {
    state[key] = nextState;
  } else {
    const sentState = { ...nextState.sent };
    for (const m of messages) if (failed.has(m.key)) delete sentState[m.key];
    state[key] = { sent: sentState, last: nextState.last };
  }
  await writeText(statePath, `${JSON.stringify(state, null, 2)}\n`);

  return {
    skipped: null,
    window: key,
    messages,
    sent: messages.length - failed.size,
    failed: [...failed],
    published: publishPath,
  };
}

// A broken run (expired key, gov.uk down with no cache, a bug) is silent on
// WhatsApp, and silence reads as "all trains on time". Say so, once per day.
export async function alertFailureOnce({
  now,
  stateDir,
  reason,
  send,
  readText = (p) => readFileSync(p, 'utf8'),
  writeText = defaultWrite,
}) {
  const path = `${stateDir}/failure-alert.json`;
  const today = londonNow(now).date;
  try {
    if (JSON.parse(await readText(path)).date === today) return false;
  } catch {
    // Never alerted.
  }
  const text = `*\`\`\`⚠️🚆 Rail alerts not working\`\`\`*\n\n\`\`\`${reason}\`\`\``;
  if (!(await send(text))) return false;
  await writeText(path, `${JSON.stringify({ date: today, reason })}\n`);
  return true;
}

export function loadConfig(path = process.env.RAIL_CONFIG ?? '/etc/uclh-rail/config.json') {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const now = new Date();
  const dry = process.argv.includes('--dry');

  // Gate first: outside a window we touch nothing, not even the config file.
  if (!windowFor(now)) {
    console.log(`[${now.toISOString()}] outside a weekday window, nothing to do`);
    return;
  }

  const config = loadConfig();
  const stateDir = config.stateDir ?? '/var/lib/uclh-rail';
  const send = makeSender({ ...(config.notify ?? {}), to: config.to, dry });
  // --dry must not record alerts as sent, or the real timer would skip them.
  const writeText = dry ? () => {} : defaultWrite;

  let result;
  try {
    const holidays = await loadBankHolidays({
      cachePath: `${stateDir}/bank-holidays.json`,
      today: londonNow(now).date,
    });
    result = await runOnce({ now, config, holidays, send, writeText });
    if (result.skipped === 'fetch-error') throw new Error(`${result.window} fetch failed: ${result.error}`);
    // A long LDBWS outage (429/5xx) is just as silent as a hard failure.
    if (result.failures >= 3) throw new Error(`${result.window} LDBWS failing ${result.failures} times in a row: ${result.error}`);
  } catch (err) {
    await alertFailureOnce({ now, stateDir, reason: err.message, send, writeText });
    throw err;
  }

  if (result.skipped === 'backoff') {
    const detail = result.error ? ` (${result.error})` : '';
    console.log(`[${now.toISOString()}] ${result.window} backing off until ${result.retryAt}${detail}`);
    return;
  }
  if (result.skipped) {
    console.log(`[${now.toISOString()}] skipped: ${result.skipped}`);
    return;
  }
  console.log(
    `[${now.toISOString()}] ${result.window}: published board, ${result.sent}/${result.messages.length} alerts sent`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[${new Date().toISOString()}] ${err.message}`);
    process.exitCode = 1;
  });
}
