// Alert rules: pure decision function, no I/O.
//
// decide(prevState, board, now) -> { messages, nextState }
//
// A "board" is the normalised object from ldbws.mjs:
//   { crs, filterCrs, generatedAt, services: [{ id, std, etd, platform,
//     cancelled, delayReason, cancelReason, operator }] }
//
// Rules (TEC-430):
//   - cancelled                          -> one message per train
//   - expected >= 5 min late             -> one message per distinct etd
//   - platform change within 10 min      -> one message per distinct platform
//   - "Delayed" with no time             -> treated as a delay, one message
//   - a train we alerted a delay for
//     that is "On time" again            -> one "now on time" message
//
// Dedupe key is `serviceId|kind|value`. State is two small maps: the keys
// already sent, and the platform reference per train. State is pruned to the
// services on the current board so the JSON file stays small.
//
// Choices that the issue left open (also in the PR body):
//   - "Delayed" with no time is alerted once, because an explicit delay is at
//     least as bad as 5 minutes and the message says there is no estimate.
//   - Recovery is only reported for a train we previously alerted a delay for,
//     so an always-punctual train never produces a message.
//   - A platform change is alerted only when it is observed within 10 minutes
//     of departure. The reference platform is not moved while the train is
//     more than 10 minutes away, so a change made earlier is still caught once
//     the train comes inside the window.

const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const HHMM = /^(\d{1,2}):(\d{2})$/;

function toMinutes(value) {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function londonMinutes(date) {
  const parts = LONDON.formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}


// WhatsApp layout, read at a glance on a phone (Russell 2026-11-22):
//   title   bold monospace - the train and what happened
//   notice  bold monospace - the one fact to act on (next train, new time)
//   reason  plain monospace - Darwin's full sentence, when there is one
// separated by blank lines. ```...``` is WhatsApp's monospace; *...* around it
// makes it bold. Empty parts are left out.
function lines(title, notice, reason) {
  const part = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const mono = (v) => `\`\`\`${v}\`\`\``;
  return [
    part(title) && `*${mono(part(title))}*`,
    part(notice) && `*${mono(part(notice))}*`,
    part(reason) && mono(part(reason)),
  ]
    .filter(Boolean)
    .join('\n\n');
}

// The next train that is still running, so a cancellation comes with a plan B.
function nextRunning(services, after) {
  const n = services.slice(after + 1).find((s) => !(s.cancelled === true || s.etd === 'Cancelled'));
  if (!n?.std) return null;
  if (n.etd === 'On time') return `Next: ${n.std}, on time`;
  if (HHMM.test(n.etd ?? '')) return `Next: ${n.std}, expected ${n.etd}`;
  if (n.etd === 'Delayed') return `Next: ${n.std}, delayed`;
  return `Next: ${n.std}`;
}

function wasLate(sent, serviceId) {
  const prefix = `${serviceId}|late|`;
  return Object.keys(sent).some((key) => key.startsWith(prefix));
}

export function decide(prevState, board, now) {
  const prev = prevState ?? {};
  const prevSent = prev.sent ?? {};
  const prevLast = prev.last ?? {};

  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw new Error('now must be a valid date');
  const nowMin = londonMinutes(at);

  const services = Array.isArray(board?.services) ? board.services : [];
  const from = board?.crs ?? '?';
  const to = board?.filterCrs ?? '?';

  const nextSent = {};
  const nextLast = {};
  const messages = [];

  const ids = new Set(services.map((s) => s.id).filter(Boolean));
  for (const [key, value] of Object.entries(prevSent)) {
    if (ids.has(key.split('|')[0])) nextSent[key] = value;
  }

  const emit = (serviceId, kind, value, text) => {
    const key = `${serviceId}|${kind}|${value}`;
    if (nextSent[key]) return;
    nextSent[key] = true;
    messages.push({ serviceId, kind, value, key, text });
  };

  for (const [i, s] of services.entries()) {
    if (!s.id) continue;
    const label = `${s.std ?? '?'} ${from}\u2192${to}`;

    if (s.cancelled === true || s.etd === 'Cancelled') {
      emit(s.id, 'cancelled', 'cancelled', lines(`❌🚆 ${label} cancelled`, nextRunning(services, i), s.cancelReason));
      continue;
    }

    const stdMin = toMinutes(s.std);
    const etdMin = toMinutes(s.etd);
    const isDelayedText = s.etd === 'Delayed';
    const isLate = isDelayedText || (stdMin !== null && etdMin !== null && etdMin - stdMin >= 5);

    if (isLate) {
      const text = isDelayedText
        ? lines(`⏳🚆 ${label} delayed`, 'No estimate yet', s.delayReason)
        : lines(`🐢🚆 ${label} delayed`, `Now ${s.etd}, ${etdMin - stdMin} min late`, s.delayReason);
      emit(s.id, 'late', s.etd, text);
    } else if (s.etd === 'On time' && wasLate(prevSent, s.id)) {
      emit(s.id, 'ontime', 'ontime', lines(`✅🚆 ${label} on time again`));
    }

    // Platform reference: first sight sets it. Inside the 10-minute window a
    // difference is a change; outside it the reference stays put so an earlier
    // change is still caught when the train enters the window.
    const prevEntry = prevLast[s.id];
    const departure = etdMin ?? stdMin;
    const minsUntil = departure === null ? null : departure - nowMin;
    const withinWindow = minsUntil !== null && minsUntil >= 0 && minsUntil <= 10;

    let reference = prevEntry === undefined ? (s.platform ?? null) : (prevEntry.platform ?? null);
    if (
      prevEntry !== undefined &&
      withinWindow &&
      s.platform != null &&
      reference != null &&
      s.platform !== reference
    ) {
      emit(s.id, 'platform', s.platform, lines(`🔀🚉 ${label} platform ${s.platform}`, `Was platform ${reference}`));
      reference = s.platform;
    }
    nextLast[s.id] = { platform: reference };
  }

  return { messages, nextState: { sent: nextSent, last: nextLast } };
}
