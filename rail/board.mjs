// Published board contract + display rows for the Home Assistant card (TEC-432).
//
// The card reads the one file rail 3 publishes:
//   /srv/estate/publish/rail/board.json
// Shape:
//   { generatedAt, boards: [ { from, fromName, to, toName, generatedAt,
//     services: [ { id, std, etd, platform, cancelled, delayReason, operator } ] } ] }
//
// `formatBoard` is the display rule the HA markdown card mirrors. Keeping it
// here (and tested) stops the card and the feed drifting apart.

const HHMM = /^(\d{1,2}):(\d{2})$/;

function minutes(value) {
  const m = typeof value === 'string' ? HHMM.exec(value.trim()) : null;
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// One line of text per service, e.g. "07:27 -> 07:34 (+7) · plt 2".
export function statusText(service) {
  const { std, etd, cancelled } = service ?? {};
  if (cancelled === true || etd === 'Cancelled') return 'Cancelled';
  const stdMin = minutes(std);
  const etdMin = minutes(etd);
  if (stdMin !== null && etdMin !== null) {
    const late = etdMin - stdMin;
    return late === 0 ? `${etd} on time` : `${etd} (+${late})`;
  }
  if (typeof etd === 'string' && etd.trim() !== '') return etd;
  return std ?? '?';
}

export function formatBoard(board) {
  const boards = Array.isArray(board?.boards) ? board.boards : [];
  return boards.map((b) => ({
    from: b?.from ?? '?',
    to: b?.to ?? '?',
    title: `${b?.fromName ?? b?.from ?? '?'} \u2192 ${b?.toName ?? b?.to ?? '?'}`,
    rows: (Array.isArray(b?.services) ? b.services : []).map((s) => ({
      std: s?.std ?? '?',
      status: statusText(s),
      platform: s?.platform ?? null,
      cancelled: s?.cancelled === true || s?.etd === 'Cancelled',
    })),
  }));
}

// Errors, not a boolean, so the caller can say what is wrong.
export function validateBoard(board) {
  const errors = [];
  if (!board || typeof board !== 'object') return ['board is not an object'];
  if (typeof board.generatedAt !== 'string') errors.push('generatedAt must be a string');
  if (!Array.isArray(board.boards)) {
    errors.push('boards must be an array');
    return errors;
  }
  if (board.boards.length !== 2) errors.push('boards must hold both directions');
  board.boards.forEach((b, i) => {
    const at = `boards[${i}]`;
    if (!/^[A-Z]{3}$/.test(b?.from ?? '')) errors.push(`${at}.from must be a CRS code`);
    if (!/^[A-Z]{3}$/.test(b?.to ?? '')) errors.push(`${at}.to must be a CRS code`);
    if (typeof b?.fromName !== 'string') errors.push(`${at}.fromName must be a string`);
    if (typeof b?.toName !== 'string') errors.push(`${at}.toName must be a string`);
    if (!Array.isArray(b?.services)) {
      errors.push(`${at}.services must be an array`);
      return;
    }
    b.services.forEach((s, j) => {
      const sat = `${at}.services[${j}]`;
      if (typeof s?.id !== 'string') errors.push(`${sat}.id must be a string`);
      if (s?.std !== null && typeof s?.std !== 'string') errors.push(`${sat}.std must be a string or null`);
      if (s?.cancelled !== undefined && typeof s?.cancelled !== 'boolean') errors.push(`${sat}.cancelled must be a boolean`);
    });
  });
  return errors;
}
