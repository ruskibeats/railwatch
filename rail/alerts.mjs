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
//   - expected >= 5 min late             -> one message, then again only when
//                                           the estimate moves 5+ min further
//   - a train whose std has passed       -> no late/platform/timing alerts
//     (std + 2 min grace); a cancellation still alerts
//   - platform change within 10 min      -> one message per distinct platform
//   - "Delayed" with no time             -> treated as a delay, one message
//   - after its booked time a train is silent. Darwin keeps a departed service
//     listed and still moving its estimate, so without this every departure
//     produced "delayed" messages minutes after the train left
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

// Alert on the first 5+ min delay, then only when it gets 5 min worse:
// "Now 18:11, 5 min late", "Now 18:16, 10 min late", not every minute.
const LATE_STEP_MIN = 5;
// A train is treated as gone 2 min after its booked time (Darwin keeps showing
// it as "On time" for a while after it leaves).
const GONE_GRACE_MIN = 2;

function lateBucket(lateMin) {
  return Math.floor(lateMin / LATE_STEP_MIN) * LATE_STEP_MIN;
}

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

// The worst delay bucket already alerted for this train, or null.
function lateBucketSent(sent, serviceId) {
  const prefix = `${serviceId}|late|`;
  let worst = null;
  for (const key of Object.keys(sent)) {
    if (!key.startsWith(prefix)) continue;
    const bucket = Number(key.slice(prefix.length).replace('delayed', '0'));
    if (Number.isFinite(bucket) && (worst === null || bucket > worst)) worst = bucket;
  }
  return worst;
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

    // Once the booked time has passed, Darwin's estimate is no longer news.
    const gone = stdMin !== null && nowMin > stdMin + GONE_GRACE_MIN;

    if (isLate) {
      const lateMin = isDelayedText ? null : etdMin - stdMin;
      const bucket = lateMin === null ? null : lateBucket(lateMin);
      const worst = lateBucketSent(prevSent, s.id);
      const worth = !gone && (bucket === null ? worst === null : worst === null || bucket > worst);
      if (worth) {
        const text = isDelayedText
          ? lines(`⏳🚆 ${label} delayed`, 'No estimate yet', s.delayReason)
          : lines(`🐢🚆 ${label} delayed`, `Now ${s.etd}, ${lateMin} min late`, s.delayReason);
        emit(s.id, 'late', isDelayedText ? 'delayed' : String(bucket), text);
      }
    } else if (s.etd === 'On time' && !gone && lateBucketSent(prevSent, s.id) !== null) {
      emit(s.id, 'ontime', 'ontime', lines(`✅🚆 ${label} on time again`));
    }

    // Platform reference: first sight sets it. Inside the 10-minute window a
    // difference is a change; outside it the reference stays put so an earlier
    // change is still caught when the train enters the window.
    const prevEntry = prevLast[s.id];
    const departure = etdMin ?? stdMin;
    const minsUntil = departure === null ? null : departure - nowMin;
    const withinWindow = !gone && minsUntil !== null && minsUntil >= 0 && minsUntil <= 10;

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
